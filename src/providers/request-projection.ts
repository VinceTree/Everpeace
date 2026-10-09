import type { ProviderCapabilities } from "./capabilities.js";

/** Provider-specific wire layout. Durable history is never rewritten here. */
export function projectCodingContext(options: {
  capabilities: ProviderCapabilities;
  stableInstructions: string;
  dynamicInstructions: string;
  input: readonly Record<string, unknown>[];
  explicitCacheLayout: boolean;
}): { instructions?: string; input: Array<Record<string, unknown>> } {
  const { capabilities, stableInstructions, dynamicInstructions, input } = options;
  if (capabilities.responsesProfile === "deepseek" || capabilities.responsesProfile === undefined && capabilities.provider === "deepseek") {
    return {
      instructions: stableInstructions,
      input: [...input, { type: "message", role: "system", content: dynamicInstructions }],
    };
  }
  if (options.explicitCacheLayout) {
    return { input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: stableInstructions, prompt_cache_breakpoint: { mode: "explicit" } }] },
      ...input,
      { type: "message", role: "developer", content: dynamicInstructions },
    ] };
  }
  return { instructions: `${stableInstructions}\n${dynamicInstructions}`, input: [...input] };
}
