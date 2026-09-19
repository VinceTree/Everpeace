import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  formatMcpStatus,
  McpRuntime,
  type McpServerConfig,
} from "../../../src/mcp/runtime.js";

const serverPath = fileURLToPath(new URL("../../fixtures/mcp-stdio-server.mjs", import.meta.url));

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "test_server",
    enabled: true,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {},
      env_vars: [],
      cwd: null,
    },
    ...overrides,
  };
}

test("MCP runtime discovers namespaced stdio tools, instructions, and calls", async (t) => {
  const runtime = new McpRuntime({
    workspacePath: process.cwd(),
    version: "test",
    async loadConfig() { return [config()]; },
  });
  t.after(() => runtime.close());

  const snapshot = await runtime.refresh();
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), ["mcp__test_server__ping"]);
  assert.match(snapshot.instructions, /Use ping/u);
  assert.match(formatMcpStatus(snapshot), /test_server · stdio · ready · 1 tool/u);
  assert.deepEqual(runtime.toolInfo("mcp__test_server__ping")?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
  });

  const output = JSON.parse(await runtime.call("mcp__test_server__ping", "{}")) as {
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(output.content[0]?.text, "pong");
});

test("MCP runtime respects Codex enabled tools and isolates server failures", async (t) => {
  const runtime = new McpRuntime({
    workspacePath: process.cwd(),
    async loadConfig() {
      return [
        config({ name: "filtered", enabled_tools: [] }),
        config({
          name: "broken",
          transport: { type: "stdio", command: "everpeace-missing-mcp-command", args: [] },
        }),
        config({ name: "off", enabled: false, disabled_reason: "disabled for test" }),
      ];
    },
  });
  t.after(() => runtime.close());

  const snapshot = await runtime.refresh();
  assert.equal(snapshot.tools.length, 0);
  assert.equal(snapshot.servers.find((server) => server.name === "filtered")?.state, "ready");
  assert.equal(snapshot.servers.find((server) => server.name === "broken")?.state, "failed");
  assert.equal(snapshot.servers.find((server) => server.name === "off")?.state, "disabled");
});
