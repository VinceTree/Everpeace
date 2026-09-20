export const HELP = `Everpeace - a minimal ReAct coding agent

Usage:
  everpeace                 Open the interactive TUI
  everpeace login           Register one or more models securely
  everpeace models          List registered models (API Keys are never shown)
  everpeace logout          Remove registered models and their credentials

Commands inside the agent:
  !<command>                Run a native shell command directly
  /login                    Login and activate one model
  /model                    Switch the active model
  /models                   List registered models
  /status                   Show model, context, and token usage
  /permissions              Select read-only, ask, workspace-write, or full-access tools
  /mcp                      Refresh and inspect Codex MCP servers and tools
  /skills                   Create, install, inspect, and use local skills
  /plan                     Enter strict planning mode or plan a request
  /goal                     Create, inspect, pause, or resume a session goal
  /new                      Create and enter a new session
  /resume                   List and resume local sessions
  /logout                   Remove models and credentials
  /clear                    Start a fresh session on the next prompt
  /help                     Show this help
  /exit                     Exit Everpeace
  /outputs                  Browse retained command output
  /history                  Browse or clear global input history
  /terminal-setup           Configure Windows Terminal Shift+Enter

Environment:
  EVERPEACE_BASH_PATH       macOS/Linux model Bash path (default: bash from PATH)`;
