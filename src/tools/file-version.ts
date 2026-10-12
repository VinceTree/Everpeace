import { createHash } from "node:crypto";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface TextFileVersion {
  bytes: Buffer;
  text: string;
  sha256: string;
  hasBom: boolean;
  lineEnding: "\n" | "\r\n";
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeTextFile(bytes: Uint8Array): TextFileVersion {
  const buffer = Buffer.from(bytes);
  const hasBom = buffer.length >= UTF8_BOM.length && buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const textBytes = hasBom ? buffer.subarray(UTF8_BOM.length) : buffer;
  if (textBytes.includes(0)) throw new Error("Binary files are not supported");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(textBytes);
  return {
    bytes: buffer,
    text,
    sha256: sha256Bytes(buffer),
    hasBom,
    lineEnding: /\r\n/u.test(text) ? "\r\n" : "\n",
  };
}

export function encodeTextFile(text: string, source?: Pick<TextFileVersion, "hasBom" | "lineEnding">): Buffer {
  const normalized = source?.lineEnding === "\r\n"
    ? text.replace(/\r?\n/gu, "\r\n")
    : text.replace(/\r\n/gu, "\n");
  const content = Buffer.from(normalized, "utf8");
  return source?.hasBom ? Buffer.concat([UTF8_BOM, content]) : content;
}
