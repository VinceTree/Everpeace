import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";

/** Keep Git's tracked/untracked scope, excluding only paths removed from disk. */
export function maintainedFiles(roots, extension) {
  const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots], { encoding: "utf8", windowsHide: true });
  return [...new Set(names.split("\0"))].filter((file) => {
    if (!extension.test(file)) return false;
    let metadata;
    try { metadata = lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (!metadata.isFile()) throw new Error(`Maintained input must be a regular file: ${file}`);
    return true;
  }).sort();
}
