import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("node-pty/package.json"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(manifest.version, "1.1.0", "Re-audit the repository patch before changing node-pty");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.dependencies["node-pty"], "1.1.0", "The patched native dependency must use an exact version");
for (const [file, evidence] of [
  ["lib/windowsPtyAgent.js", ["this._inSocket.destroy()", "this._conoutSocketWorker.dispose()"]],
  ["lib/conpty_console_list_agent.js", ["var consoleProcessList = [];", "consoleProcessList = getConsoleProcessList(shellPid);", "A closed console has no remaining attached processes to report."]],
  ["lib/worker/conoutSocketWorker.js", ["conoutSocket.unpipe(workerSocket)", "conoutSocket.resume()", "error.code !== 'EPIPE' && error.code !== 'ECONNRESET'"]],
]) {
  const source = readFileSync(join(root, file), "utf8");
  for (const expected of evidence) assert.ok(source.includes(expected), `Repository patch missing from ${file}: ${expected}`);
}
console.log("Source installation: exact native dependency and installed repository patch verified.");
