import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISABLE_FOCUS_REPORTING,
  DISABLE_WIN32_INPUT_MODE,
  renderTerminalOutput,
  resetTerminalModes,
  resolveTerminalInvocation,
  runTerminalCommand,
} from "../../../src/tools/terminal.js";

test("PTY cancellation terminates a long command without closing the parent", { timeout: 15000 }, async () => {
  const controller = new AbortController();
  const command = process.platform === "win32" ? 'Write-Output "pid:$PID ready"; Start-Sleep -Seconds 60' : 'echo "pid:$$ ready"; sleep 60';
  const result = await runTerminalCommand(command, { streamOutput: false, signal: controller.signal, onInputReady() {}, onOutput: (text) => { if (text.includes("ready")) controller.abort(); } });
  assert.equal(result.cancelled, true);
  const pid = Number(/pid:(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("interactive PTY accepts routed input and cleans up its input owner", { timeout: 15000 }, async () => {
  let write: ((input: string) => void) | undefined;
  let submitted = false;
  const result = await runTerminalCommand(process.platform === "win32" ? '$answer = Read-Host "answer"; Write-Output "received:$answer"' : 'printf "answer:"; read answer; echo "received:$answer"', {
    streamOutput: false,
    onInputReady(input) { write = input; },
    onOutput(text) { if (!submitted && text.includes("answer")) { submitted = true; write?.("yes\r"); } },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /received:yes/);
  assert.equal(write, undefined);
});

test("terminal mode reset disables focus reporting and Windows input mode", () => {
  let windowsOutput = "";
  resetTerminalModes({
    write(chunk) {
      windowsOutput += chunk;
    },
  }, "win32");
  assert.equal(
    windowsOutput,
    DISABLE_FOCUS_REPORTING + DISABLE_WIN32_INPUT_MODE,
  );

  let unixOutput = "";
  resetTerminalModes({
    write(chunk) {
      unixOutput += chunk;
    },
  }, "linux");
  assert.equal(unixOutput, DISABLE_FOCUS_REPORTING);
});

test("direct terminal commands use PowerShell on Windows", () => {
  const invocation = resolveTerminalInvocation("Get-ChildItem", {
    platform: "win32",
  });

  assert.equal(invocation.executable, "powershell.exe");
  assert.deepEqual(invocation.args, [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "Get-ChildItem",
  ]);
  assert.equal(invocation.shellName, "PowerShell");
});

test("direct terminal commands use Bash on Unix-like systems", () => {
  const invocation = resolveTerminalInvocation("ls", { platform: "linux" });

  assert.equal(invocation.executable, "bash");
  assert.deepEqual(invocation.args, ["-c", "ls"]);
  assert.equal(invocation.shellName, "Bash");
});

test("captured terminal output keeps its layout without replaying control sequences", async () => {
  const output = await renderTerminalOutput(
    "\u001B[2J\u001B[H\u001B[31mNAME    SIZE\u001B[0m\u001B[8X\r\nfile-a  10\r\nfile-b  20\r\n",
    40,
    8,
  );

  assert.equal(output, "NAME    SIZE\nfile-a  10\nfile-b  20");
});
