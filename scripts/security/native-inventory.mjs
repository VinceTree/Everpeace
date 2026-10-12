import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { digest } from "../release/policy.mjs";
/** Inventory actual installed native bytes; it cannot identify every statically linked library. */
export async function nativeInventory(directory) {
  const root = await fs.realpath(directory), seen = new Set(), files = [];
  async function visit(target) {
    const location = await fs.realpath(target);
    const relative = path.relative(root, location);
    assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Installed dependency resolves outside the isolated consumer");
    if (seen.has(location)) return; seen.add(location);
    const stat = await fs.stat(location);
    if (stat.isDirectory()) for (const entry of await fs.readdir(location)) await visit(path.join(location, entry));
    else if (stat.isFile() && (/\.(?:node|exe|dll|so|dylib)$/iu.test(location) || ["codex", "rg", "spawn-helper"].includes(path.basename(location)))) files.push({ path: relative.replaceAll("\\", "/"), sha256: digest(location) });
  }
  // Restrict to the installed dependency tree, avoiding npm cache/config and generated evidence.
  for (const name of ["node_modules", "prefix"]) {
    const target = path.join(root, name);
    try { await visit(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  assert.ok(files.some((entry) => entry.path.includes("node-pty") && entry.path.endsWith(".node")), "Installed PTY binary missing");
  assert.ok(files.some((entry) => entry.path.includes("codex") && /(?:codex|codex\.exe)$/u.test(entry.path)), "Installed Codex native binary missing");
  return { schema: 1, files: files.sort((a, b) => a.path.localeCompare(b.path)), coverageLimit: "Actual installed native byte digests; statically linked internal library versions may be unknown." };
}
