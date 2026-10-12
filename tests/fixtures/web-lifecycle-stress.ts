import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mock } from "node:test";
import { Agent } from "undici";
import { fetchWebPage } from "../../src/tools/web.js";

assert.ok(global.gc, "Stress proof requires --expose-gc in an independent process");
const sockets = new Set<net.Socket>(); const clients = new Set<net.Socket>(); const leases = new Set<Agent>();
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  if (url.pathname === "/redirect") { const remaining = Number(url.searchParams.get("n") ?? 4); res.writeHead(302, { location: remaining > 0 ? `/redirect?n=${remaining - 1}` : "/ok" }); res.write("unconsumed redirect"); return; }
  if (url.pathname === "/missing") { res.writeHead(302); res.write("unfinished missing Location"); return; }
  if (url.pathname === "/error") { res.writeHead(500); res.write("unfinished error"); return; }
  if (url.pathname === "/unsupported") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.write("unfinished unsupported body"); return; }
  if (url.pathname === "/read-error") { res.writeHead(200, { "content-type": "text/plain", "content-length": "1000" }); res.write("partial"); setImmediate(() => res.destroy()); return; }
  res.writeHead(200, { "content-type": "text/plain" });
  if (url.pathname === "/timeout" || url.pathname === "/cancel") { res.write("never ends"); return; }
  if (url.pathname === "/oversize") { res.end("x".repeat(1_100_000)); return; }
  res.end("fixture content");
});
server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const port = address.port;
const connect = net.connect;
const connectMock = mock.method(net, "connect", (options: net.NetConnectOpts) => {
  assert.ok("host" in options && options.host === "8.8.8.8", "Connector must receive a validated public IP");
  const socket = connect({ ...options, host: "127.0.0.1", family: 4 }); clients.add(socket); socket.on("close", () => clients.delete(socket)); return socket;
});
const destroy = Agent.prototype.destroy;
const destroyMock = mock.method(Agent.prototype, "destroy", function(this: Agent, ...args: Parameters<Agent["destroy"]>) {
  if (args.length) return destroy.apply(this, args);
  return destroy.call(this).finally(() => leases.delete(this));
});
const dispatch = Agent.prototype.dispatch;
const dispatchMock = mock.method(Agent.prototype, "dispatch", function(this: Agent, ...args: Parameters<Agent["dispatch"]>) { leases.add(this); return dispatch.apply(this, args); });
const cases = ["redirect", "missing", "error", "unsupported", "read-error", "timeout", "cancel", "oversize", "ok"];
async function batch(count: number): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < count) {
      const kind = cases[cursor++ % cases.length]!;
      const controller = new AbortController();
      const timer = kind === "cancel" ? setTimeout(() => controller.abort(), 20) : undefined;
      try {
        // Keep the deliberately hanging case short, but allow cold Windows connections
        // and five redirect hops to finish under concurrent CI load.
        const run = fetchWebPage(`http://public.example:${port}/${kind}`, { env: {}, timeoutMs: kind === "timeout" ? 250 : 5000, lookup: async () => [{ address: "8.8.8.8", family: 4 }], ...(kind === "cancel" ? { signal: controller.signal } : {}) });
        if (["redirect", "oversize", "ok"].includes(kind)) { const result = await run; if (kind === "oversize") assert.equal(result.truncated, true); }
        else await assert.rejects(run);
      } finally { if (timer) clearTimeout(timer); }
    }
  }));
  const deadline = Date.now() + 3000;
  while (sockets.size || clients.size) { assert.ok(Date.now() < deadline, "Sockets did not close"); await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.equal(leases.size, 0); assert.equal(sockets.size, 0); assert.equal(clients.size, 0);
  // The test mock's own call history must not retain sockets, dispatch handlers or response bodies.
  connectMock.mock.resetCalls(); destroyMock.mock.resetCalls(); dispatchMock.mock.resetCalls();
}
try {
  await batch(100); global.gc(); global.gc();
  const before = process.memoryUsage(); const batches = [];
  for (let index = 0; index < 10; index++) {
    await batch(100); global.gc(); global.gc();
    const memory = process.memoryUsage();
    assert.ok(memory.heapUsed - before.heapUsed <= 32 * 1024 * 1024, "Heap growth exceeds 32 MiB");
    assert.ok(memory.external - before.external <= 32 * 1024 * 1024, "External memory growth exceeds 32 MiB");
    batches.push({ index, sockets: sockets.size, clients: clients.size, leases: leases.size, heapGrowth: memory.heapUsed - before.heapUsed, externalGrowth: memory.external - before.external, rss: memory.rss });
  }
  console.log(JSON.stringify({ schema: 1, warmup: 100, batches, requestsPerBatch: 100, concurrency: 8, complete: true }));
} finally { mock.restoreAll(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
