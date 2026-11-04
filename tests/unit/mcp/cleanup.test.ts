import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import type { CodexDuplexExit, CodexDuplexProcess } from "../../../src/codex/cli.js";
import { SandboxedMcpTransport, mcpProcessBackend } from "../../../src/mcp/sandbox-transport.js";
import { McpRuntime, type McpServerConfig } from "../../../src/mcp/runtime.js";
import { ProcessCleanupError } from "../../../src/tools/process-completion.js";
import { approvedMcpFixture } from "../../fixtures/mcp-trust.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const exited: CodexDuplexExit = { exitCode: 1, signal: null, stderr: "", stderrTruncated: false };
const pipeError = () => Object.assign(new Error("fixture stdin closed"), { code: "EPIPE" });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const config = (): McpServerConfig => ({ name: "fixed", enabled: true, transport: { type: "stdio", isolation: "host", command: process.execPath, args: [] } });

function fixture(t: TestContext) {
  const exit = deferred<CodexDuplexExit>(), proof = deferred<CodexDuplexExit>(), stdout = new PassThrough();
  let stops = 0, closeInput = () => { exit.reject(pipeError()); };
  const process: CodexDuplexProcess = {
    stdout, exit: exit.promise,
    async write(data) {
      const request = JSON.parse(String(data)) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (request.id === undefined) return;
      const result = request.method === "initialize"
        ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixed", version: "test" } }
        : request.method === "tools/list" ? { tools: [{ name: "ping", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "pong" }] };
      queueMicrotask(() => stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"));
    },
    closeInput() { closeInput(); },
    terminate() { stops++; return proof.promise; },
  };
  t.mock.method(mcpProcessBackend, "host", () => process);
  t.after(() => { proof.resolve(exited); stdout.destroy(); });
  return { exit, proof, process, stops: () => stops, normalExit() { closeInput = () => exit.resolve(exited); } };
}

test("MCP shutdown pipe errors still wait for the owned cleanup proof", async t => {
  const f = fixture(t), transport = new SandboxedMcpTransport(config(), process.cwd());
  transport.onerror = () => {};
  await transport.start();
  let settled = false;
  const closing = transport.close().then(() => { settled = true; }, error => { settled = true; throw error; });
  void closing.catch(() => {});
  await flush();
  assert.equal(f.stops(), 1);
  assert.equal(settled, false);
  f.proof.resolve(exited);
  await closing;
  assert.equal(transport.close(), transport.close());
});

test("MCP shutdown retains genuine ownership cleanup failures after a pipe error", async t => {
  const f = fixture(t), transport = new SandboxedMcpTransport(config(), process.cwd());
  transport.onerror = () => {};
  await transport.start();
  const closing = transport.close(); void closing.catch(() => {});
  await flush();
  const failure = new ProcessCleanupError("fixture owner remains unknown");
  // Observe the controlled rejection even if the old implementation never asks for proof.
  void f.proof.promise.catch(() => {});
  f.proof.reject(failure);
  await assert.rejects(closing, error => error === failure);
});

test("normal MCP process exit closes without forcing another termination", async t => {
  const f = fixture(t), transport = new SandboxedMcpTransport(config(), process.cwd());
  f.normalExit();
  let closed = 0; transport.onclose = () => { closed++; };
  await transport.start(); await transport.close();
  assert.equal(f.stops(), 0); assert.equal(closed, 1);
});

test("the real MCP SDK accepts verified cleanup after stdin failure", async t => {
  const f = fixture(t);
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(), workspacePath: process.cwd(), async loadConfig() { return [config()]; } });
  assert.equal((await runtime.refresh()).servers[0]?.state, "ready");
  f.proof.resolve(exited);
  await runtime.close();
  assert.equal(f.stops(), 1); assert.deepEqual(runtime.snapshot().tools, []);
});

test("SDK transport detachment cannot discard pending or rejected owned cleanup", async t => {
  const f = fixture(t);
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(), workspacePath: process.cwd(), async loadConfig() { return [config()]; } });
  assert.equal((await runtime.refresh()).servers[0]?.state, "ready");
  f.exit.reject(pipeError());
  await flush();
  let settled = false;
  const closing = runtime.close().then(() => { settled = true; }, error => { settled = true; throw error; });
  void closing.catch(() => {});
  await flush();
  assert.equal(settled, false);
  void f.proof.promise.catch(() => {});
  f.proof.reject(new ProcessCleanupError("fixture owned cleanup unknown"));
  await assert.rejects(closing, /cleanup is unresolved/u);
  await assert.rejects(runtime.close(), /cleanup is unresolved/u);
  assert.deepEqual(runtime.snapshot().tools, []);
});
