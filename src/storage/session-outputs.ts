import { constants, createReadStream, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { RETAINED_TOOL_OUTPUTS, RETAINED_TOOL_OUTPUT_MAX_BYTES, READ_TOOL_OUTPUT_MAX_BYTES, type PreparedOutputAttachment, type ReadToolOutputArguments, type StoredToolOutputRange } from "../agent/context-limits.js";
import type { PerformanceTrace } from "../performance/trace.js";

export type { StoredToolOutputRange } from "../agent/context-limits.js";

const MAX_HEADER_BYTES = 4096;
const MAX_REFERENCE_LINE_BYTES = 8 * 1024 * 1024;

export interface ToolOutputAttachmentReference {
  output_id: string;
  tool_name: string;
  total_bytes: number;
  original_bytes: number;
  retained_bytes: number;
}

export interface StoredToolOutput extends PreparedOutputAttachment {}

export function isToolOutputAttachmentReference(value: unknown): value is ToolOutputAttachmentReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.output_id === "string" && /^[A-Za-z0-9_-]+$/u.test(record.output_id)
    && typeof record.tool_name === "string" && record.tool_name.length > 0
    && typeof record.total_bytes === "number" && Number.isSafeInteger(record.total_bytes) && record.total_bytes >= 0
    && typeof record.original_bytes === "number" && Number.isSafeInteger(record.original_bytes) && record.original_bytes >= 0
    && typeof record.retained_bytes === "number" && Number.isSafeInteger(record.retained_bytes)
    && record.retained_bytes >= 0 && record.retained_bytes <= RETAINED_TOOL_OUTPUT_MAX_BYTES
    && record.retained_bytes <= record.total_bytes;
}

export function toolOutputAttachmentReference(attachment: PreparedOutputAttachment): ToolOutputAttachmentReference {
  const reference = {
    output_id: attachment.output_id,
    tool_name: attachment.tool_name,
    total_bytes: attachment.total_bytes,
    original_bytes: attachment.original_bytes,
    retained_bytes: attachment.bytes.byteLength,
  };
  if (!Buffer.isBuffer(attachment.bytes) || !isToolOutputAttachmentReference(reference)) throw new Error("Invalid tool output attachment");
  return reference;
}

/** Retention order comes from append events, including events preceding compaction. */
export async function readToolOutputReferences(filePath: string, sessionId: string, finalRecordValidator?: (value: unknown) => boolean, trace?: PerformanceTrace): Promise<{ references: ToolOutputAttachmentReference[]; safeToClean: boolean }> {
  const references = new Map<string, ToolOutputAttachmentReference>();
  let pending = Buffer.alloc(0);
  let oversized = false;
  let safeToClean = true;
  let headerSeen = false;
  const processLine = (bytes: Buffer) => {
    if (!bytes.toString("utf8").trim()) return;
    try {
      const event = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (!headerSeen) {
        if (event.type !== "session_created" || event.session_id !== sessionId || event.version !== 1) {
          safeToClean = false;
          return;
        }
        headerSeen = true;
      }
      if (event.type === "context_append" && event.tool_output_attachment !== undefined) {
        if (!isToolOutputAttachmentReference(event.tool_output_attachment)) {
          safeToClean = false;
          return;
        }
        const reference = event.tool_output_attachment;
        // A duplicate reference must not change its original retention position.
        if (!references.has(reference.output_id)) references.set(reference.output_id, reference);
        while (references.size > RETAINED_TOOL_OUTPUTS) references.delete(references.keys().next().value!);
      }
    } catch {
      safeToClean = false;
    }
  };
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const value of stream) {
      const chunk = value as Buffer;
      trace?.increment("output_reference_scan_bytes", chunk.byteLength);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.byteLength : newline;
        const part = chunk.subarray(offset, end);
        if (!oversized) {
          if (pending.byteLength + part.byteLength > MAX_REFERENCE_LINE_BYTES) {
            oversized = true;
            safeToClean = false;
            pending = Buffer.alloc(0);
          } else if (part.byteLength) pending = Buffer.concat([pending, part]);
        }
        if (newline < 0) break;
        if (!oversized) processLine(pending);
        pending = Buffer.alloc(0);
        oversized = false;
        offset = newline + 1;
      }
    }
    // Legacy files can lose only the newline after an otherwise valid final record.
    if (!oversized && pending.byteLength) {
      try {
        const value: unknown = JSON.parse(pending.toString("utf8"));
        const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
        const valid = finalRecordValidator ? finalRecordValidator(value) : record?.version === 1 && typeof record.type === "string" && typeof record.at === "string";
        if (valid) processLine(pending);
      } catch { /* Invalid unfinished tail has no committed attachment reference. */ }
    }
  } finally {
    stream.destroy();
  }
  return { references: [...references.values()], safeToClean: safeToClean && headerSeen };
}

function assertId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid output or session ID");
}

/** Immutable bounded binary attachments; callers serialize commits with their session log. */
export class SessionOutputStorage {
  readonly #root: string;
  readonly #trace: PerformanceTrace | undefined;

  constructor(sessionDirectory: string, trace?: PerformanceTrace) {
    this.#root = path.join(sessionDirectory, "outputs");
    this.#trace = trace;
  }

  async sessions(): Promise<string[]> {
    if (!await this.#directory(this.#root, false)) return [];
    const entries = await fs.readdir(this.#root, { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error("Tool output storage cannot contain symbolic links");
    return entries.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/u.test(entry.name)).map((entry) => entry.name);
  }

  async write(sessionId: string, attachment: PreparedOutputAttachment): Promise<void> {
    assertId(sessionId);
    const reference = toolOutputAttachmentReference(attachment);
    const header = Buffer.from(`${JSON.stringify({ version: 1, ...reference })}\n`, "utf8");
    if (header.byteLength > MAX_HEADER_BYTES) throw new Error("Tool output metadata is too large");
    await this.#directory(this.#root, true);
    const directory = this.#sessionDirectory(sessionId);
    await this.#directory(directory, true);
    const filePath = this.#filePath(sessionId, reference.output_id);
    const handle = await fs.open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.concat([header, attachment.bytes]));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.rm(filePath, { force: true });
      throw error;
    }
    await handle.close();
  }

  /** Copy validated retained outputs into a hidden fork staging directory. */
  async stageFork(
    sourceSessionId: string,
    stagingDirectory: string,
    references: readonly ToolOutputAttachmentReference[],
    signal?: AbortSignal,
  ): Promise<void> {
    assertId(sourceSessionId);
    await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    const stat = await fs.lstat(stagingDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Fork output staging is not a regular directory");
    for (const reference of references) {
      signal?.throwIfAborted();
      const stored = await this.read(sourceSessionId, reference, signal);
      if (!stored) throw new Error(`Retained tool output is unavailable during fork: ${reference.output_id}`);
      const header = Buffer.from(`${JSON.stringify({ version: 1, ...reference })}\n`, "utf8");
      if (header.byteLength > MAX_HEADER_BYTES) throw new Error("Tool output metadata is too large");
      const target = path.join(stagingDirectory, `${reference.output_id}.output`);
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(Buffer.concat([header, stored.bytes]));
        await handle.sync();
      } catch (error) {
        await handle.close();
        await fs.rm(target, { force: true });
        throw error;
      }
      await handle.close();
    }
  }

  /** Publish prepared fork attachments before the child log becomes visible. */
  async publishFork(sessionId: string, stagingDirectory: string): Promise<void> {
    assertId(sessionId);
    await this.#directory(this.#root, true);
    await fs.rename(stagingDirectory, this.#sessionDirectory(sessionId));
  }

  async read(sessionId: string, reference: ToolOutputAttachmentReference, signal?: AbortSignal): Promise<StoredToolOutput | null> {
    signal?.throwIfAborted();
    assertId(sessionId);
    assertId(reference.output_id);
    if (!await this.#directory(this.#root, false) || !await this.#directory(this.#sessionDirectory(sessionId), false)) return null;
    const filePath = this.#filePath(sessionId, reference.output_id);
    let handle: FileHandle | undefined;
    try {
      const before = await fs.lstat(filePath);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("Tool output attachment is not a regular file");
      handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Tool output attachment changed while opening");
      if (stat.size > RETAINED_TOOL_OUTPUT_MAX_BYTES + MAX_HEADER_BYTES) return null;
      const bytes = await handle.readFile(signal === undefined ? undefined : { signal });
      this.#trace?.increment("attachment_read_bytes", bytes.byteLength);
      signal?.throwIfAborted();
      const newline = bytes.indexOf(10);
      if (newline < 0 || newline >= MAX_HEADER_BYTES) return null;
      const metadata = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      if (metadata.version !== 1 || !isToolOutputAttachmentReference(metadata)) return null;
      for (const key of ["output_id", "tool_name", "total_bytes", "original_bytes", "retained_bytes"] as const) {
        if (metadata[key] !== reference[key]) return null;
      }
      const content = bytes.subarray(newline + 1);
      if (content.byteLength !== reference.retained_bytes) return null;
      return {
        output_id: reference.output_id,
        tool_name: reference.tool_name,
        total_bytes: reference.total_bytes,
        original_bytes: reference.original_bytes,
        bytes: content,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /** Read v1 header plus one UTF-8 page; the existing format requires no migration. */
  async readRange(sessionId: string, reference: ToolOutputAttachmentReference, arguments_: ReadToolOutputArguments, signal?: AbortSignal): Promise<StoredToolOutputRange | null> {
    signal?.throwIfAborted();
    assertId(sessionId);
    assertId(reference.output_id);
    if (!Number.isSafeInteger(arguments_.offset_bytes) || arguments_.offset_bytes < 0
      || !Number.isSafeInteger(arguments_.max_bytes) || arguments_.max_bytes < 1 || arguments_.max_bytes > READ_TOOL_OUTPUT_MAX_BYTES) {
      throw new RangeError("Invalid retained output byte range");
    }
    if (!await this.#directory(this.#root, false) || !await this.#directory(this.#sessionDirectory(sessionId), false)) return null;
    const filePath = this.#filePath(sessionId, reference.output_id);
    let handle: FileHandle | undefined;
    try {
      const before = await fs.lstat(filePath);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("Tool output attachment is not a regular file");
      handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Tool output attachment changed while opening");
      if (stat.size > RETAINED_TOOL_OUTPUT_MAX_BYTES + MAX_HEADER_BYTES) return null;
      let readBytes = 0;
      const readAt = async (length: number, position: number): Promise<Buffer> => {
        const bytes = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
          signal?.throwIfAborted();
          const result = await handle!.read(bytes, offset, length - offset, position + offset);
          readBytes += result.bytesRead;
          this.#trace?.increment("attachment_read_bytes", result.bytesRead);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        signal?.throwIfAborted();
        return bytes.subarray(0, offset);
      };
      const header = await readAt(Math.min(MAX_HEADER_BYTES, stat.size), 0);
      const newline = header.indexOf(10);
      if (newline < 0 || newline >= MAX_HEADER_BYTES) return null;
      const metadata: unknown = JSON.parse(header.subarray(0, newline).toString("utf8"));
      if (!metadata || typeof metadata !== "object" || (metadata as Record<string, unknown>).version !== 1 || !isToolOutputAttachmentReference(metadata)) return null;
      for (const key of ["output_id", "tool_name", "total_bytes", "original_bytes", "retained_bytes"] as const) {
        if (metadata[key] !== reference[key]) return null;
      }
      if (stat.size !== newline + 1 + reference.retained_bytes) return null;
      const start = Math.min(arguments_.offset_bytes, reference.retained_bytes);
      const count = Math.min(reference.retained_bytes - start, arguments_.max_bytes + 4);
      const content = await readAt(count, newline + 1 + start);
      if (content.byteLength !== count) return null;
      const after = await handle.stat();
      const current = await fs.lstat(filePath);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino
        || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
        || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) return null;
      signal?.throwIfAborted();
      return {
        output_id: reference.output_id, tool_name: reference.tool_name,
        total_bytes: reference.total_bytes, original_bytes: reference.original_bytes,
        retained_bytes: reference.retained_bytes, range_start_bytes: start, bytes: content,
        read_bytes: readBytes,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    } finally { await handle?.close(); }
  }

  async cleanup(sessionId: string, retainedIds: readonly string[]): Promise<void> {
    assertId(sessionId);
    if (!await this.#directory(this.#root, false) || !await this.#directory(this.#sessionDirectory(sessionId), false)) return;
    const retained = new Set(retainedIds);
    const entries = await fs.readdir(this.#sessionDirectory(sessionId), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("Tool output storage cannot contain symbolic links");
      if (!entry.isFile() || !entry.name.endsWith(".output")) continue;
      const outputId = entry.name.slice(0, -".output".length);
      if (!/^[A-Za-z0-9_-]+$/u.test(outputId)) continue;
      if (!retained.has(outputId)) await fs.rm(this.#filePath(sessionId, outputId), { force: true });
    }
  }

  async remove(sessionId: string, outputId: string): Promise<void> {
    assertId(sessionId);
    assertId(outputId);
    if (!await this.#directory(this.#root, false) || !await this.#directory(this.#sessionDirectory(sessionId), false)) return;
    await fs.rm(this.#filePath(sessionId, outputId), { force: true });
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertId(sessionId);
    if (!await this.#directory(this.#root, false) || !await this.#directory(this.#sessionDirectory(sessionId), false)) return;
    const entries = await fs.readdir(this.#sessionDirectory(sessionId), { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) throw new Error("Tool output storage contains an unsafe entry");
    await fs.rm(this.#sessionDirectory(sessionId), { recursive: true, force: true });
  }

  #sessionDirectory(sessionId: string): string {
    return path.join(this.#root, sessionId);
  }

  #filePath(sessionId: string, outputId: string): string {
    return path.join(this.#sessionDirectory(sessionId), `${outputId}.output`);
  }

  async #directory(directory: string, create: boolean): Promise<boolean> {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Tool output storage directory is not a regular directory");
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
