export type CliCommand = "run" | "login" | "models" | "logout";

export interface CliOptions {
  command: CliCommand;
  help: boolean;
}

const COMMANDS = new Set<CliCommand>(["run", "login", "models", "logout"]);

function isCliCommand(value: string): value is CliCommand {
  return COMMANDS.has(value as CliCommand);
}

export function parseArgs(args: string[]): CliOptions {
  let command: CliCommand = "run";
  let help = false;
  let commandSeen = false;

  for (const argument of args) {
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    if (!commandSeen && isCliCommand(argument)) {
      command = argument;
      commandSeen = true;
      continue;
    }

    throw new Error(`Unknown argument or command: ${argument}`);
  }

  return { command, help };
}
