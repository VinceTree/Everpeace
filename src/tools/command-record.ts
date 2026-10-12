export interface CommandRecord {
  id: string;
  command: string;
  shell: string;
  workspace: string;
  source: "user" | "model";
  status: "completed" | "failed" | "cancelled";
  durationMs: number;
  truncated: boolean;
}

const MAX_OUTPUT_LINES = 10_000;

function newlineCount(value: string): number {
  let count = 0;
  for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1)) count += 1;
  return count;
}

/**
 * Incremental tail buffer for long-running commands. Appending is proportional
 * to the new chunk (and discarded prefix), rather than the full retained log.
 */
export class BoundedOutputBuffer {
  readonly #maxBytes: number;
  readonly #chunks: string[] = [];
  #bytes = 0;
  #newlines = 0;
  #truncated = false;

  constructor(maxBytes = 2 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
    this.#maxBytes = maxBytes;
  }

  append(value: string): void {
    if (!value) return;
    this.#chunks.push(value);
    this.#bytes += Buffer.byteLength(value);
    this.#newlines += newlineCount(value);
    this.#trimLines();
    this.#trimBytes();
  }

  result(): { text: string; truncated: boolean } {
    return { text: this.#chunks.join(""), truncated: this.#truncated };
  }

  get text(): string { return this.#chunks.join(""); }
  get truncated(): boolean { return this.#truncated; }

  #discardPrefix(characters: number): void {
    let remaining = characters;
    while (remaining > 0 && this.#chunks.length > 0) {
      const first = this.#chunks[0]!;
      if (first.length <= remaining) {
        this.#chunks.shift();
        remaining -= first.length;
        this.#bytes -= Buffer.byteLength(first);
        this.#newlines -= newlineCount(first);
      } else {
        const removed = first.slice(0, remaining);
        this.#chunks[0] = first.slice(remaining);
        this.#bytes -= Buffer.byteLength(removed);
        this.#newlines -= newlineCount(removed);
        remaining = 0;
      }
    }
    this.#truncated = true;
  }

  #trimLines(): void {
    let remove = this.#newlines - (MAX_OUTPUT_LINES - 1);
    while (remove > 0 && this.#chunks.length > 0) {
      const first = this.#chunks[0]!;
      let offset = 0;
      while (remove > 0) {
        const newline = first.indexOf("\n", offset);
        if (newline === -1) break;
        offset = newline + 1;
        remove -= 1;
      }
      if (offset > 0) this.#discardPrefix(offset);
      else {
        this.#discardPrefix(first.length);
      }
    }
  }

  #trimBytes(): void {
    while (this.#bytes > this.#maxBytes && this.#chunks.length > 0) {
      const excess = this.#bytes - this.#maxBytes;
      const first = this.#chunks[0]!;
      const bytes = Buffer.from(first);
      if (bytes.length <= excess) {
        this.#discardPrefix(first.length);
        continue;
      }
      let start = excess;
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
      const retained = bytes.subarray(start).toString("utf8");
      this.#bytes -= bytes.length;
      this.#newlines -= newlineCount(first);
      this.#chunks[0] = retained;
      this.#bytes += Buffer.byteLength(retained);
      this.#newlines += newlineCount(retained);
      this.#truncated = true;
    }
  }
}

export function isCommandRecord(value: unknown): value is CommandRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return [v.id, v.command, v.shell, v.workspace].every((s) => typeof s === "string") &&
    (v.source === "user" || v.source === "model") &&
    ["completed", "failed", "cancelled"].includes(String(v.status)) &&
    typeof v.durationMs === "number" && Number.isFinite(v.durationMs) && v.durationMs >= 0 && typeof v.truncated === "boolean";
}

export function retainOutput(text: string, maxBytes = 2 * 1024 * 1024): { text: string; truncated: boolean } {
  const buffer = new BoundedOutputBuffer(maxBytes);
  buffer.append(text);
  return buffer.result();
}
