import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BenchmarkArtifactSink } from "./types.js";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function safeName(name: string): string {
  const normalized = name.trim();
  if (!SAFE_NAME.test(normalized)) throw new Error(`Invalid benchmark artifact name: ${name}`);
  return normalized;
}

/** Redact common credential forms before diagnostic text is persisted. */
export function redactBenchmarkText(text: string): string {
  return text
    .replace(/((?:api[_-]?key|authorization|bearer|password|token)\s*[:=]\s*)([^\s,;]+)/giu, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]");
}

export function createFileBenchmarkArtifactSink(directory: string): BenchmarkArtifactSink {
  const root = resolve(directory);
  return {
    async write(name, content) {
      const filePath = resolve(root, safeName(name));
      await mkdir(root, { recursive: true });
      await writeFile(filePath, redactBenchmarkText(content), "utf8");
      return filePath;
    },
  };
}
