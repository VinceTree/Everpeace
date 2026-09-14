import type { RegisteredModelStatus } from "../../storage/model-registry.js";
import type { CommandContext } from "./types.js";

export function modelStatusLabel(model: RegisteredModelStatus): string {
  return `${model.model_name} [${model.credential_status}]`;
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
