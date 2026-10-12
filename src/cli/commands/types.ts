import type { ModelRegistry } from "../../storage/model-registry.js";
import type { Prompter } from "../terminal.js";

export interface CommandContext {
  registry: ModelRegistry;
  prompter: Prompter;
}

export type CommandHandler = (context: CommandContext) => Promise<number>;
