const PREVIEW_LINE_LIMIT = 5;
const PREVIEW_MAX_BYTES = 1024 * 1024;
const PREVIEW_MAX_LINE_BYTES = Math.floor(
  PREVIEW_MAX_BYTES / (2 * PREVIEW_LINE_LIMIT + 2),
);
const PREVIEW_LINE_HEAD_BYTES = Math.floor(PREVIEW_MAX_LINE_BYTES / 2);
const PREVIEW_LINE_TAIL_BYTES =
  PREVIEW_MAX_LINE_BYTES - PREVIEW_LINE_HEAD_BYTES;

export interface BashOutputPreview {
  headLines: string[];
  tailLines: string[];
  omittedLines: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function takeUtf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function takeUtf8Suffix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

class BoundedPreviewLine {
  #head = "";
  #tail = "";
  #omittedBytes = 0;

  push(chunk: string): void {
    const headRemaining =
      this.#tail.length === 0 && this.#omittedBytes === 0
        ? Math.max(0, PREVIEW_LINE_HEAD_BYTES - byteLength(this.#head))
        : 0;
    const prefix = takeUtf8Prefix(chunk, headRemaining);
    this.#head += prefix;
    const remainder = chunk.slice(prefix.length);
    if (remainder.length === 0) return;

    const combinedTail = this.#tail + remainder;
    const retainedTail = takeUtf8Suffix(
      combinedTail,
      PREVIEW_LINE_TAIL_BYTES,
    );
    this.#omittedBytes += byteLength(combinedTail) - byteLength(retainedTail);
    this.#tail = retainedTail;
  }

  render(): string {
    if (this.#omittedBytes === 0) return this.#head + this.#tail;

    let terminator = "";
    const escapeStart = this.#head.lastIndexOf("\u001b");
    if (escapeStart >= 0) {
      const escape = this.#head.slice(escapeStart + 1);
      if (escape.startsWith("]") && !escape.includes("\u0007")) {
        terminator = "\u0007";
      } else if (
        escape.startsWith("[") &&
        !/[A-Za-z]/u.test(escape.slice(1))
      ) {
        terminator = "m";
      }
    }

    return `${this.#head}${terminator}\u001b[0m... ${this.#omittedBytes} bytes omitted ...${this.#tail}`;
  }
}

/**
 * Incrementally retains the true first and last command-output lines for the
 * live TUI without changing the separately retained BashResult.
 */
export class BashOutputPreviewBuffer {
  #headLines: string[] = [];
  #tailLines: string[] = [];
  #currentLine = new BoundedPreviewLine();
  #completedLines = 0;
  #hasPartialLine = false;
  #pendingCarriageReturn = false;

  push(chunk: string): void {
    for (const partWithTerminator of chunk.split(/(?<=\n)/u)) {
      if (partWithTerminator.length === 0) continue;
      const hasNewline = partWithTerminator.endsWith("\n");
      let part = hasNewline
        ? partWithTerminator.slice(0, -1)
        : partWithTerminator;

      if (!hasNewline) {
        if (this.#pendingCarriageReturn) {
          this.#currentLine.push("\r");
          this.#pendingCarriageReturn = false;
        }
        if (part.endsWith("\r")) {
          part = part.slice(0, -1);
          this.#pendingCarriageReturn = true;
        }
        this.#currentLine.push(part);
        this.#hasPartialLine ||= part.length > 0 || this.#pendingCarriageReturn;
        continue;
      }

      const hasCarriageReturn = part.endsWith("\r");
      if (hasCarriageReturn) part = part.slice(0, -1);
      if (
        this.#pendingCarriageReturn &&
        (hasCarriageReturn || part.length > 0)
      ) {
        this.#currentLine.push("\r");
      }
      this.#pendingCarriageReturn = false;
      this.#currentLine.push(part);
      this.#completeCurrentLine();
    }
  }

  snapshot(): BashOutputPreview {
    const headLines = [...this.#headLines];
    const tailLines = [...this.#tailLines];
    let totalLines = this.#completedLines;

    if (this.#hasPartialLine) {
      let partialLine = this.#currentLine.render();
      if (this.#pendingCarriageReturn) partialLine += "\r";
      totalLines += 1;
      if (headLines.length < PREVIEW_LINE_LIMIT) {
        headLines.push(partialLine);
      } else {
        if (tailLines.length === PREVIEW_LINE_LIMIT) tailLines.shift();
        tailLines.push(partialLine);
      }
    }

    return {
      headLines,
      tailLines,
      omittedLines: Math.max(
        0,
        totalLines - headLines.length - tailLines.length,
      ),
    };
  }

  #completeCurrentLine(): void {
    const line = this.#currentLine.render();
    this.#currentLine = new BoundedPreviewLine();
    this.#completedLines += 1;
    this.#hasPartialLine = false;

    if (this.#headLines.length < PREVIEW_LINE_LIMIT) {
      this.#headLines.push(line);
      return;
    }
    if (this.#tailLines.length === PREVIEW_LINE_LIMIT) {
      this.#tailLines.shift();
    }
    this.#tailLines.push(line);
  }
}
