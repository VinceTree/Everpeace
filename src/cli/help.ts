export const EXEC_HELP = `Non-interactive execution:
  Collaboration: --team [--explorer-model <id>] [--worker-model <id>]
                 [--reviewer-model <id>] [--max-agents <1..3>]
                 [--team-max-attempts <n>] [--resume-team <id>]
  everpeace exec [prompt] [-C <directory>] [--model <id-or-name>]
               [--resume <session-id>]
               [--plan] [--json] [--token-budget <n>]
               [--permission-mode <mode>] [--timeout-ms <n>] [--max-steps <n>]

  Supply the prompt as one positional argument or through piped stdin.
  --resume continues a same-workspace Session in a new child using its saved model.
  --resume-team with --resume explicitly continues its retained root team.
  A new prompt is required; --resume and --model cannot be combined.
  --plan inspects the workspace and prints a submitted implementation plan
  without editing files; it never auto-approves execution.
  --permission-mode <read-only|ask|workspace-write> overrides the saved
  permission tier for this run; full-access is never selectable from exec.
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
  /privacy                  Inspect retention, scan or safely export local Sessions
  /perf                     Show the latest task performance report
  /memory                   Inspect and review learned entries
  /cost                     Configure user prices and estimated-cost alerts
  /web                      Configure HTML search or the Brave provider
  !<command>                Run a native shell command directly
  /login                    Login and activate one model
  /model                    Switch the active model
  /model profile <profile>  Set auto, generic, or deepseek Responses settings
  /models                   List registered models
  /team [on|off|team-id]     Configure collaboration or inspect retained members
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
