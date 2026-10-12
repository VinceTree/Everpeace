import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [task, workspace] = process.argv.slice(2);
if (!task || !workspace) throw new Error("usage: verify-chalk.mjs <task> <workspace>");
const module = await import(pathToFileURL(path.join(workspace, "source", "index.js")).href + `?grade=${Date.now()}`);
if (task === "nested-reset") {
  const chalk = new module.Chalk({ level: 1 });
  assert.equal(chalk.red.bold("a\u001B[22mb"), "\u001B[31m\u001B[1ma\u001B[22m\u001B[1mb\u001B[22m\u001B[39m");
} else if (task === "visible") {
  const chalk = new module.Chalk({ level: 0 });
  assert.equal(chalk.visible("hidden"), "");
} else if (task === "types") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "everpeace-chalk-types-"));
  try {
    const relative = path.relative(directory, path.join(workspace, "source", "index.js")).split(path.sep).join("/");
    await writeFile(path.join(directory, "check.ts"), `import chalk from ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)};\nchalk(123, { ok: true });\n`, "utf8");
    const result = spawnSync(process.execPath, [
      path.join(workspace, "node_modules", "typescript", "bin", "tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--types",
      "node",
      "--typeRoots",
      path.join(workspace, "node_modules", "@types"),
      "check.ts",
    ], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} else {
  throw new Error(`unknown Chalk task: ${task}`);
}
