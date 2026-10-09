import OpenAI from "openai";
import { EnvHttpProxyAgent } from "undici";
import type { AgentResponse, ResponseStreamLike } from "../agent/react-agent.js";
import { ownResponseStream } from "./response-stream.js";
import {
  defaultModelRequestSettings,
  resolveProviderCapabilities,
  type ModelRequestSettings,
  type ProviderCapabilities,
  type ResponsesProfile,
} from "./capabilities.js";

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

const clientDisposals = new WeakMap<OpenAI, () => Promise<void>>();

/** Close this client's transport after its requests and response bodies finish. */
export function disposeProviderClient(client: OpenAI): Promise<void> {
  return clientDisposals.get(client)?.() ?? Promise.resolve();
}

export function createProviderClient(
  baseURL: string,
  apiKey: string,
): OpenAI {
  const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY;
  const httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY;
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
  if ((!httpProxy && !httpsProxy) || noProxy.trim() === "*") {
    return new OpenAI({ apiKey, baseURL });
  }
  let dispatcher: EnvHttpProxyAgent;
  try {
    dispatcher = new EnvHttpProxyAgent({ httpProxy: httpProxy ?? "", httpsProxy: httpsProxy ?? httpProxy ?? "", noProxy });
  } catch {
    // Proxy URLs can contain credentials. Never echo the URL or parser error.
    throw new Error("Invalid model HTTP proxy configuration");
  }
  const client = new OpenAI({
    apiKey, baseURL,
    fetchOptions: { dispatcher },
  });
  let disposal: Promise<void> | undefined;
  // Owners have already joined model requests. Force-close idle sockets and
  // unfinished proxy CONNECT handshakes, which graceful close can wait on.
  clientDisposals.set(client, () => disposal ??= dispatcher.destroy());
  return client;
}

export interface ProviderRuntime {
  sdk: OpenAI;
  capabilities: ProviderCapabilities;
  settings: ModelRequestSettings;
  dispose?(): Promise<void>;
  responses: {
    create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<AgentResponse>;
    stream(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<ResponseStreamLike>;
    compact?(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ output: Array<Record<string, unknown>>; usage?: unknown }>;
  };
}

export function sanitizeProviderRequest(
  capabilities: ProviderCapabilities,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...params };
  if (!capabilities.encryptedReasoning) delete next.include;
  if (!capabilities.reasoningEffort) delete next.reasoning;
  if (!capabilities.promptCacheOptions) {
    delete next.prompt_cache_key;
    delete next.prompt_cache_retention;
  }
  if (capabilities.provider !== "openai" || capabilities.responsesProfile === "deepseek" || capabilities.responsesProfile === "generic") {
    delete next.store;
    delete next.parallel_tool_calls;
  }
  if (capabilities.maxOutputTokens !== null && typeof next.max_output_tokens === "number") {
    next.max_output_tokens = Math.min(next.max_output_tokens, capabilities.maxOutputTokens);
  }
  return next;
}

/** One entry point for main and auxiliary model requests. */
export function createProviderRuntime(
  baseURL: string,
  apiKey: string,
  settings?: Partial<ModelRequestSettings>,
  modelName?: string,
  profile: ResponsesProfile = "auto",
): ProviderRuntime {
  const capabilities = resolveProviderCapabilities(baseURL, modelName, profile);
  const sdk = createProviderClient(baseURL, apiKey);
  const responses: ProviderRuntime["responses"] = {
    create(params, options) {
      return sdk.responses.create(sanitizeProviderRequest(capabilities, params) as never, options as never) as unknown as Promise<AgentResponse>;
    },
    async stream(params, options) {
      const controller = new AbortController();
      const signal = options?.signal instanceof AbortSignal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      const response = await sdk.responses.create(
        { ...sanitizeProviderRequest(capabilities, params), stream: true } as never,
        { ...options, signal } as never,
      ).asResponse();
      return ownResponseStream(response, controller, signal, sdk);
    },
  };
  if (capabilities.compaction === "native") {
    responses.compact = (params, options) => sdk.responses.compact(params as never, options as never) as unknown as Promise<{ output: Array<Record<string, unknown>>; usage?: unknown }>;
  }
  return {
    sdk,
    capabilities,
    settings: defaultModelRequestSettings(capabilities, settings),
    dispose: () => disposeProviderClient(sdk),
    responses,
  };
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
