export const HELP = `Everpeace - a minimal ReAct coding agent

Usage:
  everpeace                 Open the interactive TUI
  everpeace login           Register one or more models securely
  everpeace models          List registered models (API Keys are never shown)
  everpeace logout          Remove registered models and their credentials

Commands inside the agent:
  !<command>                Run a Bash command directly
  /login                    Login and activate one model
  /model                    Switch the active model
  /models                   List registered models
  /new                      Create and enter a new session
  /resume                   List and resume local sessions
  /logout                   Remove models and credentials
  /clear                    Start a fresh session on the next prompt
  /help                     Show this help
  /exit                     Exit Everpeace

Environment:
  EVERPEACE_BASH_PATH       Bash executable path (default: bash from PATH)`;
