import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedMcpFixture } from "../../fixtures/mcp-trust.js";
import { windowsNativeSkip } from "../../fixtures/native-mode.js";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  formatMcpStatus,
  McpPermanentConnectionError,
  McpRuntime,
  type McpClientFactoryContext,
  type McpRuntimeClock,
  type McpServerConfig,
} from "../../../src/mcp/runtime.js";

interface FakeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: { taskSupport: "optional" | "required" | "forbidden" };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

class FakeClock implements McpRuntimeClock {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.#now; }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }

  advance(delayMs: number): void {
    const target = this.#now + delayMs;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].at;
      next[1].callback();
    }
    this.#now = target;
  }

  pending(): number { return this.#timers.size; }
}

class FakeMcpClient {
  listToolsCalls = 0;
  callToolCalls = 0;
  closeCalls = 0;
  instructions = "";
  listToolsImpl: (cursor: string | undefined) => Promise<{ tools: FakeTool[]; nextCursor?: string }>;
  callToolImpl: (...args: unknown[]) => Promise<unknown> = async () => ({ content: [{ type: "text", text: "ok" }] });
  closeImpl: () => Promise<void> = async () => undefined;

  constructor(tools: FakeTool[] = [fakeTool("ping")]) {
    this.listToolsImpl = async () => ({ tools });
  }

  async listTools(params?: { cursor?: string }) {
    this.listToolsCalls++;
    return this.listToolsImpl(params?.cursor);
  }

  async listResources() { throw new Error("Resources unsupported"); }
  async listPrompts() { throw new Error("Prompts unsupported"); }
  async readResource() { return { contents: [] }; }
  async getPrompt() { return { messages: [] }; }

  async callTool(...args: unknown[]) {
    this.callToolCalls++;
    return this.callToolImpl(...args);
  }

  getInstructions() { return this.instructions; }
  getServerCapabilities() { return { tools: {} }; }

  async request(request: { method: string; params?: Record<string, unknown> }, _schema: unknown, options?: unknown) {
    if (request.method === "tools/list") return this.listTools(request.params as { cursor?: string } | undefined);
    if (request.method === "tools/call") return this.callTool(request.params, undefined, options);
    throw new Error(`Unexpected request: ${request.method}`);
  }

  async close() {
    this.closeCalls++;
    return this.closeImpl();
  }
}

function fakeTool(name: string, overrides: Partial<FakeTool> = {}): FakeTool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("MCP fixture did not reach the expected state");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 4; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}

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

test("MCP runtime discovers namespaced stdio tools, instructions, and calls", { skip: windowsNativeSkip() }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "everpeace-mcp-discovery-"));
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: workspace,
    version: "test",
    async loadConfig() { return [config()]; },
  });
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });

  const snapshot = await runtime.refresh();
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), [
    "mcp__test_server__ping",
    "mcp__test_server__list_resources",
    "mcp__test_server__list_resource_templates",
    "mcp__test_server__read_resource",
    "mcp__test_server__list_prompts",
    "mcp__test_server__get_prompt",
  ], JSON.stringify(snapshot.servers));
  assert.match(snapshot.instructions, /Use ping/u);
  assert.match(formatMcpStatus(snapshot), /test_server · stdio · ready · 6 tools/u);
  assert.deepEqual(runtime.toolInfo("mcp__test_server__ping")?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
  });

  const output = JSON.parse(await runtime.call("mcp__test_server__ping", "{}")) as {
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(output.content[0]?.text, "pong");
  const resource = JSON.parse(await runtime.call("mcp__test_server__read_resource", JSON.stringify({ uri: "test://notes" }))) as { contents: Array<{ text?: string }> };
  assert.equal(resource.contents[0]?.text, "resource-value");
  const prompt = JSON.parse(await runtime.call("mcp__test_server__get_prompt", JSON.stringify({ name: "greeting" }))) as { messages: Array<{ content?: { text?: string } }> };
  assert.equal(prompt.messages[0]?.content?.text, "prompt-value");
});

test("MCP runtime respects Codex enabled tools and isolates server failures", { skip: windowsNativeSkip() }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "everpeace-mcp-filtered-"));
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: workspace,
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
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });

  const snapshot = await runtime.refresh();
  assert.equal(snapshot.tools.length, 0);
  assert.equal(snapshot.servers.find((server) => server.name === "filtered")?.state, "ready", JSON.stringify(snapshot.servers));
  assert.equal(snapshot.servers.find((server) => server.name === "broken")?.state, "failed");
  assert.equal(snapshot.servers.find((server) => server.name === "off")?.state, "disabled");
});

test("MCP snapshot binds approval metadata and atomically replaces changed tools", async (t) => {
  const clock = new FakeClock();
  const client = new FakeMcpClient([
    fakeTool("write", { annotations: { readOnlyHint: true, destructiveHint: false } }),
  ]);
  let context: McpClientFactoryContext | undefined;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_server, value) {
      context = value;
      return client as never;
    },
  });
  t.after(() => runtime.close());

  const first = await runtime.refresh();
  const firstInfo = first.toolInfo?.[0];
  assert.ok(firstInfo?.binding);
  assert.deepEqual(firstInfo.annotations, { readOnlyHint: true, destructiveHint: false });

  client.listToolsImpl = async () => ({
    tools: [fakeTool("write", { annotations: { readOnlyHint: false, destructiveHint: true } })],
  });
  context?.onToolsChanged();
  context?.onToolsChanged();
  clock.advance(49);
  await flushAsync();
  assert.equal(client.listToolsCalls, 1);
  assert.equal(runtime.snapshot().toolInfo?.[0]?.binding, firstInfo.binding);

  clock.advance(1);
  await flushAsync();
  const changed = runtime.snapshot();
  const changedInfo = changed.toolInfo?.[0];
  assert.equal(client.listToolsCalls, 2);
  assert.ok(changedInfo?.binding);
  assert.notEqual(changedInfo.binding, firstInfo.binding);
  assert.deepEqual(changedInfo.annotations, { readOnlyHint: false, destructiveHint: true });
  assert.match(await runtime.call(changed.tools[0]!.name, "{}", firstInfo.binding), /binding is stale/u);
  assert.equal(client.callToolCalls, 0);

  client.listToolsImpl = async () => { throw new Error("temporary list failure"); };
  context?.onToolsChanged();
  clock.advance(50);
  await flushAsync();
  const retained = runtime.snapshot();
  assert.equal(retained.toolInfo?.[0]?.binding, changedInfo.binding);
  assert.match(retained.servers[0]?.detail ?? "", /using previous catalog/u);
});

test("MCP disconnect removes tools, does not replay calls, and reconnects with a new binding", async (t) => {
  const clock = new FakeClock();
  const clients = [new FakeMcpClient(), new FakeMcpClient()];
  const contexts: McpClientFactoryContext[] = [];
  let factories = 0;
  let rejectCall: ((error: Error) => void) | undefined;
  clients[0]!.callToolImpl = () => new Promise((_, reject) => { rejectCall = reject; });
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_server, context) {
      contexts.push(context);
      return clients[factories++] as never;
    },
  });
  t.after(() => runtime.close());

  const first = await runtime.refresh();
  const name = first.tools[0]!.name;
  const binding = first.toolInfo?.[0]?.binding;
  assert.ok(binding);
  const inFlight = runtime.call(name, "{}", binding);
  await until(() => clients[0]!.callToolCalls === 1);
  assert.equal(clients[0]!.callToolCalls, 1);

  contexts[0]!.onClose();
  rejectCall?.(new Error("connection closed during call"));
  await flushAsync();
  assert.equal(runtime.snapshot().tools.length, 0);
  assert.equal(runtime.snapshot().servers[0]?.state, "reconnecting");
  assert.match(await inFlight, /connection closed during call/u);
  assert.equal(clients[0]!.callToolCalls, 1);

  clock.advance(499);
  await flushAsync();
  assert.equal(factories, 1);
  clock.advance(1);
  await until(() => runtime.snapshot().servers[0]?.state === "ready");
  const reconnected = runtime.snapshot();
  assert.equal(factories, 2);
  assert.equal(reconnected.servers[0]?.state, "ready");
  assert.notEqual(reconnected.toolInfo?.[0]?.binding, binding);
  assert.match(await runtime.call(name, "{}", binding), /binding is stale/u);
  assert.equal(clients[1]!.callToolCalls, 0);
});

test("MCP retry budget exhausts after ten attempts and permanent errors do not retry", async () => {
  const clock = new FakeClock();
  let attempts = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory() {
      attempts++;
      throw new Error("transient transport failure");
    },
  });
  await runtime.refresh();
  assert.equal(runtime.snapshot().servers[0]?.state, "reconnecting");
  const delays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000];
  for (const [index, delay] of delays.entries()) {
    clock.advance(delay);
    await until(() => attempts === index + 2 && runtime.snapshot().servers[0]?.state !== "connecting");
  }
  assert.equal(attempts, 11);
  assert.equal(runtime.snapshot().servers[0]?.state, "failed");
  assert.match(runtime.snapshot().servers[0]?.detail ?? "", /attempts exhausted/u);
  assert.equal(clock.pending(), 0);
  await runtime.close();

  const permanentClock = new FakeClock();
  let permanentAttempts = 0;
  const permanent = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock: permanentClock,
    async loadConfig() { return [config()]; },
    async clientFactory() {
      permanentAttempts++;
      throw new McpPermanentConnectionError("invalid authentication configuration");
    },
  });
  await permanent.refresh();
  assert.equal(permanentAttempts, 1);
  assert.equal(permanent.snapshot().servers[0]?.state, "failed");
  assert.equal(permanentClock.pending(), 0);
  await permanent.close();
});

test("MCP authentication and unsupported HTTP configuration fail without connecting or retrying", async () => {
  const configs: McpServerConfig[] = [
    config({ name: "auth", auth_status: "unauthorized" }),
    config({
      name: "helper",
      transport: {
        type: "streamable_http",
        url: "https://example.invalid/mcp",
        http_headers_helper: "credential-helper",
      },
    }),
    config({
      name: "missing_token",
      transport: {
        type: "streamable_http",
        url: "https://example.invalid/mcp",
        bearer_token_env_var: "EVERPEACE_TEST_MISSING_MCP_TOKEN_75391",
      },
    }),
  ];
  const clock = new FakeClock();
  let factories = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return configs; },
    async clientFactory() {
      factories++;
      return new FakeMcpClient() as never;
    },
  });
  const snapshot = await runtime.refresh();
  assert.equal(factories, 0);
  assert.ok(snapshot.servers.every((server) => server.state === "failed"));
  assert.match(snapshot.servers.find((server) => server.name === "auth")?.detail ?? "", /authentication is unavailable/u);
  assert.match(snapshot.servers.find((server) => server.name === "helper")?.detail ?? "", /not supported/u);
  assert.match(snapshot.servers.find((server) => server.name === "missing_token")?.detail ?? "", /environment variable is missing/u);
  assert.equal(clock.pending(), 0);
  await runtime.close();
});

test("MCP reconnect backoff resets only after thirty stable seconds", async (t) => {
  const clock = new FakeClock();
  const contexts: McpClientFactoryContext[] = [];
  const clients = [new FakeMcpClient(), new FakeMcpClient(), new FakeMcpClient()];
  let attempts = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_server, context) {
      contexts.push(context);
      const attempt = attempts++;
      if (attempt === 0) throw new Error("first connection failed");
      return clients[attempt - 1] as never;
    },
  });
  t.after(() => runtime.close());

  await runtime.refresh();
  assert.match(runtime.snapshot().servers[0]?.detail ?? "", /500 ms/u);
  clock.advance(500);
  await until(() => runtime.snapshot().servers[0]?.state === "ready");
  assert.equal(runtime.snapshot().servers[0]?.state, "ready");

  contexts[1]!.onClose();
  await flushAsync();
  assert.match(runtime.snapshot().servers[0]?.detail ?? "", /1000 ms/u);
  clock.advance(999);
  await flushAsync();
  assert.equal(attempts, 2);
  clock.advance(1);
  await until(() => runtime.snapshot().servers[0]?.state === "ready");
  assert.equal(attempts, 3);
  assert.equal(runtime.snapshot().servers[0]?.state, "ready");

  clock.advance(29_999);
  contexts[2]!.onClose();
  await flushAsync();
  assert.match(runtime.snapshot().servers[0]?.detail ?? "", /2000 ms/u);

  clock.advance(2_000);
  await until(() => runtime.snapshot().servers[0]?.state === "ready");
  assert.equal(runtime.snapshot().servers[0]?.state, "ready");
  clock.advance(30_000);
  await flushAsync();
  contexts[3]!.onClose();
  await flushAsync();
  assert.match(runtime.snapshot().servers[0]?.detail ?? "", /500 ms/u);
});

test("MCP business errors, request timeouts, and cancellation do not reconnect", async (t) => {
  const clock = new FakeClock();
  const client = new FakeMcpClient();
  let factories = 0;
  let phase: "business" | "timeout" | "cancel" = "business";
  let observedTimeout: number | undefined;
  client.callToolImpl = async (...args) => {
    const options = args[2] as { timeout?: number; signal?: AbortSignal } | undefined;
    observedTimeout = options?.timeout;
    if (phase === "business") throw new Error("tool rejected the request");
    if (phase === "timeout") throw new Error("MCP request timed out");
    return await new Promise((_, reject) => {
      const signal = options?.signal;
      const cancel = () => reject(signal?.reason ?? new Error("cancelled"));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
    });
  };
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config({ tool_timeout_sec: 0.001 })]; },
    async clientFactory() {
      factories++;
      return client as never;
    },
  });
  t.after(() => runtime.close());

  const snapshot = await runtime.refresh();
  const name = snapshot.tools[0]!.name;
  const binding = snapshot.toolInfo?.[0]?.binding;
  assert.ok(binding);
  assert.match(await runtime.call(name, "{}", binding), /tool rejected the request/u);
  phase = "timeout";
  assert.match(await runtime.call(name, "{}", binding), /request timed out/u);
  assert.equal(observedTimeout, 1);

  phase = "cancel";
  const controller = new AbortController();
  const cancelled = runtime.call(name, "{}", binding, controller.signal);
  await flushAsync();
  controller.abort(new Error("cancelled by user"));
  await assert.rejects(cancelled, /cancelled by user/u);
  clock.advance(10_000);
  await flushAsync();
  assert.equal(factories, 1);
  assert.equal(runtime.snapshot().servers[0]?.state, "ready");
  assert.equal(runtime.snapshot().toolInfo?.[0]?.binding, binding);
});

test("MCP streamable HTTP recovery is isolated from another ready server", async (t) => {
  const clock = new FakeClock();
  const alpha = new FakeMcpClient([fakeTool("alpha")]);
  const beta = new FakeMcpClient([fakeTool("beta")]);
  const contexts = new Map<string, McpClientFactoryContext[]>();
  let betaAttempts = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() {
      return [
        config({ name: "stdio_server" }),
        config({
          name: "http_server",
          transport: { type: "streamable_http", url: "http://127.0.0.1:43123/mcp" },
        }),
      ];
    },
    async clientFactory(server, context) {
      contexts.set(server.name, [...(contexts.get(server.name) ?? []), context]);
      if (server.name === "http_server" && betaAttempts++ === 0) {
        throw new Error("HTTP transport disconnected");
      }
      return (server.name === "stdio_server" ? alpha : beta) as never;
    },
  });
  t.after(() => runtime.close());

  const first = await runtime.refresh();
  assert.deepEqual(first.tools.map((tool) => tool.name), ["mcp__stdio_server__alpha"]);
  assert.equal(first.servers.find((server) => server.name === "stdio_server")?.state, "ready");
  assert.equal(first.servers.find((server) => server.name === "http_server")?.state, "reconnecting");
  const alphaBinding = first.toolInfo?.find((info) => info.serverName === "stdio_server")?.binding;

  clock.advance(500);
  await until(() => runtime.snapshot().servers.find((server) => server.name === "http_server")?.state === "ready");
  const recovered = runtime.snapshot();
  assert.deepEqual(recovered.tools.map((tool) => tool.name).sort(), [
    "mcp__http_server__beta",
    "mcp__stdio_server__alpha",
  ]);
  assert.equal(recovered.toolInfo?.find((info) => info.serverName === "stdio_server")?.binding, alphaBinding);
  contexts.get("http_server")?.[1]?.onClose();
  await flushAsync();
  const disconnected = runtime.snapshot();
  assert.deepEqual(disconnected.tools.map((tool) => tool.name), ["mcp__stdio_server__alpha"]);
  assert.equal(disconnected.servers.find((server) => server.name === "stdio_server")?.state, "ready");
  assert.equal(disconnected.servers.find((server) => server.name === "http_server")?.state, "reconnecting");
});

test("MCP tool-change storms coalesce and a failed paged refresh keeps the complete old catalog", async (t) => {
  const clock = new FakeClock();
  const client = new FakeMcpClient([fakeTool("stable")]);
  let context: McpClientFactoryContext | undefined;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_server, value) {
      context = value;
      return client as never;
    },
  });
  t.after(() => runtime.close());

  const first = await runtime.refresh();
  const oldBinding = first.toolInfo?.[0]?.binding;
  let refreshes = 0;
  let releaseFirstPage!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
  client.listToolsImpl = async (cursor) => {
    if (cursor) throw new Error("second discovery page failed");
    refreshes++;
    if (refreshes === 1) {
      markStarted();
      await firstPageGate;
      return { tools: [fakeTool("replacement")], nextCursor: "page-2" };
    }
    return { tools: [fakeTool("stable")] };
  };

  for (let index = 0; index < 25; index++) context?.onToolsChanged();
  clock.advance(50);
  await started;
  for (let index = 0; index < 25; index++) context?.onToolsChanged();
  releaseFirstPage();
  await flushAsync();
  const retained = runtime.snapshot();
  assert.equal(retained.toolInfo?.[0]?.binding, oldBinding);
  assert.deepEqual(retained.tools.map((tool) => tool.name), ["mcp__test_server__stable"]);
  assert.match(retained.servers[0]?.detail ?? "", /second discovery page failed/u);
  assert.equal(refreshes, 1);

  clock.advance(49);
  await flushAsync();
  assert.equal(refreshes, 1);
  clock.advance(1);
  await flushAsync();
  assert.equal(refreshes, 2);
  assert.equal(client.listToolsCalls, 4);
  assert.equal(runtime.snapshot().toolInfo?.[0]?.binding, oldBinding);
  assert.equal(runtime.snapshot().servers[0]?.detail, undefined);
});

test("MCP refresh isolates late close notifications from the replacement connection", async (t) => {
  const clock = new FakeClock();
  const contexts: McpClientFactoryContext[] = [];
  const clients = [new FakeMcpClient(), new FakeMcpClient()];
  let nextClient = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_server, context) {
      contexts.push(context);
      return clients[nextClient++] as never;
    },
  });
  t.after(() => runtime.close());

  const first = await runtime.refresh();
  const oldBinding = first.toolInfo?.[0]?.binding;
  assert.ok(oldBinding);
  const second = await runtime.refresh();
  assert.equal(nextClient, 2);
  assert.notEqual(second.toolInfo?.[0]?.binding, oldBinding);

  contexts[0]!.onClose();
  contexts[0]!.onToolsChanged();
  clock.advance(50);
  await flushAsync();
  assert.equal(runtime.snapshot().servers[0]?.state, "ready");
  assert.equal(runtime.snapshot().toolInfo?.[0]?.binding, second.toolInfo?.[0]?.binding);
  assert.equal(clients[1]!.listToolsCalls, 1);
});

test("MCP discovery rejects repeated cursors without publishing a partial catalog", async () => {
  const client = new FakeMcpClient();
  client.listToolsImpl = async (cursor) => cursor
    ? { tools: [fakeTool("second")], nextCursor: "repeat" }
    : { tools: [fakeTool("first")], nextCursor: "repeat" };
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    async loadConfig() { return [config()]; },
    async clientFactory() { return client as never; },
  });
  const snapshot = await runtime.refresh();
  assert.equal(snapshot.tools.length, 0);
  assert.equal(snapshot.servers[0]?.state, "failed");
  assert.match(snapshot.servers[0]?.detail ?? "", /repeated cursor/u);
  assert.equal(client.listToolsCalls, 2);
  await runtime.close();
});

test("MCP discovery enforces page, tool, byte, and duplicate-name limits", async () => {
  const cases: Array<{
    label: string;
    configure(client: FakeMcpClient): void;
    expected: RegExp;
    calls?: number;
  }> = [
    {
      label: "pages",
      configure(client) {
        client.listToolsImpl = async (cursor) => {
          const page = cursor === undefined ? 0 : Number(cursor);
          return { tools: [fakeTool(`page_${page}`)], nextCursor: String(page + 1) };
        };
      },
      expected: /exceeded 100 pages/u,
      calls: 100,
    },
    {
      label: "tools",
      configure(client) {
        client.listToolsImpl = async () => ({
          tools: Array.from({ length: 1_001 }, (_, index) => fakeTool(`tool_${index}`)),
        });
      },
      expected: /exceeded 1000 tools/u,
      calls: 1,
    },
    {
      label: "definition bytes",
      configure(client) {
        client.listToolsImpl = async () => ({
          tools: [fakeTool("oversized", { description: "界".repeat(700_000) })],
        });
      },
      expected: /definitions exceeded 2097152 bytes/u,
      calls: 1,
    },
    {
      label: "duplicate names",
      configure(client) {
        client.listToolsImpl = async (cursor) => cursor
          ? { tools: [fakeTool("duplicate")] }
          : { tools: [fakeTool("duplicate")], nextCursor: "next" };
      },
      expected: /duplicate tool name: duplicate/u,
      calls: 2,
    },
  ];

  for (const discoveryCase of cases) {
    const clock = new FakeClock();
    const client = new FakeMcpClient();
    discoveryCase.configure(client);
    const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
      workspacePath: process.cwd(),
      clock,
      async loadConfig() { return [config({ name: discoveryCase.label })]; },
      async clientFactory() { return client as never; },
    });
    const snapshot = await runtime.refresh();
    assert.equal(snapshot.tools.length, 0, discoveryCase.label);
    assert.equal(snapshot.servers[0]?.state, "failed", discoveryCase.label);
    assert.match(snapshot.servers[0]?.detail ?? "", discoveryCase.expected, discoveryCase.label);
    assert.equal(client.listToolsCalls, discoveryCase.calls, discoveryCase.label);
    assert.equal(clock.pending(), 0, `${discoveryCase.label} must not retry a permanent discovery error`);
    await runtime.close();
  }
});

test("MCP discovery shares one deadline across pages", async (t) => {
  const clock = new FakeClock();
  const client = new FakeMcpClient();
  const timeouts: number[] = [];
  const originalRequest = client.request.bind(client);
  client.request = async (request, schema, options) => {
    timeouts.push((options as { timeout: number }).timeout);
    return originalRequest(request, schema, options);
  };
  client.listToolsImpl = async (cursor) => {
    clock.advance(60);
    return { tools: [fakeTool(cursor ?? "first")], nextCursor: cursor ? "third" : "second" };
  };
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(), clock,
    async loadConfig() { return [config({ startup_timeout_sec: 0.1 })]; },
    async clientFactory() { return client as never; },
  });
  t.after(() => runtime.close());
  const snapshot = await runtime.ensureReady();
  assert.deepEqual(timeouts, [100, 40]);
  assert.equal(snapshot.tools.length, 0);
  assert.match(snapshot.servers[0]?.detail ?? "", /total startup deadline/u);
});

test("MCP discovery preserves an opaque empty cursor instead of losing the next page", async (t) => {
  const client = new FakeMcpClient();
  client.listToolsImpl = async (cursor) => cursor === undefined
    ? { tools: [fakeTool("first")], nextCursor: "" }
    : { tools: [fakeTool("second")] };
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    async loadConfig() { return [config()]; },
    async clientFactory() { return client as never; },
  });
  t.after(() => runtime.close());
  const snapshot = await runtime.ensureReady();
  assert.equal(client.listToolsCalls, 2);
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), ["mcp__test_server__first", "mcp__test_server__second"]);
});

test("MCP rejects malformed output schemas before publishing a new directory", async (t) => {
  for (const outputSchema of [
    { type: "object", properties: { value: { type: "invalid-json-schema-type" } } },
    { type: "object", $async: true },
  ]) {
    const clock = new FakeClock();
    const client = new FakeMcpClient([fakeTool("invalid", { outputSchema })]);
    const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
      workspacePath: process.cwd(), clock,
      async loadConfig() { return [config()]; },
      async clientFactory() { return client as never; },
    });
    t.after(() => runtime.close());
    const snapshot = await runtime.ensureReady();
    assert.equal(snapshot.tools.length, 0);
    assert.equal(snapshot.servers[0]?.state, "failed");
    assert.match(snapshot.servers[0]?.detail ?? "", /invalid output schema/u);
  }
});

test("MCP close cancels reconnect timers and ignores late callbacks", async () => {
  const clock = new FakeClock();
  const contexts: McpClientFactoryContext[] = [];
  let factories = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_server, context) {
      factories++;
      contexts.push(context);
      throw new Error("transport unavailable");
    },
  });
  await runtime.refresh();
  assert.equal(runtime.snapshot().servers[0]?.state, "reconnecting");
  await runtime.close();
  contexts[0]?.onClose();
  contexts[0]?.onToolsChanged();
  clock.advance(120_000);
  await flushAsync();
  assert.equal(factories, 1);
  assert.deepEqual(runtime.snapshot().servers, []);
  assert.equal(clock.pending(), 0);
});

test("MCP workspace switch closes a late connection and cannot revive the old workspace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-mcp-switch-"));
  const nextWorkspace = join(directory, "next");
  await mkdir(nextWorkspace);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new FakeClock();
  const contexts: McpClientFactoryContext[] = [];
  const lateClient = new FakeMcpClient([fakeTool("old")]);
  const currentClient = new FakeMcpClient([fakeTool("current")]);
  let factories = 0;
  let releaseLate!: (client: never) => void;
  const lateConnection = new Promise<never>((resolve) => { releaseLate = resolve; });
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: directory,
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_server, context) {
      contexts.push(context);
      factories++;
      if (factories === 1) return lateConnection;
      return currentClient as never;
    },
  });
  t.after(() => runtime.close());

  const loading = runtime.refresh();
  await until(() => factories === 1);
  assert.equal(runtime.snapshot().servers[0]?.state, "connecting");
  const switching = runtime.setWorkspace(nextWorkspace);
  await flushAsync();
  releaseLate(lateClient as never);
  await Promise.all([loading, switching]);
  assert.equal(lateClient.closeCalls, 1);
  contexts[0]?.onClose();
  contexts[0]?.onToolsChanged();
  clock.advance(60_000);
  await flushAsync();
  assert.equal(factories, 1);
  assert.deepEqual(runtime.snapshot().servers, []);

  const current = await runtime.ensureReady();
  assert.equal(factories, 2);
  assert.equal(contexts[1]?.workspacePath, nextWorkspace);
  assert.deepEqual(current.tools.map((tool) => tool.name), ["mcp__test_server__current"]);
});

test("MCP close timeout prevents a replacement connection", async () => {
  const clock = new FakeClock();
  const client = new FakeMcpClient();
  client.closeImpl = () => new Promise(() => undefined);
  let factories = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory() {
      factories++;
      return client as never;
    },
  });
  await runtime.refresh();
  const refreshing = runtime.refresh();
  await flushAsync();
  clock.advance(5_000);
  await flushAsync();
  const snapshot = await refreshing;
  assert.equal(factories, 1);
  assert.equal(snapshot.tools.length, 0);
  assert.equal(snapshot.servers[0]?.state, "failed");
  assert.match(snapshot.servers[0]?.detail ?? "", /did not close within 5 seconds/u);
});

test("MCP disconnect close timeout stops automatic recovery", async () => {
  const clock = new FakeClock();
  const client = new FakeMcpClient();
  client.closeImpl = () => new Promise(() => undefined);
  let context: McpClientFactoryContext | undefined;
  let factories = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_server, value) {
      factories++;
      context = value;
      return client as never;
    },
  });
  await runtime.refresh();
  context?.onClose();
  await flushAsync();
  assert.equal(runtime.snapshot().tools.length, 0);
  clock.advance(5_000);
  await flushAsync();
  assert.equal(runtime.snapshot().servers[0]?.state, "failed");
  assert.match(runtime.snapshot().servers[0]?.detail ?? "", /did not close within 5 seconds/u);
  clock.advance(120_000);
  await flushAsync();
  assert.equal(factories, 1);
});

test("MCP failed initialization waits for its partial client before reconnecting", async (t) => {
  const clock = new FakeClock();
  const partial = new FakeMcpClient();
  let completeClose!: () => void;
  partial.closeImpl = () => new Promise<void>((resolve) => { completeClose = resolve; });
  let factories = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(), clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_config, context) {
      factories++;
      if (factories > 1) return new FakeMcpClient() as never;
      context.onClientCreated?.(partial as never);
      throw new Error("Initialization timed out");
    },
  });
  t.after(() => runtime.close());
  const loading = runtime.ensureReady();
  await until(() => partial.closeCalls === 1);
  assert.equal(partial.closeCalls, 1);
  clock.advance(1_000);
  await flushAsync();
  assert.equal(factories, 1);
  completeClose();
  await loading;
  clock.advance(500);
  await until(() => runtime.snapshot().servers[0]?.state === "ready");
  assert.equal(factories, 2);
  assert.equal(runtime.snapshot().servers[0]?.state, "ready");
});

test("MCP failed initialization cannot retry after partial-client close timeout", async () => {
  const clock = new FakeClock();
  const partial = new FakeMcpClient();
  partial.closeImpl = () => new Promise(() => undefined);
  let factories = 0;
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(), clock,
    async loadConfig() { return [config()]; },
    async clientFactory(_config, context) {
      factories++;
      context.onClientCreated?.(partial as never);
      throw new Error("Initialization timed out");
    },
  });
  const loading = runtime.ensureReady();
  await until(() => partial.closeCalls === 1);
  clock.advance(5_000);
  await loading;
  assert.equal(runtime.snapshot().servers[0]?.state, "failed");
  assert.match(runtime.snapshot().servers[0]?.detail ?? "", /did not close within 5 seconds/u);
  clock.advance(120_000);
  await flushAsync();
  assert.equal(factories, 1);
  await assert.rejects(runtime.close(), /cleanup is unresolved/u);
});
