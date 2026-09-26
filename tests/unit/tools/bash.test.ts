import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBashLaunch, runBash, serializeBashResult } from "../../../src/tools/bash.js";

test("Bash abort stops a running child and leaves the next command usable", { timeout: 15000 }, async () => {
  const controller = new AbortController();
  const started = Date.now();
  const command = process.platform === "win32"
    ? "Write-Output ready; Start-Sleep -Seconds 60"
    : "echo ready; sleep 60";
  const result = await runBash(command, { streamOutput: false, signal: controller.signal, onOutput: () => controller.abort() });
  assert.equal(result.cancelled, true);
  assert.ok(Date.now() - started < 12000);
  assert.match(result.stdout, /ready/);
  const followUp = process.platform === "win32" ? "[Console]::Write('alive')" : "printf alive";
  assert.equal((await runBash(followUp, { streamOutput: false })).stdout, "alive");
});

test("runBash captures stdout and a successful exit code", async () => {
  const command = process.platform === "win32" ? "[Console]::Write('hello')" : "printf hello";
  const result = await runBash(command, { streamOutput: false });

  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});

test("runBash captures stderr and a non-zero exit code", async () => {
  const command = process.platform === "win32"
    ? "[Console]::Error.Write('problem'); exit 7"
    : "printf problem >&2; exit 7";
  const result = await runBash(command, {
    streamOutput: false,
  });

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "problem");
  assert.equal(result.exitCode, 7);
});

test("runBash reports a missing executable", async () => {
  const result = await runBash("printf hello", {
    bashPath: "everpeace-definitely-missing-bash",
    streamOutput: false,
  });

  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /ENOENT/i);
});

test("serializeBashResult preserves timeout failures for the model", () => {
  const serialized = serializeBashResult({
    stdout: "partial",
    stderr: "",
    exitCode: null,
    signal: null,
    timedOut: true,
    error: "Bash command timed out after 120000 ms",
  });

  assert.deepEqual(JSON.parse(serialized), {
    stdout: "partial",
    stderr: "",
    exit_code: null,
    signal: null,
    timed_out: true,
    error: "Bash command timed out after 120000 ms",
  });
});

test("runBash terminates a timed-out Unix child", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const result = await runBash("sleep 60", { streamOutput: false, timeoutMs: 100 });

  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.match(result.error ?? "", /timed out after 100 ms/);
});

test("runBash can attach directly to the current terminal", async () => {
  const result = await runBash(process.platform === "win32" ? "$null" : ":", { terminal: true });

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});

test("unsandboxed Bash follows the host shell default", () => {
  const launch = resolveBashLaunch("echo safe");
  if (process.platform === "win32") {
    assert.equal(launch.command, "powershell.exe");
    assert.deepEqual(launch.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  } else {
    assert.equal(launch.args[0], "-c");
  }
});

test("sandboxed Bash is routed through the pinned Codex CLI and native profile", () => {
  const launch = resolveBashLaunch("echo safe", {
    cwd: "C:\\workspace",
    bashPath: "/bin/custom-bash",
    sandbox: {
      permissionProfile: ":workspace",
      readableRoots: ["C:\\skills"],
      codexCliPath: "C:\\codex\\bin\\codex.js",
    },
  });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args.slice(0, 8), [
    "C:\\codex\\bin\\codex.js",
    "sandbox",
    "-P",
    ":workspace",
    "-C",
    "C:\\workspace",
    "--sandbox-state-readable-root",
    "C:\\skills",
  ]);
  assert.equal(launch.args[8], "--");
  if (process.platform === "win32") {
    assert.deepEqual(launch.args.slice(9), ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "echo safe"]);
  } else {
    assert.deepEqual(launch.args.slice(9), ["/bin/custom-bash", "-c", "echo safe"]);
  }
});
