#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { parseArgs, type CliCommand } from "./args.js";
import type { CommandHandler } from "./commands/types.js";
import { HELP } from "./help.js";

type ManagementCommand = Exclude<CliCommand, "run" | "exec">;

async function managementHandlers(): Promise<Record<ManagementCommand, CommandHandler>> {
  const [{ runLoginCommand }, { runModelsCommand }, { runLogoutCommand }] = await Promise.all([
    import("./commands/login.js"),
    import("./commands/models.js"),
    import("./commands/logout.js"),
  ]);
  return { login: runLoginCommand, models: runModelsCommand, logout: runLogoutCommand };
}

async function createRegistry() {
  const [{ SystemAuthStorage }, { ModelRegistry }] = await Promise.all([
    import("../storage/auth-storage.js"),
    import("../storage/model-registry.js"),
  ]);
  return new ModelRegistry({ authStorage: new SystemAuthStorage() });
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args[0] === 'memory') { const {runMemoryCommand} = await import('./commands/memory.js'); return runMemoryCommand(args.slice(1)); }
  if (args[0] === "privacy") {
    const { runPrivacyCommand } = await import("./commands/privacy.js");
    return runPrivacyCommand(args.slice(1));
  }
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${HELP}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (options.command === "exec") {
    try {
      const [{ runExecCommand }, { createRequire }] = await Promise.all([
        import("./commands/exec.js"),
        import("node:module"),
      ]);
      const manifest = createRequire(import.meta.url)("../../package.json") as { version?: unknown };
      const version = typeof manifest.version === "string" ? manifest.version : undefined;
      return await runExecCommand(options, createRegistry, undefined, version === undefined ? {} : { version });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Everpeace failed: ${message}\n`);
      return 2;
    }
  }

  // Keep --help and exec prompt validation independent of Ink and native keyring bindings.
  let registry: Awaited<ReturnType<typeof createRegistry>>;
  try {
    registry = await createRegistry();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Everpeace failed: ${message}\n`);
    return 1;
  }

  if (options.command === "run") {
    try {
      const { runTuiCommand } = await import("./commands/run.js");
      return await runTuiCommand(registry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Everpeace failed: ${message}\n`);
      return 1;
    }
  }

  let TerminalPrompter: (typeof import("./terminal.js"))["TerminalPrompter"];
  let handlers: Record<ManagementCommand, CommandHandler>;
  try {
    [{ TerminalPrompter }, handlers] = await Promise.all([
      import("./terminal.js"),
      managementHandlers(),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Everpeace failed: ${message}\n`);
    return 1;
  }
  const prompter = new TerminalPrompter();

  try {
    return await handlers[options.command]({ registry, prompter });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Everpeace failed: ${message}\n`);
    return 1;
  } finally {
    prompter.close();
  }
}

const entrypoint = process.argv[1];
let canonicalEntrypoint: string | undefined;
try { canonicalEntrypoint = entrypoint ? pathToFileURL(realpathSync(entrypoint)).href : undefined; }
catch { /* Imported CLI modules may have a virtual or missing argv entry. */ }
if (entrypoint && (import.meta.url === pathToFileURL(entrypoint).href || import.meta.url === canonicalEntrypoint)) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
