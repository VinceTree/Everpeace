import { mockProcessOwner } from '../../helpers/process-owner.js';
import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { runCodexProcess, startCodexDuplexProcess } from "../../../src/codex/cli.js";
import { ProcessCleanupError } from "../../../src/tools/process-completion.js";

function processFixture(context: TestContext) {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 123456789 });
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const killers: ChildProcess[] = [];
  let killRequests = 0;
  mockProcessOwner(context, child, killers, () => { killRequests++; });
  context.mock.method(childProcess, "spawn", (command: string) => {
    if (command === "taskkill.exe") {
      killRequests++;
      const killer = new ChildProcess();
      killers.push(killer);
      return killer;
    }
    return child;
  });
  context.mock.method(process, "kill", () => { killRequests++; return true; });
  context.mock.method(child, "kill", () => true);
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  });
  return { child, killers, killRequests: () => killRequests };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("duplex termination shares one cleanup and waits for confirmed owner and launcher close below the cleanup deadline", async (context) => {
  const fixture = processFixture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const handle = startCodexDuplexProcess(["sandbox", "--", "fixture"]);
  const first = handle.terminate(), second = handle.terminate();
  let finished = false;
  void first.then(() => { finished = true; }, () => { finished = true; });
  const results = Promise.allSettled([first, second]);
  await flush();
  for (const killer of fixture.killers) killer.emit("close", 0);
  await flush();
  context.mock.timers.tick(600);
  await flush();
  const finishedBeforeClose = finished;
  fixture.child.emit("close", null, "SIGKILL");
  assert.ok((await results).every((result) => result.status === "fulfilled"));
  assert.equal(finishedBeforeClose, false, "elapsed time is not process-close evidence");
  assert.equal(first, second);
  assert.equal(handle.terminate(), first);
  assert.equal(fixture.killRequests(), 1);
});

test("duplex retains typed tree failure when the launcher closes before taskkill", async (context) => {
  const fixture = processFixture(context);
  const handle = startCodexDuplexProcess(["sandbox", "--", "fixture"], { platform: "win32" });
  let finished = false;
  void handle.exit.then(() => { finished = true; }, () => { finished = true; });
  const termination = handle.terminate();
  const results = Promise.allSettled([handle.exit, termination]);
  await flush();
  fixture.child.emit("close", null, "SIGKILL");
  await flush();
  const finishedBeforeCleanup = finished;
  fixture.killers[0]!.emit("close", 1);
  const outcomes = await results;
  assert.equal(finishedBeforeCleanup, false);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.ok(outcome.reason instanceof ProcessCleanupError);
  }
  await assert.rejects(handle.terminate(), ProcessCleanupError);
});

test("duplex transport error after spawn retains ownership until cleanup and close", async (context) => {
  const fixture = processFixture(context);
  const handle = startCodexDuplexProcess(["sandbox", "--", "fixture"]);
  let finished = false;
  void handle.exit.then(() => { finished = true; }, () => { finished = true; });
  fixture.child.emit("error", new Error("duplex transport failed"));
  await flush();
  const finishedBeforeClose = finished;
  fixture.killers[0]?.emit("close", 0);
  fixture.child.emit("close", null, "SIGKILL");
  await assert.rejects(handle.exit, /duplex transport failed/);
  assert.equal((await handle.terminate()).signal, "SIGKILL", "an observed transport error is separate from successful cleanup");
  assert.equal(finishedBeforeClose, false);
  assert.equal(fixture.killRequests(), 1);
});

test("pre-cancelled duplex launch does not start a process", async (context) => {
  const fixture = processFixture(context);
  assert.throws(() => startCodexDuplexProcess(["sandbox", "--", "fixture"], {
    signal: AbortSignal.abort(new Error("cancelled before launch")),
  }), /cancelled before launch/);
  assert.equal(fixture.killRequests(), 0);
});

test("sandbox cancellation waits beyond the old watchdog for process close and tree cleanup", async (context) => {
  const fixture = processFixture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let settled = false;
  const result = runCodexProcess(["sandbox", "--", "fixture"], { signal: controller.signal })
    .then((value) => { settled = true; return value; });
  fixture.child.stdout?.emit("data", "partial");
  controller.abort();
  context.mock.timers.tick(600);
  await flush();
  assert.equal(settled, false, "elapsed time is not evidence of process termination");
  fixture.child.emit("close", null, "SIGKILL");
  await flush();
  if (process.platform === "win32") {
    assert.equal(settled, false, "launcher close must not outrun taskkill /T");
    fixture.killers[0]!.emit("close", 0);
  }
  assert.equal((await result).cancelled, true);
  assert.equal((await result).stdout, "partial");
  assert.equal(fixture.killRequests(), 1);
});

test("timeout followed by abort requests one cleanup and retains both stop facts", async (context) => {
  const fixture = processFixture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const result = runCodexProcess(["sandbox", "--", "fixture"], { signal: controller.signal, timeoutMs: 100 });
  context.mock.timers.tick(100);
  controller.abort();
  await flush();
  fixture.killers[0]?.emit("close", 0);
  fixture.child.emit("close", null, "SIGKILL");
  const value = await result;
  assert.equal(fixture.killRequests(), 1);
  assert.equal(value.timedOut, true);
  assert.equal(value.cancelled, true);
  assert.match(value.error ?? "", /timed out/);
});

test("settled sandbox commands ignore late output and cancellation", async (context) => {
  const fixture = processFixture(context);
  const controller = new AbortController();
  const output: string[] = [];
  const result = runCodexProcess(["sandbox", "--", "fixture"], {
    signal: controller.signal,
    onStdout: (chunk) => output.push(chunk),
    onStderr: (chunk) => output.push(chunk),
  });
  fixture.child.stdout?.emit("data", "original");
  fixture.child.emit("close", 0, null);
  assert.equal((await result).exitCode, 0);
  fixture.child.stdout?.emit("data", "late stdout");
  fixture.child.stderr?.emit("data", "late stderr");
  controller.abort();
  assert.deepEqual(output, ["original"]);
  assert.equal(fixture.killRequests(), 0);
});

test("throwing process observers cannot abandon a running sandbox command", async (context) => {
  const fixture = processFixture(context);
  let settled = false;
  const result = runCodexProcess(["sandbox", "--", "fixture"], {
    onSpawned() { throw new Error("observer failed"); },
    onStdout() { throw new Error("output observer failed"); },
  }).then((value) => { settled = true; return value; });
  await flush();
  assert.equal(settled, false);
  assert.doesNotThrow(() => fixture.child.stdout?.emit("data", "captured"));
  fixture.child.emit("close", 0, null);
  const value = await result;
  assert.equal(value.exitCode, 0);
  assert.equal(value.stdout, "captured");
});

test("failed Windows tree termination is retained even after launcher close", { skip: process.platform !== "win32" }, async (context) => {
  const fixture = processFixture(context);
  const controller = new AbortController();
  const result = runCodexProcess(["sandbox", "--", "fixture"], { signal: controller.signal });
  controller.abort();
  await flush();
  fixture.child.emit("close", null, "SIGKILL");
  fixture.killers[0]!.emit("close", 1);
  const value = await result;
  assert.equal(value.cancelled, true);
  assert.match(value.error ?? "", /cleanup failed/);
});

test("a process error after spawn waits for cleanup and close instead of dropping ownership", async (context) => {
  const fixture = processFixture(context);
  let settled = false;
  const result = runCodexProcess(["sandbox", "--", "fixture"])
    .then((value) => { settled = true; return value; });
  fixture.child.emit("error", new Error("process transport failed"));
  await flush();
  assert.equal(settled, false);
  fixture.killers[0]?.emit("close", 0);
  fixture.child.emit("close", null, "SIGKILL");
  assert.equal((await result).error, "process transport failed");
  assert.equal(fixture.killRequests(), 1);
});

test("an onSpawned cancellation is observed after process listeners are installed", async (context) => {
  const fixture = processFixture(context);
  const controller = new AbortController();
  const result = runCodexProcess(["sandbox", "--", "fixture"], {
    signal: controller.signal,
    onSpawned: () => controller.abort(),
  });
  await flush();
  fixture.killers[0]?.emit("close", 0);
  fixture.child.emit("close", null, "SIGKILL");
  assert.equal((await result).cancelled, true);
  assert.equal(fixture.killRequests(), 1);
});
