import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.env.npm_execpath;
assert.ok(pnpm && /\.[cm]?js$/u.test(pnpm), "Run this check through pnpm install:clean");
const temporary = await fs.mkdtemp(join(tmpdir(), "everpeace-clean-install-"));
const roots = ["src", "tests", "scripts", "assets", "patches", "third_party", ".github", "docs", "dosc"];
const rootFiles = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".oxlintrc.json", "tsconfig.json", "tsconfig.build.json", ".gitignore", "AGENTS.md", "LICENSE", "README.md", "README.zh-CN.md"];
const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots, ...rootFiles], { cwd: source, encoding: "utf8" }).split("\0").filter(Boolean))];
try {
  for (const name of files) {
    const path = join(source, name); const metadata = await fs.lstat(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (!metadata) continue;
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), `Clean installation requires an ordinary source file: ${name}`);
    const target = join(temporary, name); await fs.mkdir(dirname(target), { recursive: true }); await fs.copyFile(path, target);
  }
  execFileSync("git", ["init", "--quiet", temporary], { windowsHide: true });
  for (const args of [["install", "--frozen-lockfile"], ["install:verify"], ["build"], ["install:smoke"]]) {
    execFileSync(process.execPath, [pnpm, ...args], { cwd: temporary, stdio: "inherit", windowsHide: true });
  }
  console.log("Clean source snapshot installation verified; no existing node_modules or user directories were copied.");
} finally {
  // The absolute target is the exclusively created fixture, never a computed user path.
  assert.equal(dirname(temporary), tmpdir()); assert.ok(temporary.startsWith(join(tmpdir(), "everpeace-clean-install-")));
  await fs.rm(temporary, { recursive: true, force: true });
}
