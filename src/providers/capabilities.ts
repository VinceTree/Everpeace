export type ProviderKind = "deepseek" | "openai" | "compatible";
export type CapabilitySource = "official" | "configured" | "observed";
export type ProviderProtocol = "responses";
export type CompactionStrategy = "native" | "summary";
export type ReasoningEffort = "off" | "low" | "high" | "max";

export interface ProviderCapabilities {
  provider: ProviderKind;
  source: CapabilitySource;
  protocol: ProviderProtocol;
  compaction: CompactionStrategy;
  reasoningEffort: boolean;
  encryptedReasoning: boolean;
  promptCacheOptions: boolean;
  serverSessions: boolean;
  maxOutputTokens: number | null;
}

export interface ModelRequestSettings {
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
}

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEEPSEEK_BASE_URLS = new Set([
  "https://api.deepseek.com",
  "https://api.deepseek.com/v1",
]);

export function canonicalBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const path = url.pathname.replace(/\/+$/u, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

export function providerKind(baseUrl: string): ProviderKind {
  const canonical = canonicalBaseUrl(baseUrl);
  if (canonical === OPENAI_BASE_URL) return "openai";
  if (DEEPSEEK_BASE_URLS.has(canonical)) return "deepseek";
  return "compatible";
}

export function canReuseOpaqueProviderContext(
  sourceBaseUrl: string,
  targetBaseUrl: string,
): boolean {
  const source = providerKind(sourceBaseUrl);
  const target = providerKind(targetBaseUrl);
  if (source !== target) return false;
  return source !== "compatible" || canonicalBaseUrl(sourceBaseUrl) === canonicalBaseUrl(targetBaseUrl);
}

export function resolveProviderCapabilities(baseUrl: string, modelName?: string): ProviderCapabilities {
  const provider = providerKind(baseUrl);
  if (provider === "deepseek") {
    return {
      provider,
      source: "official",
      protocol: "responses",
      compaction: "summary",
      reasoningEffort: true,
      encryptedReasoning: false,
      promptCacheOptions: false,
      serverSessions: false,
      maxOutputTokens: 32_768,
    };
  }
  if (provider === "openai") {
    const reasoningEffort = modelName !== undefined &&
      /^(?:gpt-[56](?:[.-]|$)|o[1-4](?:[.-]|$)|codex-)/u.test(modelName.trim().toLowerCase());
    return {
      provider,
      source: "official",
      protocol: "responses",
      compaction: "native",
      reasoningEffort,
      encryptedReasoning: true,
      promptCacheOptions: true,
      serverSessions: false,
      maxOutputTokens: 32_768,
    };
  }
  return {
    provider,
    source: "configured",
    protocol: "responses",
    compaction: "summary",
    reasoningEffort: false,
    encryptedReasoning: false,
    promptCacheOptions: false,
    serverSessions: false,
    maxOutputTokens: 32_768,
  };
}

export function defaultModelRequestSettings(
  capabilities: ProviderCapabilities,
  stored?: Partial<ModelRequestSettings>,
): ModelRequestSettings {
  const configuredMax = stored?.maxOutputTokens;
  const providerMax = capabilities.maxOutputTokens ?? 32_768;
  return {
    reasoningEffort: stored?.reasoningEffort ?? (capabilities.reasoningEffort ? "high" : "off"),
    maxOutputTokens:
      Number.isSafeInteger(configuredMax) && configuredMax !== undefined && configuredMax > 0
        ? Math.min(configuredMax, providerMax)
        : providerMax,
  };
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "off" || value === "low" || value === "high" || value === "max";
}

export function isModelRequestSettings(value: unknown): value is ModelRequestSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isReasoningEffort(record.reasoningEffort) &&
    typeof record.maxOutputTokens === "number" &&
    Number.isSafeInteger(record.maxOutputTokens) &&
    record.maxOutputTokens > 0;
}

export function requestReasoningEffort(
  capabilities: ProviderCapabilities,
  effort: ReasoningEffort,
): string | undefined {
  if (!capabilities.reasoningEffort) return undefined;
  if (effort === "off") return "none";
  if (effort === "max") return capabilities.provider === "deepseek" ? "high" : "xhigh";
  return effort;
}

export function hasOpaqueProviderContext(items: readonly Record<string, unknown>[]): boolean {
  return items.some((item) => {
    if (item.type === "compaction" && typeof item.encrypted_content === "string") return true;
    if (item.type !== "reasoning") return false;
    if (typeof item.encrypted_content === "string") return true;
    const content = item.content;
    return Array.isArray(content) && content.some((part) =>
      part && typeof part === "object" && typeof (part as Record<string, unknown>).encrypted_content === "string");
  });
}
