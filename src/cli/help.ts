export const EXEC_HELP = `Non-interactive execution:
  everpeace exec [prompt] [-C <directory>] [--model <id-or-name>]
               [--resume <session-id>]
               [--json] [--token-budget <n>]
               [--timeout-ms <n>] [--max-steps <n>]

  Supply the prompt as one positional argument or through piped stdin.
  --resume continues a same-workspace Session in a new child using its saved model.
  A new prompt is required; --resume and --model cannot be combined.
  --json writes versioned JSONL events to stdout.

Exec exit codes:
  0   Verified changes or no changes
  1   Runtime failure
  2   Invalid arguments or startup configuration
  3   Failed or unverified host verification
  4   Token, usage, step, or deadline limit
  5   Approval or structured input required
  130 Interrupted by SIGINT
  143 Terminated by SIGTERM`;

export const HELP = `Everpeace - a DeepSeek-first personal development agent

Usage:
  everpeace                 Open the interactive TUI
  everpeace exec [prompt]   Run one non-interactive task (or pipe the prompt)
  everpeace login           Register one or more models securely
  everpeace models          List registered models (API Keys are never shown)
  everpeace logout          Remove registered models and their credentials

${EXEC_HELP}

Commands inside the agent:
  !<command>                Run a native shell command directly
  /login                    Login and activate one model
  /model                    Switch the active model
  /models                   List registered models
  /status                   Show model, context, and token usage
  /diff                     Show bounded workspace changes
  /verify                   Run discovered checks, or /verify <command>
  /undo                     Undo the latest Agent turn when safe
  /permissions              Select read-only, ask, workspace-write, or full-access tools
  /mcp                      Refresh and inspect Codex MCP servers and tools
  /skills                   Create, install, inspect, and use local skills
  /plan                     Enter strict planning mode or plan a request
  /goal                     Create, inspect, pause, or resume a session goal
  /compact                  Compact the model context
  /new                      Create and enter a new session
  /fork [title]             Fork the current idle session and enter the child
  /resume                   List, resume, or permanently batch-delete local sessions
  /logout                   Remove models and credentials
  /clear                    Start a fresh session on the next prompt
  /help                     Show this help
  /exit                     Exit Everpeace
  /outputs                  Browse retained command output
  /history                  Browse or clear global input history
  /terminal-setup           Configure Windows Terminal Shift+Enter

Environment:
  EVERPEACE_BASH_PATH       macOS/Linux model Bash path (default: bash from PATH)`;
