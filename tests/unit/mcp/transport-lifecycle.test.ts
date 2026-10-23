import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { approvedMcpFixture } from "../../fixtures/mcp-trust.js";
import { McpRuntime, type McpServerConfig } from "../../../src/mcp/runtime.js";
import { SandboxedMcpTransport } from "../../../src/mcp/sandbox-transport.js";

const config = (): McpServerConfig => ({
  name: "startup-failure", enabled: true,
  transport: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] },
});

test("closing an unused MCP transport emits one event, tolerates reentry and closes admission", async () => {
  const transport = new SandboxedMcpTransport(config(), process.cwd());
  let events = 0;
  let reentry: Promise<void> | undefined;
  transport.onclose = () => { events++; reentry = transport.close(); };
  const closing = transport.close();
  assert.equal(transport.close(), closing);
  await assert.rejects(transport.start(), /closed/u);
  await closing;
  assert.equal(events, 1);
  assert.equal(reentry, closing);
  await assert.rejects(transport.start(), /closed/u);
  await assert.rejects(transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }), /closed/u);
  await transport.close();
  assert.equal(events, 1);
});

test("real SDK observes transport closure after sandbox preparation fails before launch", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "everpeace-mcp-prelaunch-sdk-"));
  const transport = new SandboxedMcpTransport(config(), workspace);
  const client = new Client({ name: "offline", version: "test" });
  let events = 0;
  transport.onclose = () => { events++; };
  try {
    // A regular file cannot become the required sandbox control directory.
    await fs.writeFile(join(workspace, ".everpeace"), "keep this file");
    await assert.rejects(client.connect(transport), /EEXIST|ENOTDIR/u);
    await client.close();
    assert.equal(events, 1);
    assert.equal(client.transport, undefined);
    await client.close();
    assert.equal(events, 1);
    assert.equal(await fs.readFile(join(workspace, ".everpeace"), "utf8"), "keep this file");
  } finally {
    await transport.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("prelaunch sandbox rejection retains its cause without poisoning runtime cleanup", { timeout: 10_000 }, async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "everpeace-mcp-prelaunch-runtime-"));
  let enabled = true;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(), workspacePath: workspace, async loadConfig() { return [{ ...config(), enabled }]; } });
  try {
    await fs.writeFile(join(workspace, ".everpeace"), "keep this file");
    const snapshot = await runtime.refresh();
    assert.equal(snapshot.tools.length, 0);
    assert.match(snapshot.servers[0]?.detail ?? "", /EEXIST|ENOTDIR/u);
    assert.doesNotMatch(snapshot.servers[0]?.detail ?? "", /did not close|cleanup/u);
    await runtime.close();
    assert.deepEqual(runtime.snapshot().servers, []);
    enabled = false;
    const refreshed = await runtime.refresh();
    assert.equal(refreshed.servers[0]?.state, "disabled");
  } finally {
    try { await runtime.close(); }
    finally { await fs.rm(workspace, { recursive: true, force: true }); }
  }
});
