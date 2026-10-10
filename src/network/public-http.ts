import net, { isIP, type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import { abortable, canonicalHostname, PublicNetworkError, resolvePublicTarget, type FetchLike, type HostLookup, type PublicTarget } from "./public-address.js";

export interface PublicHttpOptions { fetch?: FetchLike; lookup?: HostLookup; env?: NodeJS.ProcessEnv; }

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined { return env[name.toLowerCase()] ?? env[name]; }

export function selectPublicProxy(target: PublicTarget, env: NodeJS.ProcessEnv): URL | undefined {
  const exclusions = envValue(env, "NO_PROXY")?.split(",") ?? [];
  for (const raw of exclusions) {
    const entry = raw.trim().toLowerCase();
    if (entry === "*") return undefined;
    if (!entry) continue;
    const match = entry.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u);
    if (!match || (match[2] && Number(match[2]) !== target.port)) continue;
    const host = canonicalHostname(match[1]!).replace(/^\*?\./u, "");
    if (target.hostname === host || (!isIP(host) && target.hostname.endsWith(`.${host}`))) return undefined;
  }
  const configured = target.protocol === "https:" ? envValue(env, "HTTPS_PROXY") || envValue(env, "HTTP_PROXY") : envValue(env, "HTTP_PROXY");
  if (!configured) return undefined;
  let proxy: URL;
  try { proxy = new URL(configured); } catch { throw new PublicNetworkError("proxy_configuration", "Invalid host proxy configuration"); }
  if (!["http:", "https:"].includes(proxy.protocol) || proxy.hash || proxy.search || !["", "/"].includes(proxy.pathname)) {
    throw new PublicNetworkError("proxy_configuration", "Only HTTP and HTTPS host proxies are supported");
  }
  return proxy;
}

/** Own every socket, including proxy TLS wrappers, until close has actually completed. */
export class PublicConnections {
  #sockets = new Set<Socket>();
  #closures: Promise<void>[] = [];
  constructor(readonly signal: AbortSignal) {}
  own<T extends Socket>(socket: T): T {
    this.#sockets.add(socket);
    const onAbort = () => socket.destroy();
    socket.on("error", () => {});
    this.#closures.push(new Promise<void>((resolve) => socket.once("close", () => { this.#sockets.delete(socket); this.signal.removeEventListener("abort", onAbort); resolve(); })));
    this.signal.addEventListener("abort", onAbort, { once: true });
    if (this.signal.aborted) socket.destroy();
    return socket;
  }
  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await Promise.all(this.#closures);
  }
}

async function connected<T extends Socket>(socket: T, event: "connect" | "secureConnect", signal: AbortSignal): Promise<T> {
  let ready!: () => void; let failed!: (error: Error) => void;
  try {
    return await abortable(new Promise<T>((resolve, reject) => { ready = () => resolve(socket); failed = reject; socket.once(event, ready); socket.once("error", failed); }), signal);
  } catch (error) { socket.destroy(); throw error; }
  finally { socket.removeListener(event, ready); socket.removeListener("error", failed); }
}

async function proxyTunnel(proxy: URL, address: string, port: number, connections: PublicConnections): Promise<Socket> {
  const signal = connections.signal;
  signal.throwIfAborted();
  const proxyHost = canonicalHostname(proxy.hostname);
  const tcp = connections.own(net.connect({ host: proxyHost, port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)) }));
  let socket: Socket = await connected(tcp, "connect", signal);
  if (proxy.protocol === "https:") {
    signal.throwIfAborted();
    socket = connections.own(tls.connect({ socket, servername: isIP(proxyHost) ? undefined : proxyHost, rejectUnauthorized: true, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(proxyHost, cert) }));
    await connected(socket, "secureConnect", signal);
  }
  const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
  let authentication = "";
  try {
    if (proxy.username || proxy.password) authentication = `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`;
  } catch { throw new PublicNetworkError("proxy_configuration", "Invalid host proxy authentication configuration"); }
  let dataHandler!: (chunk: Buffer) => void; let errorHandler!: (error: Error) => void; let endHandler!: () => void;
  try {
    const accepted = new Promise<void>((resolve, reject) => {
      let data = Buffer.alloc(0);
      dataHandler = (chunk) => {
        data = Buffer.concat([data, chunk]);
        const end = data.indexOf("\r\n\r\n");
        if (end < 0 && data.length <= 16 * 1024) return;
        if (end < 0 || end > 16 * 1024 || !/^HTTP\/1\.[01] 200(?: |\r\n)/u.test(data.subarray(0, end).toString("latin1"))) { reject(new PublicNetworkError("proxy_failed", "Host proxy rejected the public target tunnel")); return; }
        socket.pause(); socket.removeListener("data", dataHandler);
        if (data.length > end + 4) socket.unshift(data.subarray(end + 4));
        resolve();
      };
      errorHandler = reject;
      endHandler = () => reject(new PublicNetworkError("proxy_failed", "Host proxy closed before establishing a tunnel"));
      socket.on("data", dataHandler); socket.once("error", errorHandler); socket.once("end", endHandler);
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authentication}\r\n`);
    });
    await abortable(accepted, signal);
    return socket;
  } finally { socket.removeListener("data", dataHandler); socket.removeListener("error", errorHandler); socket.removeListener("end", endHandler); }
}

/** Origin DNS never runs here: retries consume only this request's validated addresses. */
export async function connectPublicTcp(target: PublicTarget, proxy: URL | undefined, connections: PublicConnections): Promise<Socket> {
  for (const { address, family } of target.addresses) {
    connections.signal.throwIfAborted();
    try {
      if (proxy) return await proxyTunnel(proxy, address, target.port, connections);
      return await connected(connections.own(net.connect({ host: address, port: target.port, family })), "connect", connections.signal);
    } catch (error) {
      connections.signal.throwIfAborted();
      // A rejected proxy must not be retried through a direct connection.
      if (proxy) { if (error instanceof PublicNetworkError) throw error; throw new PublicNetworkError("proxy_failed", "Host proxy connection failed"); }
    }
  }
  throw new PublicNetworkError("connection_failed", "Connection to validated public addresses failed");
}

/** The response cannot escape its lease. Every redirect, failure and truncated body is released. */
export async function withPublicResponse<T>(url: URL, init: RequestInit, options: PublicHttpOptions, consume: (response: Response) => Promise<T>): Promise<T> {
  const signal = init.signal ?? AbortSignal.timeout(30_000);
  const target = await resolvePublicTarget(url, options.lookup, signal);
  const proxy = selectPublicProxy(target, options.env ?? process.env);
  const connections = new PublicConnections(signal);
  let dispatcher: Agent | undefined;
  let response: Response | undefined;
  try {
    if (options.fetch) {
      // Explicit host injection exists for offline fixtures; tool arguments cannot select it.
      const pending = options.fetch(url, { ...init, redirect: "manual", signal });
      void pending.then((late) => { if (signal.aborted && late.body && !late.body.locked) void late.body.cancel().catch(() => {}); }, () => {});
      response = await abortable(pending, signal);
    } else {
      dispatcher = new Agent({ connect: (connectOptions, callback) => {
        const connect = async (): Promise<Socket | TLSSocket> => {
          if (canonicalHostname(connectOptions.hostname) !== target.hostname || connectOptions.protocol !== target.protocol || Number(connectOptions.port || (target.protocol === "https:" ? 443 : 80)) !== target.port) throw new PublicNetworkError("invalid_target", "Public connection target changed after validation");
          const socket = await connectPublicTcp(target, proxy, connections);
          if (target.protocol === "http:") return socket;
          signal.throwIfAborted();
          const secure = connections.own(tls.connect({ socket, servername: isIP(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(target.hostname, cert) }));
          return await connected(secure, "secureConnect", signal);
        };
        void connect().then((socket) => callback(null, socket), (error: unknown) => callback(error instanceof PublicNetworkError ? error : new PublicNetworkError("connection_failed", "Public target TLS or connection failed"), null));
      } });
      response = await undiciFetch(url, { ...init, redirect: "manual", signal, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    }
    return await abortable(consume(response), signal);
  } catch (error) {
    signal.throwIfAborted();
    if (options.fetch || error instanceof PublicNetworkError) throw error;
    const cause = error instanceof Error && error.cause instanceof PublicNetworkError ? error.cause : undefined;
    throw cause ?? new PublicNetworkError("response_failed", "Public resource request or response failed");
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    let cleanupFailed = false;
    try { await dispatcher?.destroy(); } catch { cleanupFailed = true; }
    await connections.close();
    // oxlint-disable-next-line no-unsafe-finally -- Failed disposal cannot return a successful resource result.
    if (cleanupFailed) throw new PublicNetworkError("response_failed", "Public resource cleanup failed");
  }
}
