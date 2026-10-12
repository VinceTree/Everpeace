import {uiText} from '../../localization/messages.js';
import type { RegisteredModelStatus } from "../../storage/model-registry.js";
import { resolveProviderCapabilities, requestReasoningEffort, defaultModelRequestSettings } from "../../providers/capabilities.js";
import type { CommandContext } from "./types.js";

export function modelStatusLabel(model: RegisteredModelStatus): string {
  const capabilities = resolveProviderCapabilities(model.base_url, model.model_name, model.responses_profile);
  const settings = defaultModelRequestSettings(capabilities, model.request_settings);
  return uiText('mefc44081f67b', {p0: model.model_name, p1: model.credential_status, p2: capabilities.responsesProfile, p3: capabilities.source, p4: requestReasoningEffort(capabilities, settings.reasoningEffort) ?? uiText('m8513a9ecd7d7')});
}

export async function runModelsCommand({
  registry,
  prompter,
}: CommandContext): Promise<number> {
  const models = await registry.listStatuses();
  if (models.length === 0) {
    prompter.write(uiText('m4a73bb777ec6'));
    return 0;
  }

  prompter.write(uiText('m33a9a8d8a613', {p0: registry.filePath}));
  models.forEach((model, index) =>
    prompter.write(`  ${index + 1}. ${modelStatusLabel(model)}\n`),
  );
  return 0;
}
