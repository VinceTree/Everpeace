import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { createProviderClient, disposeProviderClient, listOfficialModelIds } from "../../../src/providers/openai-compatible.js";

function environment(t: TestContext, values: Record<string, string>) {
  const names = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"];
  const before = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  t.after(() => { for (const [name, value] of before) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}

async function listen(t: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("model requests use a client-owned environment proxy, with no global fetch mutation", async (t) => {
  let auth = "", requestPath = "", tunnels = 0;
  const target = createServer((req, res) => {
    auth = req.headers.authorization ?? ""; requestPath = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "original-model-id" }] }));
  });
  const targetPort = await listen(t, target);
  const proxy = createServer();
  proxy.on("connect", (req, socket, head) => {
    assert.equal(req.url, "model-fixture.invalid:80");
    tunnels++;
    const upstream = connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  const proxyPort = await listen(t, proxy);
  environment(t, { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
  const originalFetch = globalThis.fetch;
  const client = createProviderClient("http://model-fixture.invalid/v1", "offline-key");
  try {
    assert.deepEqual(await listOfficialModelIds(client), ["original-model-id"]);
    assert.equal(tunnels, 1); assert.equal(auth, "Bearer offline-key"); assert.equal(requestPath, "/v1/models");
    assert.equal(globalThis.fetch, originalFetch);
  } finally { await disposeProviderClient(client); }
  assert.equal(disposeProviderClient(client), disposeProviderClient(client));
  await assert.rejects(client.models.list({ maxRetries: 0 }), /Connection error/);
  assert.equal(tunnels, 1, "a disposed transport cannot reconnect");
});

test("NO_PROXY bypasses a proxy for the configured host and port", async (t) => {
  let requests = 0, tunnels = 0;
  const target = createServer((_req, res) => { requests++; res.setHeader("Content-Type", "application/json"); res.end('{"data":[{"id":"bypassed"}]}'); });
  const port = await listen(t, target);
  const proxy = createServer(); proxy.on("connect", (_req, socket) => { tunnels++; socket.destroy(); });
  const proxyPort = await listen(t, proxy);
  environment(t, { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: `127.0.0.1:${port}` });
  const client = createProviderClient(`http://127.0.0.1:${port}/v1`, "offline-key");
  try { assert.deepEqual(await listOfficialModelIds(client), ["bypassed"]); }
  finally { await disposeProviderClient(client); }
  assert.equal(requests, 1); assert.equal(tunnels, 0);
});

test("HTTPS uses its proxy, lowercase takes precedence, and cancellation closes the pending tunnel", async (t) => {
  let observed!: () => void, tunnelClosed!: () => void;
  const connected = new Promise<void>((resolve) => { observed = resolve; });
  const closed = new Promise<void>((resolve) => { tunnelClosed = resolve; });
  const proxy = createServer();
  proxy.on("connect", (req, socket) => {
    assert.equal(req.url, "model-fixture.invalid:443");
    socket.on("close", tunnelClosed);
    socket.on("end", () => socket.end());
    socket.resume();
    observed(); // Deliberately leave CONNECT pending until the request is aborted.
  });
  const port = await listen(t, proxy);
  environment(t, { HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", https_proxy: `http://127.0.0.1:${port}` });
  const client = createProviderClient("https://model-fixture.invalid/v1", "offline-key");
  const controller = new AbortController();
  const request = assert.rejects(client.models.list({ signal: controller.signal, maxRetries: 0 }), /aborted/i);
  await connected; controller.abort(); await request;
  await disposeProviderClient(client); await closed;
});

test("invalid proxy configuration fails without revealing embedded credentials", (t) => {
  environment(t, { HTTPS_PROXY: "http://private-user:private-password@" });
  assert.throws(() => createProviderClient("https://model-fixture.invalid/v1", "offline-key"), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message, "Invalid model HTTP proxy configuration"); return true;
  });
});
