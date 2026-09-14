#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { SystemAuthStorage } from "../storage/auth-storage.js";
import { ModelRegistry } from "../storage/model-registry.js";
import { parseArgs, type CliCommand } from "./args.js";
import { runLoginCommand } from "./commands/login.js";
import { runLogoutCommand } from "./commands/logout.js";
import { runModelsCommand } from "./commands/models.js";
import { runTuiCommand } from "./commands/run.js";
import type { CommandHandler } from "./commands/types.js";
import { HELP } from "./help.js";
import { TerminalPrompter } from "./terminal.js";

type ManagementCommand = Exclude<CliCommand, "run">;

const COMMAND_HANDLERS: Record<ManagementCommand, CommandHandler> = {
  login: runLoginCommand,
  models: runModelsCommand,
  logout: runLogoutCommand,
};

export async function main(args = process.argv.slice(2)): Promise<number> {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${HELP}\n`);
    return 1;
  }

  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const registry = new ModelRegistry({ authStorage: new SystemAuthStorage() });

  if (options.command === "run") {
    try {
      return await runTuiCommand(registry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Everpeace failed: ${message}\n`);
      return 1;
    }
  }

  const prompter = new TerminalPrompter();

  try {
    return await COMMAND_HANDLERS[options.command]({ registry, prompter });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Everpeace failed: ${message}\n`);
    return 1;
  } finally {
    prompter.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
