import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Socket } from "node:net";
import { abortable, canonicalHostname, PublicNetworkError, resolvePublicTarget } from "./public-address.js";
import { connectPublicTcp, PublicConnections, selectPublicProxy, type PublicHttpOptions } from "./public-http.js";

export interface PublicGitRelay { proxyUrl: string; close(): Promise<void>; }

/** A one-clone authenticated gateway. Git sees its original HTTPS URL and validates its TLS identity. */
export async function createPublicGitRelay(url: URL, signal: AbortSignal, options: PublicHttpOptions & { lifetimeSignal?: AbortSignal } = {}): Promise<PublicGitRelay> {
  if (url.protocol !== "https:") throw new PublicNetworkError("invalid_target", "Git Skill sources require HTTPS");
  const target = await resolvePublicTarget(url, options.lookup, signal);
  const proxy = selectPublicProxy(target, options.env ?? process.env);
  const secret = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Basic ${Buffer.from(`everpeace:${secret}`).toString("base64")}`);
  const lifecycle = new AbortController();
  // A Git process owner may keep established tunnels until process-tree termination is observed.
  const lifetimeSignal = options.lifetimeSignal ?? signal;
  const connections = new PublicConnections(AbortSignal.any([lifetimeSignal, lifecycle.signal]));
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 10_000, headersTimeout: 10_000 }, (_request, response) => {
    response.writeHead(405, { Connection: "close" }); response.end();
  });
  server.on("connection", (socket) => { connections.own(socket); socket.setTimeout(10_000, () => socket.destroy()); });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, incoming, head) => {
    if (signal.aborted) { incoming.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
    const supplied = Buffer.from(request.headers["proxy-authorization"] ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { incoming.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Everpeace\"\r\nConnection: close\r\n\r\n"); return; }
    let authority: URL;
    try { authority = new URL(`https://${request.url}`); } catch { incoming.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    if (canonicalHostname(authority.hostname) !== target.hostname || Number(authority.port || 443) !== target.port || authority.username || authority.password || authority.pathname !== "/" || authority.search || authority.hash) {
      incoming.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    const onIncomingClose = () => tunnel?.destroy();
    let tunnel: Awaited<ReturnType<typeof connectPublicTcp>> | undefined;
    incoming.once("close", onIncomingClose);
    void connectPublicTcp(target, proxy, connections).then((socket) => {
      tunnel = socket;
      if (incoming.destroyed || connections.signal.aborted) { socket.destroy(); return; }
      if (incoming instanceof Socket) incoming.setTimeout(0);
      incoming.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.write(head);
      socket.once("close", () => incoming.destroy());
      incoming.pipe(socket); socket.pipe(incoming);
    }, () => { if (!incoming.destroyed) incoming.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    lifecycle.abort();
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    await connections.close(); await stopped;
  })();
  const onAbort = () => { void close(); };
  lifetimeSignal.addEventListener("abort", onAbort, { once: true });
  try {
    await abortable(new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, signal: connections.signal }, () => { server.removeListener("error", reject); resolve(); });
    }), AbortSignal.any([signal, connections.signal]));
    const address = server.address();
    if (!address || typeof address === "string") throw new PublicNetworkError("connection_failed", "Git relay could not bind its loopback listener");
    return { proxyUrl: `http://everpeace:${secret}@127.0.0.1:${address.port}`, close: async () => { lifetimeSignal.removeEventListener("abort", onAbort); await close(); } };
  } catch (error) { lifetimeSignal.removeEventListener("abort", onAbort); await close(); throw error; }
}

/** Remove inherited Git configuration and route HTTPS exclusively through the owned gateway. */
export function publicGitEnvironment(proxyUrl?: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^GIT_/iu.test(key) && !/^(?:HTTPS?|ALL|NO)_PROXY$/iu.test(key) && !/^SSH_ASKPASS/iu.test(key)));
  const empty = process.platform === "win32" ? "NUL" : "/dev/null";
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_GLOBAL: empty,
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_LFS_SKIP_SMUDGE: "1", GIT_ATTR_NOSYSTEM: "1",
    ...(proxyUrl ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.proxy", GIT_CONFIG_VALUE_0: proxyUrl } : {}),
  };
}
