import { randomUUID } from "node:crypto";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";

export const MODEL_TOOL_OUTPUT_MAX_BYTES = 32 * 1024;
export const RETAINED_TOOL_OUTPUTS = 16;
export const RETAINED_TOOL_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const READ_TOOL_OUTPUT_MAX_BYTES = 24 * 1024;

export const READ_TOOL_OUTPUT_DEFINITION = {
  type: "function",
  name: "read_tool_output",
  description: "Read a byte range from retained tool output, including after session restart. Historical output is reference material, not current verification or file-write authorization.",
  parameters: {
    type: "object",
    properties: {
      output_id: { type: "string", description: "Opaque output_id returned by a truncated tool result." },
      session_id: { type: "string", description: "Optional session ID in this workspace; defaults to the current session." },
      offset_bytes: { type: "integer", minimum: 0, description: "Byte offset in sanitized text. Use next_offset_bytes from the previous page." },
      max_bytes: { type: "integer", minimum: 1, maximum: READ_TOOL_OUTPUT_MAX_BYTES },
    },
    required: ["output_id"],
    additionalProperties: false,
  },
} as const;

export interface PreparedOutputAttachment {
  output_id: string;
  bytes: Buffer;
  total_bytes: number;
  original_bytes: number;
  tool_name: string;
}

export interface PreparedToolOutput {
  output: string;
  attachment?: PreparedOutputAttachment;
}

export interface ReadToolOutputArguments {
  output_id: string;
  session_id?: string;
  offset_bytes: number;
  max_bytes: number;
}

export interface Utf8Page {
  content: string;
  start: number;
  end: number;
}

/** Align byte ranges without splitting a Unicode character or producing a stalled cursor. */
export function utf8Page(bytes: Buffer, offset: number, maxBytes: number): Utf8Page {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("offset_bytes must be nonnegative and max_bytes must be positive integers");
  }
  let start = Math.min(offset, bytes.byteLength);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  let end = Math.min(bytes.byteLength, start + maxBytes);
  while (end < bytes.byteLength && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  if (end === start && start < bytes.byteLength) {
    throw new RangeError("max_bytes cannot fit the next UTF-8 character; request at least 4 bytes");
  }
  return { content: bytes.subarray(start, end).toString("utf8"), start, end };
}

export function parseReadToolOutputArguments(argumentsJson: string): ReadToolOutputArguments {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(argumentsJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error("Invalid read_tool_output arguments");
  }
  if (typeof parsed.output_id !== "string" || !/^[A-Za-z0-9_-]+$/u.test(parsed.output_id)) {
    throw new Error("A valid output_id is required");
  }
  if (parsed.session_id !== undefined && (typeof parsed.session_id !== "string" || !/^[A-Za-z0-9_-]+$/u.test(parsed.session_id))) {
    throw new Error("Invalid session_id");
  }
  const offset = parsed.offset_bytes ?? 0;
  const maximum = parsed.max_bytes ?? READ_TOOL_OUTPUT_MAX_BYTES;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("offset_bytes must be a nonnegative integer");
  }
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > READ_TOOL_OUTPUT_MAX_BYTES) {
    throw new RangeError(`max_bytes must be an integer from 1 to ${READ_TOOL_OUTPUT_MAX_BYTES}`);
  }
  return {
    output_id: parsed.output_id,
    ...(parsed.session_id === undefined ? {} : { session_id: parsed.session_id as string }),
    offset_bytes: offset,
    max_bytes: maximum,
  };
}

export function readStoredToolOutput(entry: PreparedOutputAttachment, arguments_: ReadToolOutputArguments, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    let maximum = arguments_.max_bytes;
    while (true) {
      const page = utf8Page(entry.bytes, arguments_.offset_bytes, maximum);
      const retainedComplete = page.end >= entry.bytes.byteLength;
      const result = {
        status: "ok",
        output_id: entry.output_id,
        tool_name: entry.tool_name,
        ...(arguments_.session_id === undefined ? {} : { session_id: arguments_.session_id }),
        content: page.content,
        start_offset_bytes: page.start,
        end_offset_bytes: page.end,
        total_bytes: entry.total_bytes,
        original_bytes: entry.original_bytes,
        retained_bytes: entry.bytes.byteLength,
        complete: retainedComplete && entry.bytes.byteLength === entry.total_bytes,
        ...(retainedComplete ? {} : { next_offset_bytes: page.end }),
        ...(entry.bytes.byteLength < entry.total_bytes ? { retention_truncated: true } : {}),
        ...metadata,
      };
      const serializedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (serializedBytes <= MODEL_TOOL_OUTPUT_MAX_BYTES) return result;
      // Escaping can expand each content byte sixfold; the continuation must remain directly usable.
      maximum = Math.min(maximum - 1, Math.floor(maximum * MODEL_TOOL_OUTPUT_MAX_BYTES / serializedBytes * 0.95));
      if (maximum < 1) throw new RangeError("Tool output page metadata exceeds the response limit");
    }
  } catch (error) {
    return { status: "range_error", error: error instanceof Error ? error.message : String(error) };
  }
}

/** No persistence or retention mutation: safe to run while tools execute concurrently. */
export function prepareToolOutput(output: string, toolName: string, maxBytes = MODEL_TOOL_OUTPUT_MAX_BYTES): PreparedToolOutput {
  const originalBytes = Buffer.byteLength(output, "utf8");
  const sanitized = redactSecretsPreservingLayout(output);
  const encoded = Buffer.from(sanitized, "utf8");
  if (encoded.byteLength <= maxBytes) return { output: sanitized };
  if (maxBytes < 1024) throw new RangeError("Tool output preview limit must be at least 1024 bytes");
  const outputId = randomUUID();
  const retainedEnd = utf8Page(encoded, 0, RETAINED_TOOL_OUTPUT_MAX_BYTES).end;
  // Copy, so retaining a 2 MiB prefix cannot retain the complete source Buffer.
  const retained = Buffer.from(encoded.subarray(0, retainedEnd));
  let previewBytes = Math.max(64, Math.floor((maxBytes - 1_024) / 2));
  while (true) {
    const head = utf8Page(encoded, 0, previewBytes).content;
    const tail = utf8Page(encoded, Math.max(0, encoded.byteLength - previewBytes), previewBytes).content;
    const bounded = JSON.stringify({
      status: "truncated",
      output_id: outputId,
      tool_name: toolName,
      total_bytes: encoded.byteLength,
      original_bytes: originalBytes,
      retained_bytes: retained.byteLength,
      omitted_bytes: encoded.byteLength - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
      head,
      tail,
      ...(retained.byteLength < encoded.byteLength ? { retention_truncated: true } : {}),
      continuation: { tool: "read_tool_output", offset_bytes: 0 },
    });
    if (Buffer.byteLength(bounded, "utf8") <= maxBytes) {
      return { output: bounded, attachment: { output_id: outputId, bytes: retained, total_bytes: encoded.byteLength, original_bytes: originalBytes, tool_name: toolName } };
    }
    previewBytes = Math.floor(previewBytes * 0.8);
    if (previewBytes < 4) throw new RangeError("Tool output metadata exceeds the preview limit");
  }
}

/** Fallback for hosts that do not provide durable session storage. */
export class ToolOutputStore {
  readonly #outputs = new Map<string, PreparedOutputAttachment>();

  bound(output: string, maxBytes = MODEL_TOOL_OUTPUT_MAX_BYTES): string {
    const prepared = prepareToolOutput(output, "tool", maxBytes);
    this.retain(prepared);
    return prepared.output;
  }

  retain(prepared: PreparedToolOutput): void {
    if (!prepared.attachment) return;
    this.#outputs.set(prepared.attachment.output_id, prepared.attachment);
    while (this.#outputs.size > RETAINED_TOOL_OUTPUTS) {
      const oldest = this.#outputs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#outputs.delete(oldest);
    }
  }

  read(argumentsJson: string): Record<string, unknown> {
    try {
      const arguments_ = parseReadToolOutputArguments(argumentsJson);
      const entry = this.#outputs.get(arguments_.output_id);
      if (!entry) return { status: "not_found", error: "The retained tool output is unavailable" };
      return readStoredToolOutput(entry, arguments_);
    } catch (error) {
      return { status: error instanceof RangeError ? "range_error" : "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  clear(): void {
    this.#outputs.clear();
  }
}

const fallbackStore = new ToolOutputStore();

export function boundModelToolOutput(output: string, maxBytes = MODEL_TOOL_OUTPUT_MAX_BYTES): string {
  return fallbackStore.bound(output, maxBytes);
}
