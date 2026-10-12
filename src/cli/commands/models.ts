import type { RegisteredModelStatus } from "../../storage/model-registry.js";
import { resolveProviderCapabilities, requestReasoningEffort, defaultModelRequestSettings } from "../../providers/capabilities.js";
import type { CommandContext } from "./types.js";

export function modelStatusLabel(model: RegisteredModelStatus): string {
  const capabilities = resolveProviderCapabilities(model.base_url, model.model_name, model.responses_profile);
  const settings = defaultModelRequestSettings(capabilities, model.request_settings);
  return `${model.model_name} [${model.credential_status}] · ${capabilities.responsesProfile} (${capabilities.source}) · reasoning sent: ${requestReasoningEffort(capabilities, settings.reasoningEffort) ?? "not sent"}`;
}

export async function runModelsCommand({
  registry,
  prompter,
}: CommandContext): Promise<number> {
  const models = await registry.listStatuses();
  if (models.length === 0) {
    prompter.write("No registered models. Run `everpeace login` first.\n");
    return 0;
  }

  prompter.write(`Registered models (${registry.filePath}):\n`);
  models.forEach((model, index) =>
    prompter.write(`  ${index + 1}. ${modelStatusLabel(model)}\n`),
  );
  return 0;
}
