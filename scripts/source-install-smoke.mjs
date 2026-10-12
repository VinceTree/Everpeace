import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const help = execFileSync(process.execPath, [join(root, "dist/cli/index.js"), "--help"], { cwd: root, encoding: "utf8", windowsHide: true });
assert.match(help, /--team/u);
const sdk = await import("../dist/sdk/index.js");
assert.equal(typeof sdk.runTask, "function");
// This exercises installed native PTY cancellation, normal exit and repeated startup without any provider calls.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "tests/unit/tools/terminal.test.ts"], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
assert.equal(result.status, 0, "Installed native PTY lifecycle checks failed");
console.log("Source installation: CLI, SDK and native PTY startup/lifecycle verified.");
