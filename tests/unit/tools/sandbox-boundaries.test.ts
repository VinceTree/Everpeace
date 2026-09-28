import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCodexProcess } from "../../../src/codex/cli.js";
import { runBash } from "../../../src/tools/bash.js";
import { modelShellEnvironment } from "../../../src/tools/sandbox-policy.js";

test("model shell strips inherited credentials and startup injection but keeps toolchain paths", () => {
  const source = { Path: "fixture-path", SystemRoot: "fixture-system", TEMP: "fixture-temp", CODEX_HOME: "fixture-home", OPENAI_API_KEY: "fake-key", github_token: "fake-token", DATABASE_PASSWORD: "fake-password", NODE_OPTIONS: "--require malicious.js", BASH_ENV: "malicious.sh", LD_PRELOAD: "malicious.so", PROJECT_SETTING: "yes" };
  assert.deepEqual(modelShellEnvironment(source), { Path: "fixture-path", SystemRoot: "fixture-system", TEMP: "fixture-temp", CODEX_HOME: "fixture-home", PROJECT_SETTING: "yes" });
  assert.equal(source.OPENAI_API_KEY, "fake-key");
});

test("sandbox payload output cannot trigger replay on success or failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-sandbox-replay-"));
  try {
    const script = path.join(root, "fixture.mjs");
    await fs.writeFile(script, "import { appendFileSync } from 'node:fs'; appendFileSync('effects', 'x'); console.log('helper_unknown_error'); console.error('sandbox helper setup failed'); process.exit(Number(process.env.FIXTURE_EXIT));");
    for (const [args, exitCode] of [
      [["sandbox", "--", "payload"], 0],
      [["sandbox", "--", "payload"], 19],
      [["sandbox", "-P", ":workspace", "payload"], 19],
    ] as const) {
      const result = await runCodexProcess(args, { platform: "win32", codexCliPath: script, cwd: root, env: { ...process.env, FIXTURE_EXIT: String(exitCode) } });
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.attempts, 1);
      assert.equal(result.error, undefined);
      assert.equal(await fs.readFile(path.join(root, "effects"), "utf8"), "x");
      await fs.unlink(path.join(root, "effects"));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("model launcher never inherits fake credentials or Node startup code", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-sandbox-env-"));
  try {
    const script = path.join(root, "fixture.mjs");
    await fs.writeFile(script, "console.log(JSON.stringify({ credentialPresent: 'FIXTURE_API_KEY' in process.env, startupPresent: 'NODE_OPTIONS' in process.env, setting: process.env.PROJECT_SETTING }));");
    const result = await runBash("ignored", { cwd: root, streamOutput: false, sandbox: { permissionProfile: ":workspace", codexCliPath: script }, env: { ...process.env, FIXTURE_API_KEY: "fake-key", NODE_OPTIONS: "--require ./must-not-load.cjs", PROJECT_SETTING: "preserved" } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { credentialPresent: false, startupPresent: false, setting: "preserved" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("cancelled sandbox commands do not start a launcher", async () => {
  const signal = AbortSignal.abort();
  const result = await runBash("ignored", { signal, streamOutput: false, sandbox: { permissionProfile: ":workspace", codexCliPath: "missing-launcher.mjs" } });
  assert.equal(result.cancelled, true);
  assert.equal(result.stdout, "");
});
