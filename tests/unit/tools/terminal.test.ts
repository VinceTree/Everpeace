import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("Windows PTY cancellation waits for a detached uncooperative descendant", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-pty-tree-"));
  const script = path.join(root, "child.cjs");
  const source = "const {spawn}=require('node:child_process');process.on('SIGINT',()=>{});const child=spawn(process.execPath,['-e',\"process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)\"],{detached:true,windowsHide:true,stdio:['ignore','pipe','inherit']});child.stdout.once('data',()=>console.log('fixture-pids:'+process.pid+':'+child.pid));setInterval(()=>{},1000);";
  const controller = new AbortController();
  const pids: number[] = [];
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fs.writeFile(script, source);
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const result = await runTerminalCommand(`& ${quote(process.execPath)} ${quote(script)}`, { cwd: root, streamOutput: false, signal: controller.signal, onInputReady() {}, onOutput(text) {
      const match = /fixture-pids:(\d+):(\d+)/u.exec(text);
      if (match && !pids.length) { pids.push(Number(match[1]), Number(match[2])); controller.abort(); }
    } });
    assert.equal(pids.length, 2);
    assert.equal(result.cancelled, true);
    assert.equal(result.cleanupFailed, undefined);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Owned fixture already gone. */ } }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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
