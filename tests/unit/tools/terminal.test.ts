import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISABLE_FOCUS_REPORTING,
  DISABLE_WIN32_INPUT_MODE,
  renderTerminalOutput,
  resetTerminalModes,
  resolveTerminalInvocation,
} from "../../../src/tools/terminal.js";

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
