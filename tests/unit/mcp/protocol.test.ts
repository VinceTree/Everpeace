import { approvedMcpFixture } from "../../fixtures/mcp-trust.js";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import type { Tool, ListResourcesResult } from "@modelcontextprotocol/sdk/types.js";
import { McpRuntime, formatMcpStatus, type McpServerConfig } from "../../../src/mcp/runtime.js";
import { MAX_MCP_RESULT_BYTES, serializeMcpPage, serializeMcpResult } from "../../../src/mcp/results.js";
import { startHttpProtocolFixture } from "../../fixtures/mcp-protocol-fixture.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/mcp-protocol-fixture.ts", import.meta.url));

function config(transport: McpServerConfig["transport"], overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: "fixture", enabled: true, transport, ...overrides };
}

function runtimeFor(server: McpServerConfig): McpRuntime {
  return new McpRuntime({ trustStore: approvedMcpFixture(), workspacePath: process.cwd(), async loadConfig() { return [server]; } });
}

function schemaTool(name: string, type: "string" | "number" = "string"): Tool {
  return { name, inputSchema: { type: "object" }, outputSchema: { $id: "fixture-shared-id", type: "object", properties: { value: { type } }, required: ["value"] } };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Fixture condition was not reached");
    await delay(10);
  }
}

test("real stdio SDK preserves first-page output validation and hides required-task tools", async (t) => {
  const runtime = runtimeFor(config({ type: "stdio", command: process.execPath, args: ["--import", "tsx", fixturePath, "--stdio", "tools"] }));
  t.after(() => runtime.close());
  const snapshot = await runtime.ensureReady();
  assert.equal(snapshot.servers[0]?.state, "ready");
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), ["mcp__fixture__first", "mcp__fixture__last"]);
  assert.deepEqual(snapshot.servers[0]?.unsupportedTools, [{ name: "task", reason: "Task-based execution is unsupported" }]);
  assert.match(formatMcpStatus(snapshot), /1 unsupported/u);
  assert.match(await runtime.call("mcp__fixture__first", "{}"), /invalid structured content/u);
  assert.equal(JSON.parse(await runtime.call("mcp__fixture__first", '{"value":"correct"}')).structuredContent.value, "correct");
  assert.match(await runtime.call("mcp__fixture__task", "{}"), /unavailable/u);
});

test("real stdio resource-only, prompt-only and instructions-only servers become ready", async (t) => {
  for (const mode of ["resources", "prompts", "instructions"] as const) {
    await t.test(mode, async () => {
      const runtime = runtimeFor(config({ type: "stdio", command: process.execPath, args: ["--import", "tsx", fixturePath, "--stdio", mode] }));
      try {
        const snapshot = await runtime.ensureReady();
        assert.equal(snapshot.servers[0]?.state, "ready");
        assert.match(snapshot.instructions, /without tools/u);
        if (mode === "resources") {
          assert.equal(snapshot.tools.length, 3);
          const templates = JSON.parse(await runtime.call("mcp__fixture__list_resource_templates", "{}"));
          assert.equal(templates.resourceTemplates[0].uriTemplate, "fixture://notes/{name}");
          const resource = JSON.parse(await runtime.call("mcp__fixture__read_resource", '{"uri":"fixture://notes/中文"}'));
          assert.equal(resource.contents[0].text, "你好\r\n  resource");
        } else assert.equal(snapshot.tools.length, mode === "prompts" ? 2 : 0);
      } finally { await runtime.close(); }
    });
  }
});

test("real HTTP discovery publishes complete metadata and retains it through failed refresh", async (t) => {
  let first = schemaTool("first");
  let failSecond = false;
  let calls = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const fixture = await startHttpProtocolFixture({
    async listTools(cursor) {
      if (cursor) {
        if (failSecond) throw new Error("second page failed");
        return { tools: [schemaTool("last", "number")] };
      }
      return { tools: [first], nextCursor: "next" };
    },
    async callTool(_name, args) {
      calls++;
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      return { content: [{ type: "text", text: "text" }], structuredContent: { value: args.value } };
    },
  });
  const runtime = runtimeFor(config({ type: "streamable_http", url: fixture.url }));
  t.after(async () => { release?.(); await runtime.close(); await fixture.close(); });
  const initial = await runtime.ensureReady();
  assert.equal(initial.servers[0]?.state, "ready");
  const binding = initial.toolInfo?.find((tool) => tool.toolName === "first")?.binding;
  assert.ok(binding);
  assert.match(await runtime.call("mcp__fixture__first", '{"value":42}'), /invalid structured content/u);
  assert.match(await runtime.call("mcp__fixture__last", '{"value":"wrong"}'), /invalid structured content/u);
  hold = true;
  const pending = runtime.call("mcp__fixture__first", '{"value":"old definition"}', binding);
  await until(() => Boolean(release));
  first = schemaTool("first", "number");
  await fixture.notifyTools();
  await until(() => runtime.toolInfo("mcp__fixture__first")?.binding !== binding);
  const changed = runtime.toolInfo("mcp__fixture__first")?.binding;
  assert.ok(changed);
  release?.();
  hold = false;
  assert.equal(JSON.parse(await pending).structuredContent.value, "old definition");
  const beforeRejectedCall = calls;
  assert.match(await runtime.call("mcp__fixture__first", '{"value":42}', binding), /binding is stale/u);
  assert.equal(calls, beforeRejectedCall);
  first = schemaTool("first");
  failSecond = true;
  await fixture.notifyTools();
  await until(() => Boolean(runtime.snapshot().servers[0]?.detail?.includes("using previous catalog")));
  assert.equal(runtime.toolInfo("mcp__fixture__first")?.binding, changed);
  assert.equal(JSON.parse(await runtime.call("mcp__fixture__first", '{"value":42}', changed)).structuredContent.value, 42);
  assert.match(await runtime.call("mcp__fixture__first", '{"value":"wrong"}', changed), /invalid structured content/u);
  failSecond = false;
  first = { ...schemaTool("first", "number"), execution: { taskSupport: "optional" } };
  await fixture.notifyTools();
  await until(() => runtime.toolInfo("mcp__fixture__first")?.binding !== changed);
  const optional = runtime.toolInfo("mcp__fixture__first")?.binding;
  assert.ok(optional);
  first = { ...first, execution: { taskSupport: "required" } };
  await fixture.notifyTools();
  await until(() => !runtime.toolInfo("mcp__fixture__first"));
  assert.equal(runtime.snapshot().servers[0]?.unsupportedTools?.[0]?.name, "first");
  const beforeRequired = calls;
  assert.match(await runtime.call("mcp__fixture__first", '{"value":42}', optional), /unavailable/u);
  assert.equal(calls, beforeRequired);
});

test("real HTTP resource pages preserve empty-page cursors and reject oversized pages without skipping items", async (t) => {
  const cursors: Array<string | undefined> = [];
  let page: ListResourcesResult = { resources: [], nextCursor: "下一页 with space" };
  const fixture = await startHttpProtocolFixture({
    capabilities: { resources: {}, prompts: {} },
    async listResources(cursor) { cursors.push(cursor); return page; },
    async listTemplates(cursor) { return { resourceTemplates: [], nextCursor: cursor ?? "template-next" }; },
    async listPrompts(cursor) { return cursor ? { prompts: [{ name: "next" }] } : { prompts: [], nextCursor: "prompts-next" }; },
  });
  const runtime = runtimeFor(config({ type: "streamable_http", url: fixture.url }));
  t.after(async () => { await runtime.close(); await fixture.close(); });
  const snapshot = await runtime.ensureReady();
  assert.equal(snapshot.servers[0]?.state, "ready");
  assert.equal(cursors.length, 0, "capability discovery must not request resource contents");
  const first = JSON.parse(await runtime.call("mcp__fixture__list_resources", "{}"));
  assert.deepEqual(first.resources, []);
  assert.equal(first.next_cursor, "下一页 with space");
  page = { resources: [{ name: "中文", uri: "fixture://中文/with space" }] };
  const next = JSON.parse(await runtime.call("mcp__fixture__list_resources", JSON.stringify({ cursor: first.next_cursor })));
  assert.equal(next.resources[0].name, "中文");
  assert.deepEqual(cursors, [undefined, "下一页 with space"]);
  assert.equal(JSON.parse(await runtime.call("mcp__fixture__list_prompts", "{}")).next_cursor, "prompts-next");
  assert.equal(JSON.parse(await runtime.call("mcp__fixture__list_resource_templates", "{}")).next_cursor, "template-next");
  assert.match(await runtime.call("mcp__fixture__list_resource_templates", '{"cursor":"same"}'), /repeated/u);
  for (const resources of [
    Array.from({ length: 1_001 }, (_, index) => ({ name: String(index), uri: `fixture://${index}` })),
    [{ name: "large", uri: "fixture://large", description: "界".repeat(350_000) }],
  ]) {
    page = { resources, nextCursor: "would-skip-data" };
    const limited = JSON.parse(await runtime.call("mcp__fixture__list_resources", "{}"));
    assert.equal(limited.code, "range_error");
    assert.equal(limited.incomplete, true);
    assert.equal(limited.next_cursor, undefined);
    assert.equal(limited.resources, undefined);
  }
});

test("real HTTP session expiry reconnects for later calls and never replays the interrupted call", async (t) => {
  let calls = 0;
  const fixture = await startHttpProtocolFixture({
    async listTools() { return { tools: [{ name: "ping", inputSchema: { type: "object" } }] }; },
    async callTool() { calls++; return { content: [{ type: "text", text: "pong" }] }; },
  });
  const runtime = runtimeFor(config({ type: "streamable_http", url: fixture.url }));
  t.after(async () => { await runtime.close(); await fixture.close(); });
  const first = await runtime.ensureReady();
  const binding = first.toolInfo?.[0]?.binding;
  assert.ok(binding);
  assert.match(await runtime.call("mcp__fixture__ping", "{}", binding), /pong/u);
  await fixture.expireSessions();
  const interrupted = JSON.parse(await runtime.call("mcp__fixture__ping", "{}", binding));
  assert.equal(interrupted.status, "error");
  await until(() => runtime.snapshot().servers[0]?.state === "ready" && runtime.toolInfo("mcp__fixture__ping")?.binding !== binding);
  assert.equal(calls, 1);
  assert.match(await runtime.call("mcp__fixture__ping", "{}", binding), /binding is stale/u);
  assert.equal(calls, 1);
  assert.match(await runtime.call("mcp__fixture__ping", "{}"), /pong/u);
  assert.equal(calls, 2);
});

test("real HTTP user cancellation and call timeout keep the current connection and never replay", async (t) => {
  let calls = 0;
  const releases: Array<() => void> = [];
  const fixture = await startHttpProtocolFixture({
    async listTools() { return { tools: [{ name: "wait", inputSchema: { type: "object" } }] }; },
    async callTool(_name, _args, signal) {
      calls++;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { content: [] };
    },
  });
  const runtime = runtimeFor(config({ type: "streamable_http", url: fixture.url }, { tool_timeout_sec: 0.15 }));
  t.after(async () => { releases.forEach((release) => release()); await runtime.close(); await fixture.close(); });
  const snapshot = await runtime.ensureReady();
  const binding = snapshot.toolInfo?.[0]?.binding;
  const controller = new AbortController();
  const cancelled = runtime.call("mcp__fixture__wait", "{}", controller.signal);
  await until(() => calls === 1);
  controller.abort(new Error("user cancellation"));
  await assert.rejects(cancelled, /user cancellation/u);
  const timedOut = JSON.parse(await runtime.call("mcp__fixture__wait", "{}"));
  assert.equal(timedOut.status, "error");
  assert.match(timedOut.error, /timed out/iu);
  assert.equal(calls, 2);
  assert.equal(runtime.toolInfo("mcp__fixture__wait")?.binding, binding);
  assert.equal(runtime.snapshot().servers[0]?.state, "ready");
});

test("real HTTP projects resource and prompt binary blocks while preserving text and metadata", async (t) => {
  const payload = Buffer.from("unique binary payload").toString("base64");
  const fixture = await startHttpProtocolFixture({
    capabilities: { resources: {}, prompts: {} },
    async readResource(uri) { return { contents: [{ uri, text: "中文\r\n  indented", mimeType: "text/plain" }, { uri, mimeType: "application/octet-stream", blob: payload }] }; },
    async getPrompt() { return { messages: [{ role: "user", content: { type: "image", mimeType: "image/png", data: payload } }, { role: "user", content: { type: "audio", mimeType: "audio/wav", data: payload } }] }; },
  });
  const runtime = runtimeFor(config({ type: "streamable_http", url: fixture.url }));
  t.after(async () => { await runtime.close(); await fixture.close(); });
  await runtime.ensureReady();
  const resourceText = await runtime.call("mcp__fixture__read_resource", '{"uri":"fixture://binary"}');
  const resource = JSON.parse(resourceText);
  assert.equal(resource.contents[0].text, "中文\r\n  indented");
  assert.equal(resource.contents[1].uri, "fixture://binary");
  assert.match(resource.contents[1].blob, /binary content unavailable/u);
  const prompt = await runtime.call("mcp__fixture__get_prompt", '{"name":"binary"}');
  assert.match(prompt, /image\/png/u);
  assert.match(prompt, /audio\/wav/u);
  assert.equal(resourceText.includes(payload), false);
  assert.equal(prompt.includes(payload), false);
});

test("MCP result retention bounds its JSON envelope including Unicode and escapes", () => {
  const retained = serializeMcpResult({ content: [{ type: "text", text: '中文😀\r\n"\\'.repeat(150_000) }] });
  assert.ok(Buffer.byteLength(retained, "utf8") <= MAX_MCP_RESULT_BYTES);
  assert.equal(JSON.parse(retained).status, "truncated");
});

test("real HTTP preserves schema-validated business content and metadata outside protocol binary positions", async (t) => {
  const business = { blob: "git-object-id", nested: { type: "image", data: "chart-record-id" } };
  const payload = Buffer.from("protocol image only").toString("base64");
  const fixture = await startHttpProtocolFixture({
    async listTools() { return { tools: [{ name: "business", inputSchema: { type: "object" }, outputSchema: {
      type: "object", properties: { blob: { const: business.blob }, nested: { const: business.nested } }, required: ["blob", "nested"],
    } }] }; },
    async callTool() { return { structuredContent: business, _meta: business, content: [
      { type: "image", mimeType: "image/png", data: payload, _meta: business },
      { type: "resource", resource: { uri: "fixture://binary", blob: payload, _meta: business }, _meta: business },
      { type: "resource", resource: { uri: "fixture://text", text: JSON.stringify(business), _meta: business } },
    ] }; },
  });
  const runtime = runtimeFor(config({ type: "streamable_http", url: fixture.url }));
  t.after(async () => { await runtime.close(); await fixture.close(); });
  await runtime.ensureReady();
  const output = JSON.parse(await runtime.call("mcp__fixture__business", "{}"));
  assert.deepEqual(output.structuredContent, business);
  assert.deepEqual(output._meta, business);
  assert.deepEqual(output.content[0]._meta, business);
  assert.deepEqual(output.content[1]._meta, business);
  assert.deepEqual(output.content[1].resource._meta, business);
  assert.match(output.content[0].data, /binary content unavailable/u);
  assert.match(output.content[1].resource.blob, /binary content unavailable/u);
  assert.equal(output.content[2].resource.text, JSON.stringify(business));
});

test("MCP list envelopes attribute the real server and preserve only the wire cursor", () => {
  const page = JSON.parse(serializeMcpPage("trusted-name", "resources", {
    resources: [{ uri: "fixture://metadata", name: "metadata", _meta: { blob: "git-object-id" } }],
    _meta: { type: "image", data: "chart-record-id" }, server: "forged", status: "error", next_cursor: "forged cursor",
  }));
  assert.equal(page.server, "trusted-name");
  assert.equal(page.status, "ok");
  assert.equal(page.next_cursor, undefined);
  assert.deepEqual(page._meta, { type: "image", data: "chart-record-id" });
  assert.deepEqual(page.resources[0]._meta, { blob: "git-object-id" });
});
test("MCP client advertises the workspace as its single root to a real HTTP server", async (t) => {
  const fixture = await startHttpProtocolFixture({});
  const workspace = process.cwd();
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: workspace,
    async loadConfig() { return [config({ type: "streamable_http", url: fixture.url })]; },
  });
  t.after(async () => { await runtime.close(); await fixture.close(); });
  const snapshot = await runtime.ensureReady();
  assert.equal(snapshot.servers[0]?.state, "ready");
  const server = [...fixture.servers][0];
  assert.ok(server);
  const roots = await server.listRoots();
  assert.equal(roots.roots.length, 1);
  const expected = pathToFileURL(resolve(workspace)).href;
  assert.equal(roots.roots[0]?.uri, expected);
  assert.equal(roots.roots[0]?.name, "workspace");
});