import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { runBash } from "../../../src/tools/bash.js";
import { runBenchmarkVerification } from "../../../src/benchmark/runner.js";
import {observeProcessCompletion,ProcessCleanupError} from "../../../src/tools/process-completion.js";

function fixture(context: TestContext) {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 123456789 });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const killers: ChildProcess[] = [];
  let launches = 0;
  context.mock.method(childProcess, "spawn", (command: string) => {
    if (command === "taskkill.exe") {
      const killer = new ChildProcess();
      killers.push(killer);
      return killer;
    }
    launches++;
    return child;
  });
  context.mock.method(process, "kill", () => true);
  context.mock.method(child, "kill", () => true);
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    child.stdout?.destroy();
    child.stderr?.destroy();
  });
  return { child, killers, launches: () => launches };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("taskkill 128 remains a cleanup failure after a real owned child's fallback close",async(context)=>{
  const child=childProcess.spawn(process.execPath,['-e','process.stdout.write("ready");setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  context.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
  await new Promise<void>((resolve,reject)=>{child.stdout!.once('data',()=>resolve());child.once('error',reject);});
  const pid=child.pid!;
  context.mock.method(childProcess,'spawn',(command:string)=>{
    assert.equal(command,'taskkill.exe');const killer=new ChildProcess();queueMicrotask(()=>killer.emit('close',128));return killer;
  });
  syncBuiltinESMExports();
  context.after(()=>{context.mock.restoreAll();syncBuiltinESMExports();});
  const controller=new AbortController();
  const owned=observeProcessCompletion(child,{platform:'win32',signal:controller.signal});
  controller.abort();const result=await owned.completion;
  assert.equal(owned.closed,true);assert.equal(result.cancelled,true);
  assert.ok(result.cleanupError instanceof ProcessCleanupError);
  assert.match(result.cleanupError.message,/128/);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test("host Bash cancellation does not finish on a fixed elapsed-time watchdog", async (context) => {
  const process = fixture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let finished = false;
  const result = runBash("fixture", { streamOutput: false, signal: controller.signal })
    .then((value) => { finished = true; return value; });
  controller.abort();
  context.mock.timers.tick(600);
  await flush();
  assert.equal(finished, false);
  process.child.emit("close", null, "SIGKILL");
  process.killers[0]?.emit("close", 0);
  assert.equal((await result).cancelled, true);
});

test("pre-cancelled benchmark verification never launches a command", async (context) => {
  const process = fixture(context);
  const result = runBenchmarkVerification({ command: "fixture" }, ".", AbortSignal.abort());
  await flush();
  // Permit the old implementation to finish so the failure leaves no pending test work.
  process.child.emit("close", null, "SIGKILL");
  process.killers[0]?.emit("close", 0);
  assert.equal((await result).cancelled, true);
  assert.equal(process.launches(), 0);
});

test("benchmark verification waits for Windows tree cleanup after launcher close", { skip: process.platform !== "win32" }, async (context) => {
  const process = fixture(context);
  const controller = new AbortController();
  let finished = false;
  const result = runBenchmarkVerification({ command: "fixture" }, ".", controller.signal)
    .then((value) => { finished = true; return value; });
  controller.abort();
  await flush();
  process.child.emit("close", 0, null);
  await flush();
  const premature = finished;
  process.killers[0]!.emit("close", 1);
  const value = await result;
  assert.equal(premature, false);
  assert.equal(value.passed, false);
  assert.match(value.error ?? "", /cleanup failed/i);
});
