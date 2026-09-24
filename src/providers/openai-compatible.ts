import OpenAI from "openai";

export type ProviderName = "deepseek" | "openai";

export interface ProviderDefinition {
  name: ProviderName;
  displayName: string;
  baseURL: string;
}

const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  deepseek: {
    name: "deepseek",
    displayName: "DeepSeek",
    baseURL: "https://api.deepseek.com",
  },
  openai: {
    name: "openai",
    displayName: "OpenAI",
    baseURL: "https://api.openai.com/v1",
  },
};

export interface ModelListClient {
  models: {
    list(options?: { signal?: AbortSignal }): Promise<{ data: Array<{ id: string }> }>;
  };
}

export function parseProvider(value: string): ProviderName {
  const normalized = value.trim().toLowerCase();
  if (normalized === "deepseek" || normalized === "openai") {
    return normalized;
  }
  throw new Error(`Unsupported provider: ${value}. Use deepseek or openai.`);
}

export function getProviderDefinition(
  provider: ProviderName,
): ProviderDefinition {
  return PROVIDERS[provider];
}

export function createProviderClient(
  baseURL: string,
  apiKey: string,
): OpenAI {
  return new OpenAI({ apiKey, baseURL });
}

export function isOfficialOpenAiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.openai.com" &&
      url.pathname.replace(/\/+$/u, "") === "/v1" &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function createSessionPromptCacheKey(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new Error("Prompt cache session ID cannot be empty");
  return `everpeace:v2:session:${normalized}`;
}

export function supportsPromptCacheOptions(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (/^gpt-6(?:[.-]|$)/u.test(normalized)) return true;
  const match = normalized.match(/^gpt-5\.(\d+)(?:[.-]|$)/u);
  return match !== null && Number(match[1]) >= 6;
}

export async function listOfficialModelIds(
  client: ModelListClient,
  signal?: AbortSignal,
): Promise<string[]> {
  const page = await client.models.list(signal === undefined ? undefined : { signal });
  return page.data
    .map((model) => model.id)
    .filter((id) => typeof id === "string" && id.length > 0);
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("base_url must be a valid absolute URL");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("base_url cannot contain credentials, a query, or a fragment");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const isAllowedHttp = url.protocol === "http:" && localHosts.has(url.hostname);
  if (url.protocol !== "https:" && !isAllowedHttp) {
    throw new Error("base_url must use HTTPS unless it points to localhost");
  }

  return trimmed.replace(/\/+$/, "");
}
