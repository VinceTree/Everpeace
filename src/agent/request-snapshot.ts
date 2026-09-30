import { createHash } from "node:crypto";

export interface RequestSnapshot {
  readonly request: Readonly<Record<string, unknown>>;
  readonly contextRevision: number;
  readonly estimatedInputTokens: number;
  readonly estimateSource: "utf8_bytes_div_4";
  readonly outputReserveTokens: number;
  readonly requestFingerprint: string;
  readonly stablePrefixFingerprint: string;
  readonly dynamicContextFingerprint: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Builds the request and its measurement from the same immutable payload. */
export function createRequestSnapshot(options: {
  request: Record<string, unknown>;
  contextRevision: number;
  outputReserveTokens: number;
  stablePrefix: unknown;
  dynamicContext: unknown;
}): RequestSnapshot {
  const request = structuredClone(options.request);
  return Object.freeze({
    request: Object.freeze(request),
    contextRevision: options.contextRevision,
    estimatedInputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(request), "utf8") / 4),
    estimateSource: "utf8_bytes_div_4" as const,
    outputReserveTokens: options.outputReserveTokens,
    requestFingerprint: digest(request),
    stablePrefixFingerprint: digest(options.stablePrefix),
    dynamicContextFingerprint: digest(options.dynamicContext),
  });
}
