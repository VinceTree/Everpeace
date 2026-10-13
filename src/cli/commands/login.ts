import {uiText} from '../../localization/messages.js';
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
      { label: uiText('m7eab6c328d7f') },
    ],
    (item) => item.label,
    prompter,
  );
  if (providerChoice === undefined) return 0;

  const enteredBaseUrl = providerChoice.baseURL ?? (await prompter.ask(uiText('mec8767f0fce9')));
  const baseUrl = normalizeBaseUrl(enteredBaseUrl);
  let apiKey = (await prompter.askSecret(uiText('m813ab6ed359d'))).trim();
  if (!apiKey) throw new Error(uiText('m711c7dc1ec2c'));

  const client = createProviderClient(baseUrl, apiKey);
  try {
    prompter.write(uiText('ma957319ba9ee'));
    const modelIds = await listOfficialModelIds(client);
    if (modelIds.length === 0) throw new Error(uiText('m67b406354aee'));

    const selected = await selectMany(
      uiText('m9dbfd0478bd5'),
      modelIds,
      (model) => model,
      prompter,
    );
    if (selected === undefined) return 0;

    const registered = await registry.registerMany(baseUrl, selected, apiKey);
    prompter.write(uiText('me853f3330285', {p0: registered.length}));
    registered.forEach((model) => prompter.write(`  ${model.model_name}\n`));
    return 0;
  } finally {
    apiKey = "";
    await disposeProviderClient(client);
  }
}
