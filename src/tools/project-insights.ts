import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { safeReadFile } from "./safe-files.js";
import path from "node:path";
import { createHash } from "node:crypto";

interface Insight { sha256: string; imports: string[]; }
const cache = new Map<string, Insight>();
/** Parsed metadata cache is bound to current bytes, never to write observations. */
export async function projectInsights(root: string, files: string[], signal?: AbortSignal) {
  const selected = files.filter((name) => /\.[cm]?[jt]sx?$/u.test(name)).slice(0, 64);
  let total = 0;
  const modules: Array<{ path: string; sha256: string; imports: string[] }> = [];
  let incomplete = files.filter((name) => /\.[cm]?[jt]sx?$/u.test(name)).length > selected.length;
  for (const name of selected) {
    signal?.throwIfAborted();
    const target = path.resolve(root, name);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const opened = await safeReadFile(root, name, signal);
      if (!opened.exists || opened.bytes.length > 64 * 1024 || total + opened.bytes.length > 256 * 1024) { incomplete = true; continue; }
      const bytes = opened.bytes; total += bytes.length;
      const digest = createHash("sha256").update(bytes).digest("hex");
      const key = `${root}\0${name}`;
      let value = cache.get(key);
      if (value?.sha256 !== digest) {
        const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
        const imports = [...text.matchAll(/(?:\b(?:import|export)\s[^;\n]*?\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/gu)].map((match) => match[1]!).slice(0, 32);
        value = { sha256: digest, imports }; cache.set(key, value);
      }
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
      modules.push({ path: name, sha256: value.sha256, imports: [...value.imports] });
    } catch (error) { if (error instanceof ResourceCleanupError) throw error; signal?.throwIfAborted(); incomplete = true; }
  }
  const tests = files.filter((name) => /(?:^|\/)(?:test|tests|__tests__)\//u.test(name) || /\.(?:test|spec)\./u.test(name));
  const relationships = modules.filter((module) => !tests.includes(module.path)).flatMap((module) => {
    const stem = path.basename(module.path).replace(/\.[^.]+$/u, "");
    return tests.filter((test) => path.basename(test).startsWith(`${stem}.`) || modules.find((candidate) => candidate.path === test)?.imports.some((imported) => imported.startsWith(".") && path.basename(imported).replace(/\.[^.]+$/u, "") === stem)).slice(0, 4).map((test) => ({ source: module.path, test, basis: "filename-or-relative-import candidate" }));
  }).slice(0, 32);
  return { modules, relationships, incomplete, basis: "Bounded source import scan and path conventions; candidates require inspection. Cached metadata is revalidated against raw-byte SHA-256." };
}
