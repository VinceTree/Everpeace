/** Slash-command catalog, parser, and help text shared by the TUI. */
export const SLASH_COMMANDS = [
  "/login",
  "/model",
  "/models",
  "/status",
  "/permissions",
  "/mcp",
  "/skills",
  "/memory",
  "/new",
  "/resume",
  "/logout",
  "/clear",
  "/help",
  "/exit",
  "/outputs",
  "/history",
  "/terminal-setup",
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export function filterSlashCommands(input: string): SlashCommand[] {
  if (input.includes("\n") || input.includes("\r")) return [];

  const query = input.trimStart();
  if (!query.startsWith("/") || /\s/u.test(query)) return [];

  const normalizedQuery = query.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.startsWith(normalizedQuery));
}

export type ParsedTuiInput =
  | { kind: "empty" }
  | { kind: "chat"; text: string }
  | { kind: "bash"; command: string }
  | { kind: "slash"; command: SlashCommand; args?: string }
  | { kind: "unknown"; command: string };

function isSlashCommand(value: string): value is SlashCommand {
  return (SLASH_COMMANDS as readonly string[]).includes(value);
}

export function parseTuiInput(input: string): ParsedTuiInput {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.startsWith("!")) {
    return { kind: "bash", command: trimmed.slice(1).trimStart() };
  }
  if (trimmed.startsWith("/")) {
    const command = trimmed.split(/\s+/, 1)[0]!.toLowerCase();
    return isSlashCommand(command)
      ? (() => {
          const args = trimmed.slice(command.length).trim();
          return args ? { kind: "slash", command, args } : { kind: "slash", command };
        })()
      : { kind: "unknown", command };
  }
  return { kind: "chat", text: trimmed };
}

export const TUI_HELP = `Slash commands
  /login   Sign in and activate a model
  /model   Switch between signed-in models
  /models  View models and credential status
  /status  View session, model, and token usage
  /permissions  Select read-only, ask, workspace-write, or full-access tools
  /mcp     Refresh and inspect Codex MCP servers and tools
  /skills  Create, install, inspect, and use local skills
  /memory  View and manage learned experience
  /new     Create and enter a new session
  /resume  Find and resume a local session
  /logout  Remove models and system credentials
  /clear   End this conversation; the next message starts a session
  /help    Show this help
  /exit    Exit Everpeace
  /outputs Browse retained command output
  /history Browse or clear global input history
  /terminal-setup Configure the Windows Terminal newline shortcut

Direct shell
  !<command>  Run a command directly without confirmation`;
