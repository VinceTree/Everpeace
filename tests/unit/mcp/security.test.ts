import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { McpRuntime, type McpServerConfig, type McpClientFactoryContext } from "../../../src/mcp/runtime.js";
import { McpTrustStore } from "../../../src/mcp/trust.js";
import { createMcpHttp } from "../../../src/mcp/http.js";
import { MemoryAuthStorage, approvedMcpFixture } from "../../fixtures/mcp-trust.js";
import { startHttpProtocolFixture } from "../../fixtures/mcp-protocol-fixture.js";

const markerFixture = fileURLToPath(new URL("../../fixtures/mcp-start-marker.mjs", import.meta.url));
const workerFixture = fileURLToPath(new URL("../../fixtures/mcp-trust-worker.ts", import.meta.url));
async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(join(tmpdir(), "everpeace-mcp-security-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const auth = new MemoryAuthStorage();
  const path = join(workspace, "user-state", "mcp-trust.json");
  const store = new McpTrustStore({ path, authStorage: auth });
  const marker = join(workspace, "started.txt");
  const config: McpServerConfig = { name: "marker", enabled: true, transport: { type: "stdio", command: process.execPath, args: [markerFixture, marker], env: { FIXTURE_SECRET: "private-env-value" } } };
  return { workspace, store, auth, path, config, marker };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Security fixture did not settle"); await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
}
async function localServer(t: TestContext, listener: http.RequestListener) {
  const server = http.createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/mcp`;
}

test("untrusted real stdio starts zero processes; explicit approval persists per workspace without credentials", async (t) => {
  const f = await fixture(t);
  const create = (workspacePath = f.workspace) => new McpRuntime({ workspacePath, trustStore: f.store, async loadConfig() { return [f.config]; } });
  let runtime = create(); t.after(() => runtime.close());
  const first = await runtime.ensureReady();
  assert.equal(first.servers[0]?.state, "trust_required"); assert.equal(first.tools.length, 0);
  await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
  const preview = await runtime.previewTrust("marker");
  assert.match(preview.summary, /host user permissions/u);
  assert.ok(!preview.summary.includes("private-env-value"));
  assert.ok(!preview.summary.includes(markerFixture));
  // Viewing or cancelling a preview never creates a startup grant.
  await runtime.refresh(); await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runtime.approveTrust(preview, cancelled.signal));
  assert.equal((await runtime.ensureReady()).servers[0]?.state, "trust_required");
  await runtime.approveTrust(preview);
  assert.equal((await runtime.refresh()).servers[0]?.state, "ready");
  assert.match(await runtime.call("mcp__marker__ping", "{}"), /pong/u);
  const persisted = await fs.readFile(f.path, "utf8");
  assert.ok(!persisted.includes("private-env-value")); assert.ok(!persisted.includes(markerFixture));
  await runtime.close(); runtime = create();
  assert.equal((await runtime.ensureReady()).servers[0]?.state, "ready");
  const other = join(f.workspace, "other"); await fs.mkdir(other);
  await runtime.setWorkspace(other);
  assert.equal((await runtime.ensureReady()).servers[0]?.state, "trust_required");
  assert.equal((await fs.readFile(f.marker, "utf8")).trim().split("\n").length, 2);
});

test("config and inherited environment changes invalidate previews and live bindings", async (t) => {
  const f = await fixture(t);
  let config = f.config;
  const runtime = new McpRuntime({ workspacePath: f.workspace, trustStore: f.store, async loadConfig() { return [config]; } }); t.after(() => runtime.close());
  const preview = await runtime.previewTrust("marker");
  config = { ...config, transport: { ...f.config.transport, type: "stdio", command: process.execPath, env: { FIXTURE_SECRET: "changed-secret" } } };
  await assert.rejects(runtime.approveTrust(preview), /changed/u);
  await runtime.approveTrust(await runtime.previewTrust("marker"));
  const ready = await runtime.refresh(); const binding = ready.toolInfo?.[0]?.binding; assert.ok(binding);
  config = f.config;
  assert.match(await runtime.call("mcp__marker__ping", "{}", binding), /unavailable/u);
  assert.equal(runtime.snapshot().servers[0]?.state, "trust_required");
  assert.equal((await fs.readFile(f.marker, "utf8")).trim().split("\n").length, 1);
  const variable = "EVERPEACE_MCP_INHERITED_FIXTURE"; const before = process.env[variable];
  t.after(() => { if (before === undefined) delete process.env[variable]; else process.env[variable] = before; });
  process.env[variable] = "one";
  config = { ...f.config, transport: { type: "stdio", command: process.execPath, args: [markerFixture, f.marker], env_vars: [variable] } };
  const inherited = await runtime.previewTrust("marker"); process.env[variable] = "two";
  await assert.rejects(runtime.approveTrust(inherited), /changed/u);
});

test("cross-runtime revocation blocks dispatch and reconnect before a client factory runs", async (t) => {
  const f = await fixture(t); let factories = 0; let context: McpClientFactoryContext | undefined;
  const fake = { getInstructions() { return ""; }, getServerCapabilities() { return { tools: {} }; }, async request() { return { tools: [{ name: "ping", inputSchema: { type: "object" } }] }; }, async close() {} };
  const runtime = new McpRuntime({ workspacePath: f.workspace, trustStore: f.store, async loadConfig() { return [f.config]; }, async clientFactory(_config, next) { factories++; context = next; return fake as never; } }); t.after(() => runtime.close());
  await runtime.approveTrust(await runtime.previewTrust("marker"));
  const ready = await runtime.ensureReady(); const binding = ready.toolInfo?.[0]?.binding; assert.ok(binding);
  const secondStore = new McpTrustStore({ path: f.path, authStorage: f.auth });
  await secondStore.revoke((await runtime.previewTrust("marker")).workspace, "marker");
  assert.match(await runtime.call("mcp__marker__ping", "{}", binding), /unavailable/u);
  assert.equal(runtime.snapshot().servers[0]?.state, "trust_required"); assert.equal(factories, 1);
  await runtime.approveTrust(await runtime.previewTrust("marker")); await runtime.refresh();
  context!.onClose();
  await secondStore.revoke((await runtime.previewTrust("marker")).workspace, "marker");
  await until(() => runtime.snapshot().servers[0]?.state === "trust_required");
  assert.equal(factories, 2);
});

test("configuration changes and cancellation during approval commit cannot save stale trust", async (t) => {
  const f = await fixture(t);
  let config = f.config;
  let atCommit = () => {};
  const runtime = new McpRuntime({ workspacePath: f.workspace, trustStore: {
    evaluate: f.store.evaluate.bind(f.store), revoke: f.store.revoke.bind(f.store),
    async grant(identity, signal, beforeCommit) { atCommit(); await f.store.grant(identity, signal, beforeCommit); },
  }, async loadConfig() { return [config]; } });
  t.after(() => runtime.close());
  const preview = await runtime.previewTrust("marker");
  atCommit = () => { config = { ...f.config, transport: { ...f.config.transport, type: "stdio", command: process.execPath, args: [markerFixture, f.marker, "changed"] } }; };
  await assert.rejects(runtime.approveTrust(preview), /changed/u);
  const cancelled = new AbortController();
  atCommit = () => { cancelled.abort(); };
  await assert.rejects(runtime.approveTrust(await runtime.previewTrust("marker"), cancelled.signal));
  assert.equal((await runtime.ensureReady()).servers[0]?.state, "trust_required");
  await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
  const stale = await f.store.evaluate(f.workspace, "other", "mcp_start", {});
  await f.store.revoke(f.workspace, "other");
  await assert.rejects(f.store.grant(stale), /changed/u);
  assert.deepEqual(JSON.parse(await fs.readFile(f.path, "utf8")).grants, []);
});

test("local revoke cancels active calls, invalidates bindings, and blocks a late initialization", async (t) => {
  const f = await fixture(t); let release!: () => void; let factories = 0; let closes = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fake = { getInstructions() { return ""; }, getServerCapabilities() { return { tools: {} }; }, async request(request: { method: string }, _schema: unknown, options?: { signal?: AbortSignal }) {
    if (request.method === "tools/list") return { tools: [{ name: "wait", inputSchema: { type: "object" } }] };
    return new Promise((_, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error("call cancelled")), { once: true }); });
  }, async close() { closes++; } };
  const runtime = new McpRuntime({ workspacePath: f.workspace, trustStore: f.store, async loadConfig() { return [f.config]; }, async clientFactory(_config, context) { factories++; context.onClientCreated?.(fake as never); if (factories === 2) await gate; return fake as never; } }); t.after(() => runtime.close());
  await runtime.approveTrust(await runtime.previewTrust("marker")); await runtime.ensureReady();
  let dispatched = false;
  const original = fake.request.bind(fake);
  fake.request = async (...args) => { if (args[0].method === "tools/call") dispatched = true; return original(...args); };
  const call = runtime.call("mcp__marker__wait", "{}"); await until(() => dispatched);
  await runtime.revokeTrust("marker"); assert.match(await call, /cancelled/u); assert.equal(runtime.snapshot().tools.length, 0);
  await runtime.approveTrust(await runtime.previewTrust("marker"));
  const loading = runtime.refresh(); await until(() => factories === 2);
  await runtime.revokeTrust("marker"); release(); await loading;
  assert.equal(runtime.snapshot().tools.length, 0); assert.ok(closes >= 2);
});

test("corrupt storage and unavailable keyring fail closed without creating a client", async (t) => {
  const f = await fixture(t); let factories = 0;
  await fs.mkdir(join(f.workspace, "user-state")); await fs.writeFile(f.path, "not-json");
  const runtime = new McpRuntime({ workspacePath: f.workspace, trustStore: f.store, async loadConfig() { return [f.config]; }, async clientFactory() { factories++; throw new Error("must not start"); } }); t.after(() => runtime.close());
  assert.equal((await runtime.ensureReady()).servers[0]?.state, "failed"); assert.equal(factories, 0);
  await fs.rm(f.path);
  const failedStore = new McpTrustStore({ path: f.path, authStorage: { async get() { throw new Error("synthetic-secret"); }, async set() {}, async delete() { return false; } } });
  await assert.rejects(failedStore.evaluate(f.workspace, "server", "mcp_start", {}), (error: unknown) => { assert.ok(error instanceof Error); assert.ok(!error.message.includes("synthetic-secret")); return true; });
});

test("independent processes serialize trust updates and reject stale approvals", async (t) => {
  const f = await fixture(t);
  const child = (name: string, action = "grant") => new Promise<void>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--import", "tsx", workerFixture, f.path, f.workspace, name, action], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; process.stderr.on("data", (chunk) => { error += String(chunk); }); process.once("error", reject); process.once("close", (code) => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([child("one"), child("two")]);
  const first = JSON.parse(await fs.readFile(f.path, "utf8")); assert.equal(first.grants.length, 2);
  await Promise.all([child("one", "revoke"), child("three")]);
  const final = JSON.parse(await fs.readFile(f.path, "utf8")); assert.deepEqual(final.grants.map((item: { name: string }) => item.name).sort(), ["three", "two"]);
});

test("non-loopback HTTP and URL credentials fail before any client or credential request", async (t) => {
  const urls = ["http://example.com/mcp", "http://10.0.0.1/mcp", "http://local.example/mcp", "https://user:password@example.com/mcp"];
  const headers: Array<Record<string, string>> = [{}, { Authorization: "Bearer fixture-token" }, { "X-Api-Key": "fixture-token" }];
  for (const url of urls) for (const http_headers of headers) {
    let factories = 0;
    const runtime = new McpRuntime({ workspacePath: process.cwd(), trustStore: approvedMcpFixture(), async loadConfig() { return [{ name: "http", enabled: true, transport: { type: "streamable_http", url, http_headers } }]; }, async clientFactory() { factories++; throw new Error("must not connect"); } });
    t.after(() => runtime.close()); assert.equal((await runtime.ensureReady()).servers[0]?.state, "failed"); assert.equal(factories, 0);
  }
});

test("diagnostics redact environment, flag arguments, header tokens and sensitive endpoint queries", async (t) => {
  const message = "env-secret flag-secret header-secret https://example.invalid/mcp?token=query-secret";
  const transports: McpServerConfig["transport"][] = [
    { type: "stdio", command: process.execPath, args: ["--token=flag-secret"], env: { SECRET: "env-secret" } },
    { type: "streamable_http", url: "https://example.invalid/mcp?token=query-secret", http_headers: { Authorization: "Bearer header-secret" } },
  ];
  for (const transport of transports) {
    const config: McpServerConfig = { name: "privacy", enabled: true, transport };
    const secret = transport.type === "stdio" ? "flag-secret" : "header-secret";
    const fake = { getInstructions() { return ""; }, getServerCapabilities() { return { tools: {} }; }, async request(request: { method: string }) {
      if (request.method === "tools/list") return { tools: [{ name: "fail", inputSchema: { type: "object" } }] };
      throw new Error(message);
    }, async close() {} };
    const runtime = new McpRuntime({ workspacePath: process.cwd(), trustStore: approvedMcpFixture(), async loadConfig() { return [config]; }, async clientFactory() { return fake as never; } });
    t.after(() => runtime.close());
    await runtime.ensureReady();
    const output = await runtime.call("mcp__privacy__fail", "{}");
    assert.ok(!output.includes(secret)); assert.ok(!output.includes("query-secret"));
    if (transport.type === "stdio") assert.ok(!output.includes("env-secret"));
    config.enabled = false; config.disabled_reason = message;
    const detail = (await runtime.refresh()).servers[0]?.detail ?? "";
    assert.ok(!detail.includes(secret)); assert.ok(!detail.includes("query-secret"));
  }
});

test("local HTTP requires its own grant and authentication changes invalidate it", async (t) => {
  const f = await fixture(t); let requests = 0;
  const url = await localServer(t, (_request, response) => { requests++; response.writeHead(403).end(); });
  let config: McpServerConfig = { name: "local", enabled: true, transport: { type: "streamable_http", url, http_headers: { Authorization: "Bearer local-secret", "X-Custom": "header-secret" } } };
  const runtime = new McpRuntime({ workspacePath: f.workspace, trustStore: f.store, async loadConfig() { return [config]; } }); t.after(() => runtime.close());
  assert.equal((await runtime.ensureReady()).servers[0]?.state, "trust_required"); assert.equal(requests, 0);
  const preview = await runtime.previewTrust("local"); assert.equal(preview.kind, "mcp_http"); assert.ok(!preview.summary.includes("local-secret"));
  await runtime.approveTrust(preview); await runtime.refresh(); assert.ok(requests > 0);
  const count = requests;
  config = { ...config, transport: { type: "streamable_http", url, http_headers: { Authorization: "Bearer changed" } } };
  assert.equal((await runtime.refresh()).servers[0]?.state, "trust_required"); assert.equal(requests, count);
  assert.ok(!(await fs.readFile(f.path, "utf8")).includes("local-secret"));
});

test("all redirect responses and HTTP methods close the response without reaching any next hop", async (t) => {
  let targetRequests = 0; const target = await localServer(t, (_request, response) => { targetRequests++; response.end(); });
  let destination = target; let status = 302; const methods: string[] = [];
  const origin = await localServer(t, (request, response) => { methods.push(request.method!); assert.equal(request.headers["x-secret"], "fixture-secret"); response.writeHead(status, { location: destination }); response.end("redirect"); });
  let policyFailures = 0; const client = createMcpHttp(origin, () => { policyFailures++; }); t.after(() => client.close());
  for (const next of [target, origin + "/same-origin", "https://example.invalid/mcp"]) for (const code of [301, 302, 303, 307, 308]) for (const method of ["POST", "GET", "DELETE"]) {
    destination = next; status = code;
    await assert.rejects(client.fetch(origin, { method, headers: { "X-Secret": "fixture-secret" } }), /redirects are blocked/u);
  }
  assert.equal(targetRequests, 0); assert.equal(policyFailures, 45); assert.equal(methods.length, 45);
});

test("SDK initialization redirects retire the server permanently without leaking headers", async (t) => {
  let targetRequests = 0; const target = await localServer(t, (_request, response) => { targetRequests++; response.end(); });
  const origin = await localServer(t, (_request, response) => { response.writeHead(307, { location: target }); response.end(); });
  const runtime = new McpRuntime({ workspacePath: process.cwd(), trustStore: approvedMcpFixture(), async loadConfig() { return [{ name: "redirect", enabled: true, transport: { type: "streamable_http", url: origin, http_headers: { "X-Api-Key": "fixture-secret" } } }]; } }); t.after(() => runtime.close());
  assert.equal((await runtime.ensureReady()).servers[0]?.state, "failed"); assert.equal(targetRequests, 0);
  assert.match(runtime.snapshot().servers[0]?.detail ?? "", /redirect/u);
});

test("trusted HTTPS cannot redirect credentials or any request method to plaintext HTTP", async (t) => {
  let targetRequests = 0;
  const target = await localServer(t, (_request, response) => { targetRequests++; response.end(); });
  const certPath = fileURLToPath(new URL("../../fixtures/public-network/cert.pem", import.meta.url));
  const keyPath = fileURLToPath(new URL("../../fixtures/public-network/key.pem", import.meta.url));
  const methods: string[] = [];
  const server = https.createServer({ cert: await fs.readFile(certPath), key: await fs.readFile(keyPath) }, (request, response) => {
    methods.push(request.method!); assert.equal(request.headers["x-secret"], "fixture-secret");
    response.writeHead(307, { location: target }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const worker = fileURLToPath(new URL("../../fixtures/mcp-https-redirect.ts", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, `https://127.0.0.1:${address.port}/mcp`], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
    });
    let error = ""; child.stderr.on("data", (chunk) => { error += String(chunk); });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(error)));
  });
  assert.deepEqual(methods, ["POST", "GET", "DELETE"]); assert.equal(targetRequests, 0);
});

test("SDK SSE GET uses the guarded fetch even though the SDK omits requestInit for GET", async (t) => {
  let targetRequests = 0; const target = await localServer(t, (_request, response) => { targetRequests++; response.end(); });
  const endpoint = await startHttpProtocolFixture({ listTools: async () => ({ tools: [] }) }); t.after(() => endpoint.close());
  let gets = 0;
  const origin = await localServer(t, (request, response) => {
    if (request.method === "GET") { gets++; assert.equal(request.headers["x-api-key"], "fixture-secret"); response.writeHead(302, { location: target }).end(); return; }
    const outgoing = http.request(endpoint.url, { method: request.method, headers: request.headers }, (incoming) => { response.writeHead(incoming.statusCode ?? 500, incoming.headers); incoming.pipe(response); });
    outgoing.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(outgoing);
  });
  const runtime = new McpRuntime({ workspacePath: process.cwd(), trustStore: approvedMcpFixture(), async loadConfig() { return [{ name: "sse", enabled: true, transport: { type: "streamable_http", url: origin, http_headers: { "X-Api-Key": "fixture-secret" } } }]; } }); t.after(() => runtime.close());
  await runtime.ensureReady(); await until(() => gets > 0 && runtime.snapshot().servers[0]?.state === "failed");
  assert.equal(targetRequests, 0); assert.match(runtime.snapshot().servers[0]?.detail ?? "", /redirect/u);
});

test("localhost HTTP uses fixed loopback connections and HTTPS rejects an untrusted certificate", async (t) => {
  const origin = await localServer(t, (_request, response) => response.end("local"));
  let dnsCalls = 0;
  const lookupMock = t.mock.method(dns, "lookup", () => { dnsCalls++; throw new Error("localhost must not use system DNS"); });
  const local = createMcpHttp(origin.replace("127.0.0.1", "localhost"), () => {}); t.after(() => local.close());
  assert.equal(await (await local.fetch(origin.replace("127.0.0.1", "localhost"))).text(), "local");
  assert.equal(dnsCalls, 0);
  lookupMock.mock.restore();
  let secureRequests = 0;
  const certificate = await fs.readFile(fileURLToPath(new URL("../../fixtures/public-network/cert.pem", import.meta.url)));
  const key = await fs.readFile(fileURLToPath(new URL("../../fixtures/public-network/key.pem", import.meta.url)));
  const server = https.createServer({ cert: certificate, key }, (_request, response) => { secureRequests++; response.end("insecure"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `https://127.0.0.1:${address.port}/mcp`;
  const secure = createMcpHttp(url, () => {}); t.after(() => secure.close());
  await assert.rejects(secure.fetch(url), /request failed/u); assert.equal(secureRequests, 0);
});
