import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { spawnOwned as spawn } from '../../../src/tools/owned-process.js';
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import test, { type TestContext } from "node:test";
import { isPublicIpAddress, resolvePublicTarget } from "../../../src/network/public-address.js";
import { selectPublicProxy, withPublicResponse } from "../../../src/network/public-http.js";
import { createPublicGitRelay, publicGitEnvironment } from "../../../src/network/git-relay.js";
import { buildGitCloneArguments } from "../../../src/skills/manager.js";
import { fetchWebPage } from "../../../src/tools/web.js";
import { observeProcessCompletion } from "../../../src/tools/process-completion.js";
import { Agent } from "undici";

const cert = readFileSync(new URL("../../fixtures/public-network/cert.pem", import.meta.url));
const key = readFileSync(new URL("../../fixtures/public-network/key.pem", import.meta.url));
const lookup = async () => [{ address: "8.8.8.8", family: 4 }];

async function listen(t: TestContext, server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}

function mapPublicSocket(t: TestContext, recorded: string[], rejectFirst = false): void {
  const original = net.connect;
  t.mock.method(net, "connect", (options: net.NetConnectOpts) => {
    assert.ok("host" in options);
    recorded.push(options.host!);
    if (options.host === "8.8.4.4" && rejectFirst) return original({ ...options, host: "127.0.0.1", port: 0 });
    assert.ok(["8.8.8.8", "8.8.4.4", "127.0.0.1"].includes(options.host!), `Unexpected test connection: ${options.host}`);
    return original({ ...options, host: "127.0.0.1", family: 4 });
  });
}

function trustFixture(t: TestContext, names: string[]): void {
  const original = tls.connect;
  t.mock.method(tls, "connect", (options: tls.ConnectionOptions) => {
    assert.equal(options.rejectUnauthorized, true);
    names.push(options.servername ?? "");
    return original({ ...options, ca: cert });
  });
}

test("all DNS answers must be public and consistently formatted, including IPv6", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.175.48.1", "198.51.100.1", "203.0.113.1", "224.1.1.1", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:db8::1", "2002:808:808::1", "2620:4f:8000::1", "3fff::1", "fe80::1%eth0"]) assert.equal(isPublicIpAddress(address), false, address);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  await assert.rejects(resolvePublicTarget(new URL("https://public.example"), async () => [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }]), { code: "non_public_address" });
  await assert.rejects(resolvePublicTarget(new URL("https://public.example"), async () => [{ address: "8.8.8.8", family: 6 }]), { code: "non_public_address" });
  await assert.rejects(resolvePublicTarget(new URL("https://LOCALHOST.")), { code: "non_public_address" });
});

test("actual HTTP connection and retries use only the validated snapshot, preserving Host", async (t) => {
  const hosts: string[] = []; const connections: string[] = []; let resolutions = 0;
  const server = http.createServer((request, response) => { hosts.push(request.headers.host!); response.end("connected"); });
  const port = await listen(t, server); mapPublicSocket(t, connections, true);
  const body = await withPublicResponse(new URL(`http://public.example:${port}`), { signal: AbortSignal.timeout(3000) }, { env: {}, lookup: async () => { resolutions++; return resolutions === 1 ? [{ address: "8.8.4.4", family: 4 }, { address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]; } }, (response) => response.text());
  assert.equal(body, "connected"); assert.equal(resolutions, 1);
  assert.deepEqual(connections, ["8.8.4.4", "8.8.8.8"]); assert.deepEqual(hosts, [`public.example:${port}`]);
});

test("HTTPS preserves SNI and verifies the original hostname", async (t) => {
  const connections: string[] = []; const names: string[] = [];
  const server = https.createServer({ key, cert }, (_request, response) => response.end("secure"));
  const port = await listen(t, server); mapPublicSocket(t, connections); trustFixture(t, names);
  assert.equal(await withPublicResponse(new URL(`https://public.example:${port}`), { signal: AbortSignal.timeout(3000) }, { lookup, env: {} }, (response) => response.text()), "secure");
  await assert.rejects(withPublicResponse(new URL(`https://wrong.example:${port}`), { signal: AbortSignal.timeout(3000) }, { lookup, env: {} }, (response) => response.text()), { code: "connection_failed" });
  assert.deepEqual(names, ["public.example", "wrong.example"]);
});

test("HTTP and HTTPS proxies CONNECT to the validated IP, keeping proxy credentials outside the origin", async (t) => {
  const records: Array<{ authority: string | undefined; authorization: string | undefined }> = [];
  const connections: string[] = []; const names: string[] = [];
  const origin = https.createServer({ key, cert }, (request, response) => { assert.equal(request.headers["proxy-authorization"], undefined); assert.equal(request.headers.authorization, undefined); response.end(request.headers.host); });
  const originPort = await listen(t, origin); mapPublicSocket(t, connections); trustFixture(t, names);
  for (const secure of [false, true]) {
    const proxy = secure ? https.createServer({ key, cert }) : http.createServer();
    proxy.on("connect", (request, incoming, head) => {
      records.push({ authority: request.url, authorization: request.headers["proxy-authorization"] });
      const outgoing = net.connect({ host: "127.0.0.1", port: originPort });
      outgoing.on("error", () => incoming.destroy()); incoming.on("close", () => outgoing.destroy());
      outgoing.once("connect", () => { incoming.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) outgoing.write(head); incoming.pipe(outgoing); outgoing.pipe(incoming); });
    });
    const proxyPort = await listen(t, proxy);
    const result = await withPublicResponse(new URL(`https://public.example:${originPort}`), { signal: AbortSignal.timeout(3000) }, { lookup, env: { HTTPS_PROXY: `${secure ? "https" : "http"}://user:secret@127.0.0.1:${proxyPort}` } }, (response) => response.text());
    assert.equal(result, `public.example:${originPort}`);
  }
  assert.deepEqual(records, Array.from({ length: 2 }, () => ({ authority: `8.8.8.8:${originPort}`, authorization: `Basic ${Buffer.from("user:secret").toString("base64")}` })));
  assert.equal(names.filter((name) => name === "public.example").length, 2);
});

test("NO_PROXY uses hostname boundaries, ports and lowercase precedence; unsupported proxies fail", async () => {
  const target = await resolvePublicTarget(new URL("https://public.example"), lookup);
  assert.equal(selectPublicProxy(target, { HTTPS_PROXY: "http://upper", https_proxy: "http://lower" })?.hostname, "lower");
  assert.equal(selectPublicProxy(target, { HTTPS_PROXY: "http://proxy", NO_PROXY: ".example:443" }), undefined);
  assert.equal(selectPublicProxy(target, { HTTPS_PROXY: "http://proxy", NO_PROXY: "lic.example,public.example:80" })?.hostname, "proxy");
  assert.throws(() => selectPublicProxy(target, { HTTPS_PROXY: "socks5://proxy" }), { code: "proxy_configuration" });
});

test("proxy refusal does not fall back to direct and does not leak authentication in errors", async (t) => {
  const server = http.createServer(); server.on("connect", (_request, socket) => socket.end("HTTP/1.1 407 secret\r\n\r\n"));
  const port = await listen(t, server); const connections: string[] = []; mapPublicSocket(t, connections);
  await assert.rejects(withPublicResponse(new URL("https://public.example"), { signal: AbortSignal.timeout(3000) }, { lookup, env: { HTTPS_PROXY: `http://user:secret@127.0.0.1:${port}` } }, (response) => response.text()), (error: unknown) => { assert.ok(error instanceof Error); assert.match(error.message, /proxy/iu); assert.ok(!error.message.includes("secret")); return true; });
  assert.deepEqual(connections, ["127.0.0.1"]);
});

test("slow DNS expires without a late connection and every error or abandoned response closes sockets", async (t) => {
  const connections: string[] = []; mapPublicSocket(t, connections);
  let finish!: (value: Awaited<ReturnType<typeof lookup>>) => void;
  const pending = withPublicResponse(new URL("http://public.example"), { signal: AbortSignal.timeout(20) }, { env: {}, lookup: () => new Promise((resolve) => { finish = resolve; }) }, (response) => response.text());
  // A live server keeps the event loop awake for unref'ed task deadlines.
  const server = http.createServer((_request, response) => { response.writeHead(500); response.write("unfinished"); });
  const port = await listen(t, server);
  await assert.rejects(pending, { name: "TimeoutError" }); finish([{ address: "8.8.8.8", family: 4 }]);
  assert.deepEqual(connections, []);
  let active = 0; let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => { closed = resolve; });
  server.on("connection", (socket) => { active++; socket.on("close", () => { active--; closed(); }); });
  await assert.rejects(withPublicResponse(new URL(`http://public.example:${port}`), { signal: AbortSignal.timeout(3000) }, { lookup, env: {} }, async () => { throw new Error("reject status"); }), /Public resource/u);
  await connectionClosed; assert.equal(active, 0);
});

test("Git relay only accepts its authenticated target and closes on cancellation", async (t) => {
  const controller = new AbortController();
  const relay = await createPublicGitRelay(new URL("https://public.example"), controller.signal, { lookup, env: {} }); t.after(() => relay.close());
  const proxy = new URL(relay.proxyUrl);
  const request = (target: string, auth: boolean) => new Promise<number>((resolve, reject) => {
    const call = http.request({ hostname: proxy.hostname, port: proxy.port, method: "CONNECT", path: target, ...(auth ? { headers: { "Proxy-Authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}` } } : {}) });
    call.on("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode!); }); call.on("error", reject); call.end();
  });
  assert.equal(await request("public.example:443", false), 407);
  assert.equal(await request("127.0.0.1:443", true), 403);
  assert.equal(await request("other.example:443", true), 403);
  controller.abort(); await relay.close();
  await assert.rejects(request("public.example:443", true), { code: "ECONNREFUSED" });
  const env = publicGitEnvironment(relay.proxyUrl, { PATH: "trusted", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "url.file:///private/.insteadOf", GIT_SSL_NO_VERIFY: "true", GIT_EXEC_PATH: "malicious", HTTPS_PROXY: "http://evil", no_proxy: "*", SSH_ASKPASS: "evil" });
  assert.equal(env.GIT_CONFIG_COUNT, "1"); assert.equal(env.GIT_CONFIG_KEY_0, "http.proxy"); assert.equal(env.GIT_SSL_NO_VERIFY, undefined); assert.equal(env.HTTPS_PROXY, undefined); assert.equal(env.no_proxy, undefined); assert.equal(env.GIT_EXEC_PATH, undefined);
});

test("real IPv6 connection uses its validated address", async (t) => {
  const server = http.createServer((_request, response) => response.end("ipv6"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", resolve); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const original = net.connect; const recorded: string[] = [];
  t.mock.method(net, "connect", (options: net.NetConnectOpts) => {
    assert.ok("host" in options); recorded.push(options.host!);
    assert.equal(options.host, "2606:4700:4700::1111");
    return original({ ...options, host: "::1", family: 6 });
  });
  const result = await withPublicResponse(new URL(`http://public.example:${address.port}`), { signal: AbortSignal.timeout(3000) }, { env: {}, lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }] }, (response) => response.text());
  assert.equal(result, "ipv6"); assert.deepEqual(recorded, ["2606:4700:4700::1111"]);
});

test("redirect bodies, oversized pages and cancellation release real connections", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: "http://127.0.0.1/private" }); response.write("unfinished redirect"); }
    else if (request.url === "/large") { response.writeHead(200, { "content-type": "text/plain" }); response.end("a".repeat(1_100_000)); }
    else { response.writeHead(200, { "content-type": "text/plain" }); response.write("unfinished body"); }
  });
  const port = await listen(t, server); const connections: string[] = []; mapPublicSocket(t, connections);
  // The host test environment must not insert a real proxy into mapped fixture connections.
  const prior = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, http_proxy: process.env.http_proxy, https_proxy: process.env.https_proxy, NO_PROXY: process.env.NO_PROXY };
  process.env.NO_PROXY = "*";
  t.after(() => { for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  await assert.rejects(fetchWebPage(`http://public.example:${port}/redirect`, { lookup, timeoutMs: 3000 }), { code: "non_public_address" });
  const page = await fetchWebPage(`http://public.example:${port}/large`, { lookup, timeoutMs: 3000 }); assert.equal(page.truncated, true); assert.equal(page.content.length, 30_000);
  await assert.rejects(fetchWebPage(`http://public.example:${port}/slow`, { lookup, timeoutMs: 40 }), { name: "TimeoutError" });
  assert.deepEqual(connections, ["8.8.8.8", "8.8.8.8", "8.8.8.8"]);
});

async function git(args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn("git", args, { windowsHide: true, env: env ?? process.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr))); });
}

test("actual shallow Git clone crosses the restricted CONNECT relay with inherited URL rewrite disabled", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "everpeace-public-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, "repository"); await fs.mkdir(source);
  await git(["init", "--quiet", source]); await fs.writeFile(join(source, "SKILL.md"), "---\nname: network-test\ndescription: Local fixture\n---\nFixture\n");
  await git(["-C", source, "add", "SKILL.md"]);
  await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const bare = join(root, "source.git"); await git(["clone", "--quiet", "--bare", source, bare]);
  const server = https.createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url!, "https://public.example");
    const child = spawn("git", ["http-backend"], { windowsHide: true, env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method!, CONTENT_TYPE: request.headers["content-type"] ?? "", REMOTE_ADDR: "127.0.0.1" }, stdio: ["pipe", "pipe", "pipe"] });
    request.pipe(child.stdin); let header = Buffer.alloc(0); let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) { response.write(chunk); return; }
      header = Buffer.concat([header, chunk]); const end = header.indexOf("\r\n\r\n"); if (end < 0) return;
      const headers: Record<string, string> = {};
      for (const line of header.subarray(0, end).toString().split("\r\n")) { const split = line.indexOf(":"); if (split > 0) headers[line.slice(0, split)] = line.slice(split + 1).trim(); }
      response.writeHead(200, headers); started = true; response.write(header.subarray(end + 4));
    });
    child.on("error", () => response.destroy()); child.stderr.resume(); child.on("close", () => response.end());
  });
  const port = await listen(t, server); const connections: string[] = []; mapPublicSocket(t, connections);
  const controller = new AbortController(); const url = new URL(`https://public.example:${port}/source.git`);
  const relay = await createPublicGitRelay(url, controller.signal, { lookup, env: {}, lifetimeSignal: new AbortController().signal }); t.after(() => relay.close());
  const ca = join(root, "ca.pem"); await fs.writeFile(ca, cert);
  const injected = join(root, "unsafe-config"); await fs.writeFile(injected, '[url "file:///private/"]\n insteadOf = https://public.example\n[http]\n proxy = http://127.0.0.1:1\n sslVerify = false\n');
  const env = publicGitEnvironment(relay.proxyUrl, { ...process.env, GIT_CONFIG_GLOBAL: injected, GIT_SSL_NO_VERIFY: "1", NO_PROXY: "*", GIT_CONFIG_PARAMETERS: "malformed" });
  await git(["-c", `http.sslCAInfo=${ca}`, ...buildGitCloneArguments(url, join(root, "checkout"))], env);
  assert.ok(connections.length > 0); assert.ok(connections.every((address) => address === "8.8.8.8"));
  const files = await fs.readdir(join(root, "checkout")); assert.deepEqual(files, [".git"]);
  await relay.close();
});

test("a stalled proxy expires and closes without connecting directly", { timeout: 5000 }, async (t) => {
  let closed!: () => void; const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
  const server = http.createServer(); server.on("connection", (socket) => socket.on("close", closed));
  server.on("connect", (_request, socket) => { socket.on("end", () => socket.end()); socket.resume(); });
  const port = await listen(t, server); const connections: string[] = []; mapPublicSocket(t, connections);
  await assert.rejects(withPublicResponse(new URL("https://public.example"), { signal: AbortSignal.timeout(40) }, { lookup, env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } }, (response) => response.text()), { name: "TimeoutError" });
  await socketClosed; assert.deepEqual(connections, ["127.0.0.1"]);
});

test("cancelling an active real Git clone closes its process and CONNECT relay", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "everpeace-cancel-git-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let requested!: () => void; const started = new Promise<void>((resolve) => { requested = resolve; });
  const server = https.createServer({ key, cert }, (_request, response) => { response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" }); response.write("unfinished"); requested(); });
  const port = await listen(t, server); const connections: string[] = []; mapPublicSocket(t, connections);
  const controller = new AbortController(); const url = new URL(`https://public.example:${port}/source.git`);
  const relay = await createPublicGitRelay(url, controller.signal, { lookup, env: {}, lifetimeSignal: new AbortController().signal }); t.after(() => relay.close());
  const ca = join(root, "ca.pem"); await fs.writeFile(ca, cert);
  const child = spawn("git", ["-c", `http.sslCAInfo=${ca}`, ...buildGitCloneArguments(url, join(root, "checkout"))], { env: publicGitEnvironment(relay.proxyUrl), windowsHide: true, detached: process.platform !== "win32", stdio: "ignore" });
  const owned = observeProcessCompletion(child, { signal: controller.signal, timeoutMs: 5000 });
  await started; controller.abort(new Error("Cancel fixture clone"));
  const result = await owned.completion; await relay.close(); assert.equal(result.cleanupError, undefined); assert.equal(owned.closed, true);
  const proxy = new URL(relay.proxyUrl);
  await assert.rejects(new Promise<void>((resolve, reject) => { const socket = net.createConnection({ host: proxy.hostname, port: Number(proxy.port) }); socket.once("error", reject); socket.once("connect", () => { socket.destroy(); resolve(); }); }), { code: "ECONNREFUSED" });
});

test("dispatcher disposal failure still closes every owned socket and returns a fixed diagnostic", async (t) => {
  let closed!: () => void; const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
  const server = http.createServer((_request, response) => response.end("complete")); server.on("connection", (socket) => socket.on("close", closed));
  const port = await listen(t, server); const connections: string[] = []; mapPublicSocket(t, connections);
  const original: (this: Agent, error: Error | null, callback: () => void) => void = Agent.prototype.destroy;
  t.mock.method(Agent.prototype, "destroy", async function (this: Agent) {
    await new Promise<void>((resolve) => original.call(this, null, resolve));
    throw new Error("PRIVATE_INTERNAL_EXCEPTION");
  });
  await assert.rejects(withPublicResponse(new URL(`http://public.example:${port}`), { signal: AbortSignal.timeout(3000) }, { lookup, env: {} }, (response) => response.text()), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message, "Public resource cleanup failed"); assert.equal(error.cause, undefined); return true;
  });
  await socketClosed; assert.deepEqual(connections, ["8.8.8.8"]);
});
