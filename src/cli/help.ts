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
  /logout                   Remove models and credentials
  /clear                    Clear the conversation
  /help                     Show this help
  /exit                     Exit Everpeace

Environment:
  EVERPEACE_BASH_PATH       Bash executable path (default: bash from PATH)`;
