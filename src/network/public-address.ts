import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type HostLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;
export type FetchLike = typeof globalThis.fetch;
export type PublicNetworkDiagnostic = "invalid_target" | "dns_failed" | "non_public_address" | "proxy_configuration" | "proxy_failed" | "connection_failed" | "response_failed";

export class PublicNetworkError extends Error {
  constructor(readonly code: PublicNetworkDiagnostic, message: string) { super(message); this.name = "PublicNetworkError"; }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6");

export function isPublicIpAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
  return false;
}

export function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
}

/** Cancellation ends the caller's wait; late DNS completion cannot open a connection. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); signal.throwIfAborted(); }
  let onAbort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export interface PublicTarget {
  readonly hostname: string;
  readonly protocol: "http:" | "https:";
  readonly port: number;
  readonly addresses: readonly Readonly<{ address: string; family: 4 | 6 }>[];
}

export const publicLookup: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function resolvePublicTarget(url: URL, resolver: HostLookup = publicLookup, signal: AbortSignal = new AbortController().signal): Promise<PublicTarget> {
  signal.throwIfAborted();
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new PublicNetworkError("invalid_target", "Only HTTP and HTTPS URLs without credentials can be fetched");
  }
  const hostname = canonicalHostname(url.hostname);
  if (!hostname || hostname === "localhost" || /\.(?:localhost|local|internal)$/u.test(hostname)) {
    throw new PublicNetworkError("non_public_address", "Local and private network addresses cannot be fetched");
  }
  let addresses: Awaited<ReturnType<HostLookup>>;
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(resolver(hostname), signal);
  } catch {
    signal.throwIfAborted();
    throw new PublicNetworkError("dns_failed", "Public target DNS resolution failed");
  }
  signal.throwIfAborted();
  if (addresses.length === 0 || addresses.some(({ address, family }) => isIP(address) !== family || !isPublicIpAddress(address))) {
    throw new PublicNetworkError("non_public_address", "Local and private network addresses cannot be fetched; special or unverifiable addresses are also blocked");
  }
  return Object.freeze({ hostname, protocol: url.protocol as PublicTarget["protocol"], port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), addresses: Object.freeze(addresses.map(({ address, family }) => Object.freeze({ address, family: family as 4 | 6 }))) });
}

export async function validatePublicUrl(url: URL, resolver: HostLookup): Promise<void> { await resolvePublicTarget(url, resolver); }
