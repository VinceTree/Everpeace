import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { candidateSha, digest, requireNativeResults } from "./policy.mjs";
import { sourceIdentity } from "./source-identity.mjs";
import { runCommand } from "./commands.mjs";

assert.equal(process.platform, "win32", "Native acceptance requires Windows");
assert.equal(process.env.EVERPEACE_NATIVE_REQUIRED, "1", "Explicit required native mode is mandatory");
assert.notEqual(process.env.EVERPEACE_NATIVE_MODE, "hosted");
const directory = path.resolve(process.env.EVERPEACE_NATIVE_OUTPUT ?? "native-evidence");
mkdirSync(directory, { recursive: true });
const events = path.join(directory, "results.jsonl");
writeFileSync(events, "");
const commit = candidateSha(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
const identity = sourceIdentity(process.cwd());
if (process.env.GITHUB_ACTIONS === "true") assert.equal(identity.dirty, false, "Native CI needs a clean candidate");
let success = false;
try {
  await runCommand(process.execPath, ['scripts/build-file-helper.mjs'], { stdio: 'inherit' });
  await runCommand(process.execPath, ['scripts/build-file-helper.mjs', '--test'], { stdio: 'inherit' });
  await runCommand(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=./scripts/release/native-reporter.mjs", "tests/unit/tools/sandbox-boundaries.test.ts", "tests/unit/team/team.test.ts", "tests/unit/team/workspace-layout.test.ts", "tests/unit/security/native-files.test.ts", "tests/unit/security/native-process.test.ts", "tests/unit/security/native-batch.test.ts", "tests/unit/mcp/sandbox.test.ts"], {
    stdio: "inherit", timeout: 20 * 60_000, env: { ...process.env, EVERPEACE_NATIVE_EVENTS: events },
  });
  requireNativeResults(readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  assert.deepEqual(sourceIdentity(process.cwd()), identity, "Source changed during native acceptance");
  success = true;
} finally {
  // Persist failed outcomes as well; a file's presence never means success.
  writeFileSync(path.join(directory, "receipt.json"), JSON.stringify({ schema: 1, commit, ...identity, success, eventsSha256: digest(events), node: process.version, platform: process.platform, arch: process.arch, os: os.release(), backend: "@openai/codex@0.162.0; windows.sandbox=mxc", runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }, null, 2) + "\n");
}
