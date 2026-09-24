export interface TokenUsageSample {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
}

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  context_tokens: number | null;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  cache_usage_complete?: boolean;
  complete: boolean;
}

export interface ModelStatusMetadata {
  provider: "OpenAI" | "DeepSeek" | "OpenAI-compatible";
  context_window: number | null;
}

export interface StatusSnapshot {
  version: string;
  model_name: string | null;
  provider: ModelStatusMetadata["provider"] | "N/A";
  base_url: string | null;
  workspace_path: string;
  session_id: string | null;
  context_window: number | null;
  context_tokens: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  cache_usage_complete?: boolean;
  usage_complete: boolean;
}

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEEPSEEK_BASE_URLS = new Set([
  "https://api.deepseek.com",
  "https://api.deepseek.com/v1",
]);

const OPENAI_CONTEXT_1_05M = [
  "gpt-6-astra",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-cyber",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
] as const;

const OPENAI_CONTEXT_400K = [
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5-codex",
] as const;

const OPENAI_CONTEXT_200K = [
  "o4-mini",
  "o3",
  "o3-pro",
  "o3-mini",
  "o1",
  "o1-pro",
  "o1-mini",
  "o1-preview",
  "codex-mini-latest",
] as const;

const DEEPSEEK_CONTEXT_1M = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
]);

function canonicalBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function isModelOrSnapshot(
  modelName: string,
  names: readonly string[],
): boolean {
  return names.some(
    (name) =>
      modelName === name ||
      new RegExp(`^${name.replaceAll(".", "\\.")}-\\d{4}-\\d{2}-\\d{2}$`, "u")
        .test(modelName),
  );
}

function openAiContextWindow(modelName: string): number | null {
  if (isModelOrSnapshot(modelName, OPENAI_CONTEXT_1_05M)) return 1_050_000;
  if (isModelOrSnapshot(modelName, OPENAI_CONTEXT_400K)) return 400_000;
  if (/^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u.test(modelName)) {
    return 1_047_576;
  }
  if (/^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/u.test(modelName)) {
    return 128_000;
  }
  if (/^gpt-5(?:\.\d+)?-chat-latest$/u.test(modelName)) return 128_000;
  if (isModelOrSnapshot(modelName, OPENAI_CONTEXT_200K)) return 200_000;
  return null;
}

export function resolveModelStatusMetadata(
  baseUrl: string,
  modelName: string,
): ModelStatusMetadata {
  const canonical = canonicalBaseUrl(baseUrl);
  if (canonical === OPENAI_BASE_URL) {
    return {
      provider: "OpenAI",
      context_window: openAiContextWindow(modelName),
    };
  }

  if (DEEPSEEK_BASE_URLS.has(canonical)) {
    return {
      provider: "DeepSeek",
      context_window: DEEPSEEK_CONTEXT_1M.has(modelName) ? 1_000_000 : null,
    };
  }

  return { provider: "OpenAI-compatible", context_window: null };
}

export function createEmptySessionUsage(complete = true): SessionUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    context_tokens: complete ? 0 : null,
    complete,
  };
}

export function applyUsageSample(
  current: SessionUsage,
  sample: TokenUsageSample | null,
): SessionUsage {
  if (sample === null) {
    const next: SessionUsage = {
      ...current,
      context_tokens: null,
      complete: false,
    };
    if (current.cache_usage_complete !== undefined) next.cache_usage_complete = false;
    return next;
  }

  const cachedInputTokens = sample.cached_input_tokens;
  const cacheWriteInputTokens = sample.cache_write_input_tokens;
  const cacheDetailsAvailable =
    isTokenCount(cachedInputTokens) &&
    isTokenCount(cacheWriteInputTokens);

  const next: SessionUsage = {
    input_tokens: current.input_tokens + sample.input_tokens,
    output_tokens: current.output_tokens + sample.output_tokens,
    context_tokens: sample.total_tokens,
    complete: current.complete,
  };
  if (cacheDetailsAvailable) {
    next.cached_input_tokens = (current.cached_input_tokens ?? 0) + cachedInputTokens;
    next.cache_write_input_tokens = (current.cache_write_input_tokens ?? 0) + cacheWriteInputTokens;
    next.cache_usage_complete = true;
  } else if (current.cache_usage_complete !== undefined) {
    if (current.cached_input_tokens !== undefined) {
      next.cached_input_tokens = current.cached_input_tokens;
    }
    if (current.cache_write_input_tokens !== undefined) {
      next.cache_write_input_tokens = current.cache_write_input_tokens;
    }
    next.cache_usage_complete = false;
  }
  return next;
}

export function resetContextUsage(
  current: SessionUsage,
  contextPreserved: boolean,
): SessionUsage {
  return {
    ...current,
    context_tokens: contextPreserved ? null : 0,
  };
}

export function isTokenUsageSample(value: unknown): value is TokenUsageSample {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as unknown as Record<string, unknown>;
  return [record.input_tokens, record.output_tokens, record.total_tokens].every(isTokenCount) &&
    (record.cached_input_tokens === undefined || isTokenCount(record.cached_input_tokens)) &&
    (record.cache_write_input_tokens === undefined || isTokenCount(record.cache_write_input_tokens));
}

export function normalizeTokenUsageSample(value: unknown): TokenUsageSample | null {
  if (!isTokenUsageSample(value)) return null;
  const record = value as unknown as Record<string, unknown>;
  const normalized: TokenUsageSample = {
    input_tokens: record.input_tokens as number,
    output_tokens: record.output_tokens as number,
    total_tokens: record.total_tokens as number,
  };
  const details = record.input_tokens_details;
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    const inputDetails = details as Record<string, unknown>;
    if (isTokenCount(inputDetails.cached_tokens)) {
      normalized.cached_input_tokens = inputDetails.cached_tokens;
    }
    if (isTokenCount(inputDetails.cache_write_tokens)) {
      normalized.cache_write_input_tokens = inputDetails.cache_write_tokens;
    }
  }
  if (isTokenCount(record.cached_input_tokens)) {
    normalized.cached_input_tokens = record.cached_input_tokens;
  }
  if (isTokenCount(record.cache_write_input_tokens)) {
    normalized.cache_write_input_tokens = record.cache_write_input_tokens;
  }
  return normalized;
}

function isTokenCount(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
}

export function isStatusSnapshot(value: unknown): value is StatusSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const nullableString = (candidate: unknown) =>
    candidate === null || typeof candidate === "string";
  const nullableTokenCount = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0);
  const tokenCount = (candidate: unknown) =>
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0;
  const optionalTokenCount = (candidate: unknown) =>
    candidate === undefined || tokenCount(candidate);

  return (
    typeof record.version === "string" &&
    nullableString(record.model_name) &&
    (record.provider === "OpenAI" ||
      record.provider === "DeepSeek" ||
      record.provider === "OpenAI-compatible" ||
      record.provider === "N/A") &&
    nullableString(record.base_url) &&
    typeof record.workspace_path === "string" &&
    nullableString(record.session_id) &&
    nullableTokenCount(record.context_window) &&
    nullableTokenCount(record.context_tokens) &&
    tokenCount(record.input_tokens) &&
    tokenCount(record.output_tokens) &&
    optionalTokenCount(record.cached_input_tokens) &&
    optionalTokenCount(record.cache_write_input_tokens) &&
    (record.cache_usage_complete === undefined || typeof record.cache_usage_complete === "boolean") &&
    typeof record.usage_complete === "boolean"
  );
}
