import { randomUUID } from "node:crypto";

export const MODEL_TOOL_OUTPUT_MAX_BYTES = 32 * 1024;
const RETAINED_TOOL_OUTPUTS = 16;
const RETAINED_TOOL_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const READ_TOOL_OUTPUT_MAX_BYTES = 24 * 1024;

export const READ_TOOL_OUTPUT_DEFINITION = {
  type: "function",
  name: "read_tool_output",
  description: "Read another byte range from a truncated tool output retained for this process.",
  parameters: {
    type: "object",
    properties: {
      output_id: { type: "string", description: "Opaque output_id returned by a truncated tool result." },
      offset_bytes: { type: "integer", minimum: 0, description: "Byte offset. Use next_offset_bytes from the previous page." },
      max_bytes: { type: "integer", minimum: 1, maximum: READ_TOOL_OUTPUT_MAX_BYTES },
    },
    required: ["output_id"],
    additionalProperties: false,
  },
} as const;

interface RetainedOutput {
  bytes: Buffer;
  originalBytes: number;
}

function utf8Slice(bytes: Buffer, offset: number, maxBytes: number): { content: string; start: number; end: number } {
  let start = Math.max(0, Math.min(offset, bytes.byteLength));
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  let end = Math.min(bytes.byteLength, start + maxBytes);
  while (end < bytes.byteLength && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { content: bytes.subarray(start, end).toString("utf8"), start, end };
}

/** Process-local storage for large results. IDs are opaque and never persisted separately. */
export class ToolOutputStore {
  readonly #outputs = new Map<string, RetainedOutput>();

  bound(output: string, maxBytes = MODEL_TOOL_OUTPUT_MAX_BYTES): string {
    const encoded = Buffer.from(output, "utf8");
    if (encoded.byteLength <= maxBytes) return output;
    const outputId = randomUUID();
    const retained = encoded.subarray(0, RETAINED_TOOL_OUTPUT_MAX_BYTES);
    this.#outputs.set(outputId, { bytes: retained, originalBytes: encoded.byteLength });
    while (this.#outputs.size > RETAINED_TOOL_OUTPUTS) {
      const oldest = this.#outputs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#outputs.delete(oldest);
    }

    let previewBytes = Math.max(256, Math.floor((maxBytes - 1_024) / 2));
    while (true) {
      const head = utf8Slice(encoded, 0, previewBytes).content;
      const tail = utf8Slice(encoded, Math.max(0, encoded.byteLength - previewBytes), previewBytes).content;
      const bounded = JSON.stringify({
        status: "truncated",
        output_id: outputId,
        total_bytes: encoded.byteLength,
        retained_bytes: retained.byteLength,
        omitted_bytes: encoded.byteLength - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
        head,
        tail,
        continuation: { tool: "read_tool_output", offset_bytes: 0 },
      });
      if (Buffer.byteLength(bounded, "utf8") <= maxBytes) return bounded;
      previewBytes = Math.max(64, Math.floor(previewBytes * 0.8));
    }
  }

  read(argumentsJson: string): Record<string, unknown> {
    let parsed: { output_id?: unknown; offset_bytes?: unknown; max_bytes?: unknown };
    try {
      parsed = JSON.parse(argumentsJson) as typeof parsed;
    } catch {
      return { status: "error", error: "Invalid read_tool_output arguments" };
    }
    if (typeof parsed.output_id !== "string" || !parsed.output_id) {
      return { status: "error", error: "output_id is required" };
    }
    const entry = this.#outputs.get(parsed.output_id);
    if (!entry) return { status: "not_found", error: "The retained tool output is unavailable" };
    const offset = typeof parsed.offset_bytes === "number" && Number.isSafeInteger(parsed.offset_bytes) && parsed.offset_bytes >= 0
      ? parsed.offset_bytes
      : 0;
    const maxBytes = typeof parsed.max_bytes === "number" && Number.isSafeInteger(parsed.max_bytes) && parsed.max_bytes > 0
      ? Math.min(parsed.max_bytes, READ_TOOL_OUTPUT_MAX_BYTES)
      : READ_TOOL_OUTPUT_MAX_BYTES;
    const page = utf8Slice(entry.bytes, offset, maxBytes);
    const retainedComplete = page.end >= entry.bytes.byteLength;
    return {
      status: "ok",
      output_id: parsed.output_id,
      content: page.content,
      start_offset_bytes: page.start,
      end_offset_bytes: page.end,
      total_bytes: entry.originalBytes,
      retained_bytes: entry.bytes.byteLength,
      complete: retainedComplete && entry.bytes.byteLength === entry.originalBytes,
      ...(retainedComplete ? {} : { next_offset_bytes: page.end }),
      ...(entry.bytes.byteLength < entry.originalBytes ? { retention_truncated: true } : {}),
    };
  }

  clear(): void {
    this.#outputs.clear();
  }
}

const fallbackStore = new ToolOutputStore();

/** Compatibility helper for callers that do not own an agent-scoped store. */
export function boundModelToolOutput(output: string, maxBytes = MODEL_TOOL_OUTPUT_MAX_BYTES): string {
  return fallbackStore.bound(output, maxBytes);
}
