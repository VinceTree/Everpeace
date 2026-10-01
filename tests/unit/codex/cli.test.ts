import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isSandboxHelperSetupError, runCodexCli, startCodexDuplexProcess } from "../../../src/codex/cli.js";

async function withFakeCodex(script: string, callback: (scriptPath: string, statePath: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-codex-cli-"));
  const scriptPath = path.join(directory, "fake-codex.mjs");
  const statePath = path.join(directory, "attempts");
  await fs.writeFile(scriptPath, script, "utf8");
  await fs.writeFile(statePath, "0", "utf8");
  try {
    await callback(scriptPath, statePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("Windows sandbox helper setup refresh is retried once", async () => {
  await withFakeCodex(
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const state = process.env.EVERPEACE_TEST_STATE;",
      "const attempts = Number(readFileSync(state, 'utf8') || '0') + 1;",
      "writeFileSync(state, String(attempts));",
      "if (attempts === 1) { console.error('sandbox helper_unknown_error during setup refresh'); process.exit(17); }",
      "console.log('sandbox ready');",
    ].join("\n"),
    async (scriptPath, statePath) => {
      const result = await runCodexCli(["sandbox", "-P", ":workspace"], {
        codexCliPath: scriptPath,
        env: { ...process.env, EVERPEACE_TEST_STATE: statePath },
        platform: "win32",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.equal(result.stdout.trim(), "sandbox ready");
      assert.equal(await fs.readFile(statePath, "utf8"), "2");
    },
  );
});

test("sandbox helper failure is fail-closed after the bounded retry", async () => {
  await withFakeCodex(
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const state = process.env.EVERPEACE_TEST_STATE;",
      "const attempts = Number(readFileSync(state, 'utf8') || '0') + 1;",
      "writeFileSync(state, String(attempts));",
      "console.error('helper_unknown_error: sandbox helper refresh failed');",
      "process.exit(19);",
    ].join("\n"),
    async (scriptPath, statePath) => {
      const result = await runCodexCli(["sandbox", "-P", ":workspace"], {
        codexCliPath: scriptPath,
        env: { ...process.env, EVERPEACE_TEST_STATE: statePath },
        platform: "win32",
      });
      assert.equal(result.exitCode, 19);
      assert.match(result.error ?? "", /bounded retry/);
      assert.match(result.stderr, /helper_unknown_error/);
      assert.equal(await fs.readFile(statePath, "utf8"), "2");
    },
  );
});

test("only Windows sandbox helper setup errors are retry candidates", () => {
  assert.equal(isSandboxHelperSetupError("sandbox helper_unknown_error"), true);
  assert.equal(isSandboxHelperSetupError("sandbox helper setup failed"), true);
  assert.equal(isSandboxHelperSetupError("ordinary command failed"), false);
});

test("duplex sandbox transport preserves raw stdio and drains bounded stderr", async () => {
  await withFakeCodex(
    [
      "process.stderr.write('diagnostic');",
      "process.stdin.pipe(process.stdout);",
    ].join("\n"),
    async (scriptPath) => {
      const child = startCodexDuplexProcess(["sandbox", "-P", ":read-only", "--", "ignored"], {
        codexCliPath: scriptPath,
        stderrMaxBytes: 64,
      });
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      await child.write(Buffer.from([0, 1, 2, 255]));
      child.closeInput();
      const result = await child.exit;
      assert.deepEqual(Buffer.concat(output), Buffer.from([0, 1, 2, 255]));
      assert.equal(result.stderr, "diagnostic");
      assert.equal(result.stderrTruncated, false);
    },
  );
});

test("duplex sandbox transport applies backpressure and truncates noisy stderr", async () => {
  await withFakeCodex(
    [
      "process.stderr.write('x'.repeat(4096));",
      "setTimeout(() => process.stdin.pipe(process.stdout), 50);",
    ].join("\n"),
    async (scriptPath) => {
      const child = startCodexDuplexProcess(["sandbox", "-P", ":read-only", "--", "ignored"], {
        codexCliPath: scriptPath,
        stderrMaxBytes: 128,
      });
      let received = 0;
      child.stdout.on("data", (chunk: Buffer) => { received += chunk.length; });
      const input = Buffer.alloc(2 * 1024 * 1024, 7);
      await child.write(input);
      child.closeInput();
      const result = await child.exit;
      assert.equal(received, input.length);
      assert.equal(result.stderr.length, 128);
      assert.equal(result.stderrTruncated, true);
    },
  );
});
