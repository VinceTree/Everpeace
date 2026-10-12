import { spawn } from "node:child_process";
import { runFileTool } from "../tools/files.js";
import { ToolArgumentError } from "../tools/tool-feedback.js";
import { resolveBundledRipgrep, type RipgrepPathResolver } from "../tools/ripgrep.js";

export const MAX_FILE_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 32 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 64 * 1024;
export const DEFAULT_ATTACHMENT_LINES = 200;
export const MAX_ATTACHMENT_LINES = 1_000;

export interface FileReference {
  path: string;
  startLine?: number;
  endLine?: number;
  start: number;
  end: number;
}

export interface FileAttachment {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  sha256: string;
  truncated: boolean;
}

function decodeQuotedPath(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = value[index + 1];
    if (next !== "\\" && next !== '"') {
      throw new Error("File references may only escape backslashes and double quotes");
    }
    output += next;
    index += 1;
  }
  return output;
}

function isInsideInlineCode(line: string, offset: number): boolean {
  let delimiter = 0;
  for (let index = 0; index < offset;) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (line[end] === "`") end += 1;
    const length = end - index;
    delimiter = delimiter === 0 ? length : delimiter === length ? 0 : delimiter;
    index = end;
  }
  return delimiter !== 0;
}

/** Parses only explicit @"path" references outside Markdown code. */
export function parseFileReferences(text: string): FileReference[] {
  const references: FileReference[] = [];
  const lines = text.split(/(?<=\n)/u);
  let absoluteOffset = 0;
  let fence: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (fence === undefined) fence = marker;
      else if (fence === marker) fence = undefined;
      absoluteOffset += rawLine.length;
      continue;
    }
    if (fence !== undefined) {
      absoluteOffset += rawLine.length;
      continue;
    }
    const pattern = /@"((?:\\[\\"]|[^"\\])+)"(?:#L(\d+)(?:-L?(\d+))?)?/gu;
    for (const match of line.matchAll(pattern)) {
      const localStart = match.index ?? 0;
      if (isInsideInlineCode(line, localStart)) continue;
      const startLine = match[2] === undefined ? undefined : Number(match[2]);
      const endLine = match[3] === undefined ? startLine : Number(match[3]);
      references.push({
        path: decodeQuotedPath(match[1]!),
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
        start: absoluteOffset + localStart,
        end: absoluteOffset + localStart + match[0].length,
      });
    }
    absoluteOffset += rawLine.length;
  }
  return references;
}

function validateFileReferenceSyntax(text: string, references: readonly FileReference[]): void {
  const byStart = new Map(references.map((reference) => [reference.start, reference]));
  const lines = text.split(/(?<=\n)/u);
  let absoluteOffset = 0;
  let fence: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (fence === undefined) fence = marker;
      else if (fence === marker) fence = undefined;
      absoluteOffset += rawLine.length;
      continue;
    }
    if (fence === undefined) {
      for (let index = line.indexOf('@"'); index >= 0; index = line.indexOf('@"', index + 2)) {
        if (isInsideInlineCode(line, index)) continue;
        const reference = byStart.get(absoluteOffset + index);
        if (!reference || text[reference.end] === "#") {
          throw new Error('Malformed file reference; use @"path" or @"path"#L10-L40');
        }
      }
    }
    absoluteOffset += rawLine.length;
  }
}

export function activeFileReferenceQuery(
  text: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const before = Array.from(text).slice(0, cursor).join("");
  const match = before.match(/(?:^|\s)@([^@"\s`]*)$/u);
  if (!match) return undefined;
  const prefixLength = match[0].length - match[1]!.length - 1;
  const startCodeUnits = before.length - match[0].length + prefixLength;
  return { start: Array.from(before.slice(0, startCodeUnits)).length, query: match[1]! };
}

export function quotedFileReference(path: string): string {
  return `@"${path.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

interface FileReadResult {
  path: string;
  exists: boolean;
  sha256: string | null;
  content: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  next_line: number | null;
}

export async function resolveFileAttachments(
  text: string,
  workspacePath: string,
  signal?: AbortSignal,
): Promise<FileAttachment[]> {
  const parsed = parseFileReferences(text);
  validateFileReferenceSyntax(text, parsed);
  const unique: FileReference[] = [];
  const keys = new Set<string>();
  for (const reference of parsed) {
    if (!reference.path.trim() || reference.path.includes("\0")) {
      throw new Error("A file reference contains an invalid path");
    }
    const startLine = reference.startLine ?? 1;
    const endLine = reference.endLine ?? (startLine + DEFAULT_ATTACHMENT_LINES - 1);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error(`Invalid line range for ${reference.path}`);
    }
    if (endLine - startLine + 1 > MAX_ATTACHMENT_LINES) {
      throw new Error(`File reference ${reference.path} exceeds the ${MAX_ATTACHMENT_LINES.toLocaleString("en-US")}-line limit`);
    }
    const key = `${reference.path}\0${startLine}\0${endLine}`;
    if (!keys.has(key)) {
      keys.add(key);
      unique.push(reference);
    }
  }
  if (unique.length > MAX_FILE_ATTACHMENTS) {
    throw new Error(`A message can attach at most ${MAX_FILE_ATTACHMENTS} files`);
  }

  const attachments: FileAttachment[] = [];
  let totalBytes = 0;
  for (const reference of unique) {
    signal?.throwIfAborted();
    const startLine = reference.startLine ?? 1;
    const requestedEnd = reference.endLine ?? (startLine + DEFAULT_ATTACHMENT_LINES - 1);
    let result: FileReadResult;
    try {
      result = await runFileTool("read_file", JSON.stringify({
        path: reference.path,
        start_line: startLine,
        max_lines: requestedEnd - startLine + 1,
      }), workspacePath, signal) as FileReadResult;
    } catch (error) {
      if (error instanceof ToolArgumentError && error.field === "start_line") {
        throw new Error(`Referenced range starts after the end of ${reference.path}`, { cause: error });
      }
      throw error;
    }
    if (!result.exists || result.sha256 === null) {
      throw new Error(`Referenced file does not exist: ${reference.path}`);
    }
    if (startLine > result.total_lines || result.end_line < startLine) {
      throw new Error(`Referenced range starts after the end of ${reference.path} (${result.total_lines} lines)`);
    }
    const bytes = Buffer.byteLength(result.content, "utf8");
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Referenced excerpt from ${reference.path} exceeds ${MAX_ATTACHMENT_BYTES / 1024} KiB; use a smaller line range`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`File attachments exceed the ${MAX_TOTAL_ATTACHMENT_BYTES / 1024} KiB total limit`);
    }
    attachments.push({
      path: result.path,
      startLine: result.start_line,
      endLine: result.end_line,
      totalLines: result.total_lines,
      content: result.content,
      sha256: result.sha256,
      truncated: result.start_line > 1 || result.end_line < result.total_lines,
    });
  }
  return attachments;
}

export function attachmentInputText(attachment: FileAttachment): string {
  const metadata = JSON.stringify({
    path: attachment.path,
    start_line: attachment.startLine,
    end_line: attachment.endLine,
    total_lines: attachment.totalLines,
    sha256: attachment.sha256,
    truncated: attachment.truncated,
  });
  return `<host_file_attachment ${metadata}>\n${attachment.content}\n</host_file_attachment>`;
}

export function userMessageWithAttachments(
  text: string,
  attachments: readonly FileAttachment[] = [],
): Record<string, unknown> {
  if (attachments.length === 0) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      { type: "input_text", text },
      ...attachments.map((attachment) => ({ type: "input_text", text: attachmentInputText(attachment) })),
    ],
  };
}

/** Bounded, cancellable workspace-file discovery for composer completion. */
export async function listFileReferenceSuggestions(
  workspacePath: string,
  query: string,
  signal?: AbortSignal,
  resolveRipgrep: RipgrepPathResolver = resolveBundledRipgrep,
): Promise<string[]> {
  signal?.throwIfAborted();
  const executable = await resolveRipgrep();
  signal?.throwIfAborted();
  const child = spawn(executable, ["--no-config", "--files", "--hidden", "--glob", "!.git", "--", "."], {
    cwd: workspacePath,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let stopped = false;
  const timer = setTimeout(() => {
    stopped = true;
    child.kill();
  }, 2_000);
  child.stdout.on("data", (chunk: Buffer) => {
    if (stopped) return;
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      stopped = true;
      child.kill();
      return;
    }
    chunks.push(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (signal?.aborted) reject(signal.reason ?? new Error("File completion cancelled"));
        else if (code === 0 || code === 1 || stopped) resolve();
        else reject(new Error(`File discovery failed with exit code ${code ?? "unknown"}`));
      });
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  const normalized = query.toLocaleLowerCase();
  const files = Buffer.concat(chunks).toString("utf8").split(/\r?\n/u)
    .map((value) => value.replace(/^\.\//u, "").replace(/\\/gu, "/"))
    .filter(Boolean)
    .filter((value) => value.toLocaleLowerCase().includes(normalized));
  files.sort((left, right) => {
    const leftStarts = left.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
    const rightStarts = right.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
    return leftStarts - rightStarts || left.length - right.length || left.localeCompare(right);
  });
  return files.slice(0, 200);
}
