import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { spawn } = require("node-pty");
const { runTerminalCommand } = await import("./dist/tools/terminal.js");

function gone(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
  if (process.platform === "linux") {
    try { return /\) [ZX] /u.test(execFileSync("cat", [`/proc/${pid}/stat`], { encoding: "utf8" })); }
    catch { return true; }
  }
  return false;
}

async function waitGone(pid) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (gone(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Owned fixture process survived: ${pid}`);
}

test("installed CLI, public SDK and bundled patch are present", async () => {
  assert.match(execFileSync(process.execPath, [path.join(root, "dist/cli/index.js"), "--help"], { encoding: "utf8", timeout: 20_000 }), /--team/u);
  assert.equal(typeof (await import("everpeace/sdk")).runTask, "function");
  const native = path.dirname(require.resolve("node-pty/package.json"));
  assert.ok(native.startsWith(path.join(root, "node_modules", "node-pty")), "Consumer did not load the bundled native dependency");
  const windows = await fs.readFile(path.join(native, "lib/windowsPtyAgent.js"), "utf8");
  assert.ok(windows.includes("this._inSocket.destroy()") && windows.includes("this._conoutSocketWorker.dispose()"));
  assert.ok((await fs.readFile(path.join(native, "lib/conpty_console_list_agent.js"), "utf8")).includes("var consoleProcessList = [];"));
  const worker = await fs.readFile(path.join(native, "lib/worker/conoutSocketWorker.js"), "utf8");
  assert.ok(worker.includes("conoutSocket.unpipe(workerSocket)") && worker.includes("conoutSocket.resume()") && worker.includes("error.code !== 'EPIPE' && error.code !== 'ECONNRESET'"));
});

test("installed PTY accepts input and resize, exits, and can restart", { timeout: 30_000 }, async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const source = process.platform === "win32"
      ? "console.log('ready:'+process.pid); process.stdin.once('data',()=>{console.log('received');process.exit(0)});"
      : "console.log('ready:'+process.pid); process.stdin.once('data',()=>{const started=Date.now(); const timer=setInterval(()=>{const [cols,rows]=process.stdout.getWindowSize(); if(cols===100&&rows===30){clearInterval(timer);console.log('received:'+cols+':'+rows);process.exit(0)}else if(Date.now()-started>3000){clearInterval(timer);process.exit(1)}},10)});";
    const child = spawn(process.execPath, ["-e", source], { cols: 80, rows: 24, cwd: root, env: process.env });
    let output = "";
    let resized = false;
    let inputSent = false;
    const exit = new Promise((resolve) => child.onExit(resolve));
    const subscription = child.onData((chunk) => {
      output += chunk;
      if (output.includes("ready:") && !resized) {
        resized = true;
        child.resize(100, 30);
      }
      // Windows ConPTY emits a native resize frame; Node's cached console dimensions do not update reliably.
      if (resized && !inputSent && (process.platform !== "win32" || output.includes("\u001b[8;30;100t"))) {
        inputSent = true;
        child.write("yes\r");
      }
    });
    let timer;
    try {
      const result = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PTY exit timed out")), 10_000); })]);
      assert.equal(result.exitCode, 0);
      if (process.platform === "win32") {
        const frame = output.indexOf("\u001b[8;30;100t");
        assert.ok(frame >= 0, "Native ConPTY resize frame was missing");
        assert.match(output.slice(frame), /received/u);
      } else assert.match(output, /received:100:30/u);
      await waitGone(child.pid);
    } finally {
      clearTimeout(timer);
      subscription.dispose();
      if (!gone(child.pid)) child.kill();
    }
  }
});

test("installed terminal cancellation stops an uncooperative process tree", { timeout: 30_000 }, async () => {
  const fixture = path.join(root, "consumer-child.cjs");
  const source = "const {spawn}=require('node:child_process'); process.on('SIGINT',()=>{}); const child=spawn(process.execPath,['-e',\"process.on('SIGINT',()=>{});console.log('child-ready');setInterval(()=>{},1000)\"],{detached:process.platform==='win32',windowsHide:true,stdio:['ignore','pipe','inherit']}); child.stdout.once('data',()=>console.log('fixture-pids:'+process.pid+':'+child.pid)); setInterval(()=>{},1000);";
  await fs.writeFile(fixture, source);
  const quote = (value) => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${process.platform === "win32" ? "& " : "exec "}${quote(process.execPath)} ${quote(fixture)}`;
  const controller = new AbortController();
  let pids = [];
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const result = await runTerminalCommand(command, { cwd: root, streamOutput: false, signal: controller.signal, onInputReady() {}, onOutput(text) {
      const match = /fixture-pids:(\d+):(\d+)/u.exec(text);
      if (match) { pids = [Number(match[1]), Number(match[2])]; controller.abort(); }
    } });
    assert.equal(pids.length, 2, "Fixture never started");
    assert.equal(result.cancelled, true);
    assert.equal(result.cleanupFailed, undefined);
    assert.equal(result.error, undefined);
    for (const pid of pids) await waitGone(pid);
    const beforeStart = new AbortController();
    beforeStart.abort();
    const cancelled = await runTerminalCommand(command, { streamOutput: false, signal: beforeStart.signal, onInputReady() {} });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.stdout, "");
  } finally {
    clearTimeout(timer);
    // Clean only the fixture PIDs even when an assertion fails.
    for (const pid of pids) if (!gone(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    await fs.unlink(fixture);
  }
});
