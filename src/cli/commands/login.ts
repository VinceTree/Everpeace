import {
  createProviderClient,
  disposeProviderClient,
  getProviderDefinition,
  listOfficialModelIds,
  normalizeBaseUrl,
} from "../../providers/openai-compatible.js";
import { selectMany, selectOne } from "../selection.js";
import type { CommandContext } from "./types.js";

interface ProviderChoice {
  label: string;
  baseURL?: string;
}

export async function runLoginCommand({
  registry,
  prompter,
}: CommandContext): Promise<number> {
  const deepseek = getProviderDefinition("deepseek");
  const openai = getProviderDefinition("openai");
  const providerChoice = await selectOne<ProviderChoice>(
    "Provider",
    [
      { label: deepseek.displayName, baseURL: deepseek.baseURL },
      { label: openai.displayName, baseURL: openai.baseURL },
      { label: "Custom OpenAI-compatible endpoint" },
    ],
    (item) => item.label,
    prompter,
  );
  if (providerChoice === undefined) return 0;

  const enteredBaseUrl = providerChoice.baseURL ?? (await prompter.ask("Base URL: "));
  const baseUrl = normalizeBaseUrl(enteredBaseUrl);
  let apiKey = (await prompter.askSecret("API Key: ")).trim();
  if (!apiKey) throw new Error("API Key cannot be empty");

  const client = createProviderClient(baseUrl, apiKey);
  try {
    prompter.write("Loading models from /models...\n");
    const modelIds = await listOfficialModelIds(client);
    if (modelIds.length === 0) throw new Error("The endpoint returned no models");

    const selected = await selectMany(
      "Available models",
      modelIds,
      (model) => model,
      prompter,
    );
    if (selected === undefined) return 0;

    const registered = await registry.registerMany(baseUrl, selected, apiKey);
    prompter.write(`\nRegistered ${registered.length} model(s):\n`);
    registered.forEach((model) => prompter.write(`  ${model.model_name}\n`));
    return 0;
  } finally {
    apiKey = "";
    await disposeProviderClient(client);
  }
}
