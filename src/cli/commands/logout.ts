import {uiText} from '../../localization/messages.js';
import { selectMany } from "../selection.js";
import { modelStatusLabel } from "./models.js";
import type { CommandContext } from "./types.js";

export async function runLogoutCommand({
  registry,
  prompter,
}: CommandContext): Promise<number> {
  const models = await registry.listStatuses();
  if (models.length === 0) {
    prompter.write(uiText('mbc0d67c5a1d3'));
    return 0;
  }

  const selected = await selectMany(
    uiText('m7cf0531e3810'),
    models,
    modelStatusLabel,
    prompter,
  );
  if (selected === undefined) return 0;

  const answer = await prompter.ask(
    uiText('mee558ff68b9d', {p0: selected.length}),
  );
  if (!/^(y|yes)$/i.test(answer.trim())) {
    prompter.write(uiText('m0ae5ad2d0d6c'));
    return 0;
  }

  const removed = await registry.removeMany(selected.map((model) => model.id));
  prompter.write(uiText('mec0c19e7fd29', {p0: removed.length}));
  return 0;
}
