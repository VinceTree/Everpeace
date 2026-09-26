import { resolveModelStatusMetadata } from "../status/model-status.js";
import { supportsPromptCacheOptions } from "../providers/openai-compatible.js";
import type { BenchmarkProviderCapabilities } from "./types.js";

export interface ProviderCapabilityOverrides {
  streaming?: boolean;
  streamRecovery?: boolean;
  nativeCompaction?: boolean;
  promptCache?: boolean;
  parallelToolCalls?: boolean;
}

/** Build an observed capability profile; unsupported features stay false until verified. */
export function createProviderCapabilityProfile(
  baseUrl: string,
  model: string,
  overrides: ProviderCapabilityOverrides = {},
): BenchmarkProviderCapabilities {
  const metadata = resolveModelStatusMetadata(baseUrl, model);
  return {
    provider: metadata.provider,
    baseUrl,
    model,
    streaming: overrides.streaming === true,
    streamRecovery: overrides.streamRecovery === true,
    nativeCompaction: overrides.nativeCompaction === true,
    promptCache: overrides.promptCache ?? (metadata.provider === "OpenAI" && supportsPromptCacheOptions(model)),
    parallelToolCalls: overrides.parallelToolCalls === true,
    contextWindow: metadata.context_window,
  };
}
