import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { codexCliLaunch, isSandboxHelperSetupError, runCodexCli, runCodexProcess, startCodexDuplexProcess } from "../../../src/codex/cli.js";

test("Windows native launch pins MXC after configuration overrides and before the untouched payload", () => {
  const payload = ["--", "node", "-e", "windows.sandbox=unelevated"];
  const launch = codexCliLaunch(["sandbox", "-P", ":read-only", "-c", "windows.sandbox=unelevated", ...payload], { platform: "win32", codexCliPath: "fixture" });
  assert.deepEqual(launch.args.slice(-payload.length - 2), ["-c", "windows.sandbox=mxc", ...payload]);
  assert.deepEqual(codexCliLaunch(["mcp", "list"], { platform: "win32", codexCliPath: "fixture" }).args, ["fixture", "mcp", "list"]);
  assert.deepEqual(codexCliLaunch(["sandbox", ...payload], { platform: "linux", codexCliPath: "fixture" }).args, ["fixture", "sandbox", ...payload]);
});

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

test("launcher cancellation returns only after a real child and grandchild stop", { timeout: 20_000 }, async () => {
  await withFakeCodex([
    "import { spawn } from 'node:child_process';",
    "const descendant = spawn(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });",
    "descendant.stdout.once('data', data => console.log(JSON.stringify({ parent: process.pid, child: Number(String(data).trim()) })));",
    "setInterval(() => {}, 1000);",
  ].join("\n"), async (scriptPath) => {
    const controller = new AbortController();
    let pids: { parent: number; child: number } | undefined;
    let output = "";
    const result = await runCodexProcess(["sandbox", "--", "fixture"], {
      codexCliPath: scriptPath,
      signal: controller.signal,
      timeoutMs: 15_000,
      onStdout(chunk) {
        output += chunk;
        if (!output.includes("\n")) return;
        pids = JSON.parse(output.trim()) as { parent: number; child: number };
        controller.abort();
      },
    });
    assert.ok(pids, "fixture must start the descendant before cancellation");
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, undefined);
    assert.equal(result.error, undefined);
    for (const pid of [pids.parent, pids.child]) {
      try { process.kill(pid, 0); }
      catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        continue;
      }
      // An orphan killed with its parent can remain in Linux's process table
      // until the reaper collects it. Signal 0 also succeeds for these zombies.
      assert.equal(process.platform, "linux", `PID ${pid} must have exited`);
      let stat: string;
      try { stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"); }
      catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
        continue;
      }
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      assert.ok(state === "Z" || state === "X", `PID ${pid} is still live (state ${state})`);
    }
  });
});
