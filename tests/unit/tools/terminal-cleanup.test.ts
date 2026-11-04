import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { runTerminalCommand, terminalProcessBackend } from "../../../src/tools/terminal.js";
import type { ProcessReceipt } from "../../../src/tools/owned-process.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext, rejectClosedConsole = false) {
  let settle!: (receipt: ProcessReceipt) => void;
  const receipt = new Promise<ProcessReceipt>(resolve => { settle = resolve; });
  let stopped = 0, killed = 0, exited = false;
  let onExit: (event: { exitCode: number; signal: number }) => void = () => {};
  const exit = () => { if (!exited) { exited = true; onExit({ exitCode: 0, signal: 0 }); } };
  t.mock.method(terminalProcessBackend, "launch", () => ({ command: "fixture", args: [], attach() {
    return { ownerId: "fixed-owner", receipt, stop() { stopped++; } };
  } }));
  const pty = {
    pid: 123456789,
    onData() { return { dispose() {} }; },
    onExit(listener: typeof onExit) { onExit = listener; return { dispose() {} }; },
    write() {},
    kill() { killed++; if (exited && rejectClosedConsole) throw new Error("fixture console is already closed"); exit(); },
  } as unknown as ReturnType<typeof terminalProcessBackend.spawn>;
  t.mock.method(terminalProcessBackend, "spawn", () => pty);
  t.after(() => { settle({ status: "confirmed_exited", exitCode: 0 }); exit(); });
  return { settle, exit, stopped: () => stopped, killed: () => killed };
}

test("PTY cancellation waits for the original Job proof even after pseudoconsole exit", async t => {
  const f = fixture(t, true), controller = new AbortController();
  let settled = false;
  const run = runTerminalCommand("fixture", { platform: "win32", streamOutput: false, signal: controller.signal, onInputReady() {} })
    .then(result => { settled = true; return result; });
  controller.abort(); await flush();
  assert.equal(f.stopped(), 1); assert.equal(f.killed(), 0);
  f.exit(); await flush();
  assert.equal(settled, false);
  f.settle({ status: "confirmed_exited", exitCode: 1, pid: 987654321, identity: "7:9" });
  const result = await run;
  assert.equal(result.cleanupStatus, "confirmed_exited");
  assert.equal(result.cleanupFailed, undefined);
  assert.equal(result.cancelled, true); assert.equal(f.killed(), 0);
});

test("PTY cancellation propagates unknown ownership instead of treating console exit as proof", async t => {
  const f = fixture(t), controller = new AbortController();
  const run = runTerminalCommand("fixture", { platform: "win32", streamOutput: false, signal: controller.signal, onInputReady() {} });
  controller.abort(); await flush();
  f.settle({ status: "unknown", exitCode: null });
  const result = await run;
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.cleanupStatus, "unknown");
  assert.match(result.error ?? "", /ownership is unresolved/u);
  assert.equal(f.stopped(), 1); assert.equal(f.killed(), 1);
});

test("normal PTY completion also retains the owner receipt until its original process exits", async t => {
  const f = fixture(t); let settled = false;
  const run = runTerminalCommand("fixture", { platform: "win32", streamOutput: false, onInputReady() {} })
    .then(result => { settled = true; return result; });
  f.exit(); await flush();
  assert.equal(settled, false);
  f.settle({ status: "confirmed_exited", exitCode: 0, pid: 987654321, identity: "7:9" });
  const result = await run;
  assert.equal(result.cleanupStatus, "confirmed_exited");
  assert.equal(result.cancelled, false); assert.equal(f.killed(), 0);
});
