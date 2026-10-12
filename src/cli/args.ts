import type { TeamOptions } from "../team/types.js";
export type CliCommand = "run" | "login" | "models" | "logout" | "exec";

interface BaseCliOptions {
  command: CliCommand;
  help: boolean;
}

export interface InteractiveCliOptions extends BaseCliOptions {
  command: "run" | "login" | "models" | "logout";
}

export interface ExecCliOptions extends BaseCliOptions {
  command: "exec";
  team?: TeamOptions;
  /** A prompt supplied as the sole positional argument. */
  prompt?: string;
  directory?: string;
  model?: string;
  resume?: string;
  plan?: boolean;
  permissionMode?: "read-only" | "ask" | "workspace-write";
  json: boolean;
  tokenBudget?: number;
  timeoutMs?: number;
  maxSteps?: number;
}

export type CliOptions = InteractiveCliOptions | ExecCliOptions;

export interface ExecPromptInput {
  stdinIsTTY: boolean;
  /** The complete UTF-8 stdin body. Omit it while stdin is a TTY. */
  stdinText?: string;
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

const COMMANDS = new Set<CliCommand>(["run", "login", "models", "logout", "exec"]);
const EXEC_VALUE_OPTIONS = new Map<string, keyof Pick<ExecCliOptions, "directory" | "model" | "resume" | "permissionMode" | "tokenBudget" | "timeoutMs" | "maxSteps">>([
  ["-C", "directory"],
  ["--model", "model"],
  ["--resume", "resume"],
  ["--permission-mode", "permissionMode"],
  ["--token-budget", "tokenBudget"],
  ["--timeout-ms", "timeoutMs"],
  ["--max-steps", "maxSteps"],
]);
const EXEC_FLAGS = new Set(["--json", "--plan", "--team"]);
const TEAM_VALUES = new Set(["--explorer-model", "--worker-model", "--reviewer-model", "--max-agents", "--team-max-attempts", "--resume-team"]);

function isCliCommand(value: string): value is CliCommand {
  return COMMANDS.has(value as CliCommand);
}

function positiveInteger(option: string, value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new CliArgumentError(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliArgumentError(`${option} must be a safe positive integer`);
  }
  return parsed;
}

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value === "--" || EXEC_VALUE_OPTIONS.has(value) || TEAM_VALUES.has(value) || EXEC_FLAGS.has(value) || value === "--help" || value === "-h") {
    throw new CliArgumentError(`Missing value for ${option}`);
  }
  return value;
}

function duplicate(option: string): never {
  throw new CliArgumentError(`Argument may only be specified once: ${option}`);
}

function parseExecArgs(args: readonly string[], helpSeen: boolean): ExecCliOptions {
  let help = helpSeen;
  let prompt: string | undefined;
  let directory: string | undefined;
  let model: string | undefined;
  let resume: string | undefined;
  let permissionMode: ExecCliOptions["permissionMode"];
  let plan = false;
  let json = false;
  let tokenBudget: number | undefined;
  let timeoutMs: number | undefined;
  let maxSteps: number | undefined;
  let positionalOnly = false;
  let team: TeamOptions | undefined;
  const teamSeen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;

    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && (argument === "--help" || argument === "-h")) {
      if (help) duplicate(argument);
      help = true;
      continue;
    }

    if (!positionalOnly && (argument === "--team" || TEAM_VALUES.has(argument))) {
      if (teamSeen.has(argument)) duplicate(argument);
      teamSeen.add(argument); team ??= { enabled: true };
      if (argument !== "--team") {
        const value = requireValue(args, index, argument); index++;
        if (argument === "--max-agents") { team.maxAgents = positiveInteger(argument, value); if (team.maxAgents > 3) throw new CliArgumentError("--max-agents must be from 1 to 3"); }
        else if (argument === "--team-max-attempts") team.maxAttempts = positiveInteger(argument, value);
        else if (argument === "--resume-team") team.resumeTeamId = value;
        else { const role = argument.slice(2, -6) as "explorer" | "worker" | "reviewer"; team.models = { ...team.models, [role]: value }; }
      }
      continue;
    }
    if (!positionalOnly && argument === "--json") {
      if (json) duplicate(argument);
      json = true;
      continue;
    }

    if (!positionalOnly && argument === "--plan") {
      if (plan) duplicate(argument);
      plan = true;
      continue;
    }

    if (!positionalOnly && EXEC_VALUE_OPTIONS.has(argument)) {
      const field = EXEC_VALUE_OPTIONS.get(argument)!;
      if (field === "directory" && directory !== undefined) duplicate(argument);
      if (field === "model" && model !== undefined) duplicate(argument);
      if (field === "resume" && resume !== undefined) duplicate(argument);
      if (field === "permissionMode" && permissionMode !== undefined) duplicate(argument);
      if (field === "tokenBudget" && tokenBudget !== undefined) duplicate(argument);
      if (field === "timeoutMs" && timeoutMs !== undefined) duplicate(argument);
      if (field === "maxSteps" && maxSteps !== undefined) duplicate(argument);
      const value = requireValue(args, index, argument);
      index += 1;
      if (field === "directory") {
        directory = value;
      } else if (field === "model") {
        model = value;
      } else if (field === "resume") {
        if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new CliArgumentError("--resume requires a local Session ID");
        resume = value;
      } else if (field === "permissionMode") {
        if (value !== "read-only" && value !== "ask" && value !== "workspace-write") {
          throw new CliArgumentError("--permission-mode must be read-only, ask, or workspace-write");
        }
        permissionMode = value;
      } else {
        const parsed = positiveInteger(argument, value);
        if (field === "tokenBudget") {
          tokenBudget = parsed;
        } else if (field === "timeoutMs") {
          timeoutMs = parsed;
        } else {
          maxSteps = parsed;
        }
      }
      continue;
    }

    if (!positionalOnly && argument.startsWith("-")) {
      throw new CliArgumentError(`Unknown argument: ${argument}`);
    }
    if (prompt !== undefined) {
      throw new CliArgumentError("exec accepts only one positional prompt");
    }
    if (argument.length === 0) {
      throw new CliArgumentError("The exec prompt cannot be empty");
    }
    prompt = argument;
  }

  if (resume !== undefined && model !== undefined) {
    throw new CliArgumentError("--resume uses the saved model; --model cannot be combined with it");
  }
  return {
    command: "exec",
    help,
    json,
    ...(team ? { team } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    ...(directory === undefined ? {} : { directory }),
    ...(model === undefined ? {} : { model }),
    ...(resume === undefined ? {} : { resume }),
    ...(plan ? { plan: true } : {}),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
  };
}

export function parseArgs(args: readonly string[]): CliOptions {
  let command: Exclude<CliCommand, "exec"> = "run";
  let help = false;
  let commandSeen = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      if (help) duplicate(argument);
      help = true;
      continue;
    }

    if (!commandSeen && isCliCommand(argument)) {
      if (argument === "exec") return parseExecArgs(args.slice(index + 1), help);
      command = argument;
      commandSeen = true;
      continue;
    }

    throw new CliArgumentError(`Unknown argument or command: ${argument}`);
  }

  return { command, help };
}

/** Resolve the single allowed prompt source after stdin has been read, if needed. */
export function resolveExecPrompt(options: ExecCliOptions, input: ExecPromptInput): string {
  const stdinPrompt = input.stdinIsTTY ? undefined : input.stdinText;
  const hasStdinBytes = stdinPrompt !== undefined && stdinPrompt.length > 0;

  if (options.prompt !== undefined && hasStdinBytes) {
    throw new CliArgumentError("Provide the exec prompt as either an argument or stdin, not both");
  }
  if (options.prompt !== undefined) {
    if (!options.prompt.trim()) throw new CliArgumentError("The exec prompt cannot be blank");
    return options.prompt;
  }
  if (hasStdinBytes) {
    if (!stdinPrompt.trim()) throw new CliArgumentError("Piped stdin did not contain a non-blank exec prompt");
    return stdinPrompt;
  }
  if (input.stdinIsTTY) {
    throw new CliArgumentError("Missing exec prompt: provide one argument or pipe stdin");
  }
  throw new CliArgumentError("Piped stdin did not contain an exec prompt");
}
