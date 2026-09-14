import { selectMany } from "../selection.js";
import { modelStatusLabel } from "./models.js";
import type { CommandContext } from "./types.js";

export async function runLogoutCommand({
  registry,
  prompter,
}: CommandContext): Promise<number> {
  const models = await registry.listStatuses();
  if (models.length === 0) {
    prompter.write("No registered models.\n");
    return 0;
  }

  const selected = await selectMany(
    "Registered models",
    models,
    modelStatusLabel,
    prompter,
  );
  if (selected === undefined) return 0;

  const answer = await prompter.ask(
    `Delete ${selected.length} model registration(s) and their credentials? [y/N] `,
  );
  if (!/^(y|yes)$/i.test(answer.trim())) {
    prompter.write("Logout cancelled.\n");
    return 0;
  }

  const removed = await registry.removeMany(selected.map((model) => model.id));
  prompter.write(`Removed ${removed.length} model registration(s).\n`);
  return 0;
}
