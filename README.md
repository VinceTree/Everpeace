# Everpeace

The terminal transcript mirrors Codex's resize-reflow row caps. Source-backed replay keeps a terminal-specific tail: VS Code 1,000 rows, Windows Terminal 9,001, WezTerm 3,500, Alacritty 10,000, and 1,000 for other terminals. The estimate uses source text and the current terminal width because Ink does not expose final layout measurements. Session JSONL, model context, input navigation and `/outputs` retain their complete data.


**English** | [简体中文](./README.zh-CN.md)

Everpeace is a general-purpose ReAct agent with strong coding abilities and an interactive TUI. It supports DeepSeek, OpenAI, and custom OpenAI-compatible APIs. The selected model can use a Codex-sandboxed shell, search the web, call configured MCP tools, and load local Codex skills. You can also run a local command directly with `!<command>`.

Model API keys are never read from environment variables or written to the project or configuration JSON. Everpeace stores them in the operating system credential store. Its local model registry contains only the model name, base URL, and credential reference. Separately, user-configured MCP servers may reference bearer tokens or headers through environment-variable names, following Codex MCP configuration.

## Requirements

- Node.js 22+
- pnpm
- Bash on macOS/Linux; Windows model commands use the system PowerShell inside the Codex sandbox
- An API key for DeepSeek, OpenAI, or a compatible service
- Outbound HTTPS access to Bing or DuckDuckGo and any public pages the agent reads

## Run in development

PowerShell:

```powershell
pnpm install
pnpm dev
```

macOS/Linux:

```bash
pnpm install
pnpm dev
```

After startup, enter `/login`. The TUI login wizard lets you choose a provider, enter a masked API key, and load the available models from `/models`:

- DeepSeek official API: `https://api.deepseek.com`
- OpenAI official API: `https://api.openai.com/v1`
- A custom OpenAI-compatible base URL

The API key is never displayed in the terminal. After validation, select one of the original model IDs returned by the server. Everpeace securely saves it and activates it for the current session:

```text
/login · Model login
❯ DeepSeek

API Key ❯ ********

Select a model:
❯ deepseek-flash
```

The legacy management subcommands remain available:

```powershell
pnpm dev -- login
pnpm dev -- models
pnpm dev -- logout
```

On macOS/Linux, if `bash` is not in `PATH`, configure it explicitly:

```powershell
$env:EVERPEACE_BASH_PATH="/custom/path/to/bash"
```

## Usage

```text
✦ Everpeace Agent (v0.2.2) · 天下长平，以规司矩

╭──────────────────────────────────────────────────────────╮
│ model:     deepseek-flash   /model to change             │
│ directory: C:\projects\Everpeace                         │
╰──────────────────────────────────────────────────────────╯

› List the files in this project

• I will inspect the current directory.

! ls -la
Run this command? y
...

› !git status
...

› What changed in the latest TypeScript release?

• Search web: latest TypeScript release
• Fetch web page: https://www.typescriptlang.org/...
...
```

For questions that depend on current or niche information, the model can call `web_search` and then use `web_fetch` to read promising sources. Search and page reads do not require Bash confirmation. Their function calls and results remain in the recoverable model context, while concise tool activity is shown in the TUI transcript. The model is instructed to cite the source URLs it used.

The TUI's own interface is English throughout. While a turn is active, a provider-aware status such as `Waiting for DeepSeek (3s • ctrl+c to interrupt)` changes to `Working` during tool dispatch. Responses-capable providers stream assistant text and tool progress live; compatible buffered endpoints still show phase, approval, and command previews. Assistant replies render GitHub-flavored Markdown, including headings, lists, emphasis, links, tables, inline code, and fenced code. Fenced code and Bash/PowerShell commands use language-aware terminal highlighting with bounded-size safety fallbacks.

Commands are visually separate from conversation text: active commands show `Running`, completed model commands show `Ran`, and direct commands show `You ran`, with status color, shell, duration, and retained output underneath. Standard unified diffs in assistant `diff` fences or command output include old/new line gutters, cyan headers, green additions, and red deletions. True-color terminals receive light/dark-aware backgrounds; lower-color and `NO_COLOR` environments retain structural markers without requiring color. Restored legacy UI messages are translated for display without modifying session JSONL or translating user/assistant content.

The input area follows the terminal's available width and reserves the final column to prevent Windows Terminal from wrapping automatically. The startup model/directory panel uses Codex's 56-cell inner-width cap (60 columns including padding and borders), pre-truncates every row, and shrinks in narrower terminals without wrapping. The composer grows only for explicit newlines; long input is horizontally clipped instead of wrapping when the terminal font size changes.

The TUI runs inline, so the normal scroll wheel can browse the completed Everpeace conversation. After Ctrl + scroll wheel changes the font size, Everpeace performs a synchronized source-backed redraw after Codex's 75 ms trailing delay, restoring the complete banner and conversation without exposing an empty intermediate frame.

The first normal prompt creates a local JSONL session. Everpeace saves the conversation transcript and the model context needed to continue it, while a separate background model request generates a short title from that first prompt. Slash commands with informational or selection interfaces open an isolated temporary screen that hides the banner, transcript, composer, and global status bar. Command windows are centered horizontally and vertically, capped at 80 columns, and shrink with safe margins on narrow terminals. Press `Esc` to replay and return to the same session; command-screen contents are not added to session history. Direct `!` command output remains part of the recoverable transcript. `/new` immediately creates and enters an empty session; its temporary title is replaced after the first prompt. `/resume` lists every local session by title and last activity time, restores its original model and working directory, and continues appending to the same file. Session files live under the platform application-state directory (`%APPDATA%\Everpeace\sessions` on Windows).

Everpeace also keeps a separate learned-experience memory. After a substantive, successfully completed turn, the current model may extract reusable project lessons in the background. Explicit long-term preferences are stored separately at user scope. Memory is stored under the platform application-state directory (`%APPDATA%\Everpeace\memory` on Windows), is not written into the repository, and is injected only into the first request of a new Agent instance as untrusted background context. Secrets are redacted, entries are deduplicated and capped, and current user instructions and repository evidence always take precedence.

`/status` opens a centered, isolated Codex-style command screen showing only status details and `Esc` return guidance. It shows the active model, provider inferred from `base_url`, endpoint, workspace, session ID, current context occupancy, and cumulative input/output tokens reported by the main Responses API loop. Usage totals are persisted with the session and restored by `/resume`, but the status screen itself is never added to the transcript; run `/status` again after restoring to see the recovered totals. Internal title-generation requests are excluded. Known official model IDs use documented context limits, while unknown or custom compatible models show `N/A` instead of a guessed limit.

Composer shortcuts follow Codex conventions: `Enter` submits; `Shift+Enter`, `Alt+Enter`, or `Ctrl+J` inserts a newline; `Home`/`End` and `Ctrl+A`/`Ctrl+E` move to the current line's start/end; `Ctrl+U`/`Ctrl+K` delete to the current line's start/end; `Ctrl+W` deletes the previous word; and `Ctrl+Y` restores the most recently killed text. Arrow keys, `Ctrl+B/F/P/N`, and `Alt+B/F` also move the cursor.

Typing `/` at the start of the composer opens a slash-command menu below the input. The list filters by case-insensitive prefix as you type, shows up to eight commands at once, and scrolls to any remaining matches. Use `Up`/`Down` or `Ctrl+P/N` to select, `Enter` to run the selected command, `Tab` to complete it without running, and `Esc` to dismiss the menu while keeping the input.

Everpeace disables terminal focus reporting at startup, shutdown, and after `!` commands, preventing `[I` and `[O` from appearing in the composer when switching windows.

TUI commands:

- `/login`: Sign in and activate a model immediately.
- `/model`: Switch to a registered model and reset the conversation context.
- `/models`: List all registered models and credential states.
- `/status`: Show the current model, provider, context window, and session token usage.
- `/permissions`: Select read-only, ask-for-approval, workspace-write, or full-access mode and toggle web tools.
- `/mcp`: Reload Codex MCP configuration, connect enabled servers, and inspect server/tool status.
- `/skills`: Create, install, inspect, and explicitly invoke local Skills.
- `/memory`: View learned experience, pause/resume automatic capture, inspect the injected snapshot with `/memory view`, clear project or user entries, or run `/memory remember <preference>` to save a lasting user preference.
- `/outputs`: Browse retained command output with paged details, highlighted commands, and unified-diff rendering.
- `/history`: Browse or explicitly clear global input history (not sessions).
- `/terminal-setup`: Preview and optionally configure Shift+Enter in stable Windows Terminal; confirmation creates a settings backup before applying a global key binding.
- `/new`: Immediately create and enter a new local session.
- `/resume`: List and resume local JSONL sessions.
- After `/resume`, Up/Down browse that session's saved user prompts and direct commands with source metadata; Down past the newest entry returns to an empty draft. Recalled slash commands do not open the command menu until edited. `/history` still shows global input history.
- `/logout`: Select and remove models with their operating system credentials.
- `/clear`: End the current conversation and start a fresh session on the next prompt while retaining the active model.
- `/help`, `/exit`: Show help or exit Everpeace.
- `!<command>`: Run a command directly in the native system shell (PowerShell on Windows, Bash on macOS/Linux) without confirmation. PTY-formatted output streams into the TUI history without suspending or refreshing the whole interface.

MCP uses the same Codex configuration rather than an Everpeace-specific credential file. Configure servers with `pnpm exec codex mcp add ...` or an equivalent installed Codex CLI, then run `/mcp`. This release supports stdio and Streamable HTTP tools, including static/environment headers and bearer-token environment variables. Codex OAuth credential reuse, header helpers, resources, prompts, elicitation, and tasks are not yet exposed.

Skills are discovered from `.agents/skills` between the workspace and repository root, the project `.codex/skills`, `$CODEX_HOME/skills`, `~/.agents/skills`, and the platform admin root. Mention `$skill-name` to activate one explicitly for the current turn; otherwise the model can match catalog descriptions and call `read_skill`. Skill metadata is preloaded, while complete instructions and referenced files are read only when needed.

`/skills` is an interactive manager with three flows:

- **Create**: choose project or user scope, describe the workflow, let the active model draft one `SKILL.md`, then validate/improve it with AI, edit the complete file manually, or confirm and save it.
- **Install from URL**: enter a public HTTPS GitHub repository/folder, Git repository root, direct `SKILL.md`, or ZIP URL. Everpeace downloads into temporary staging, validates every discovered package, lets you choose one when the source contains several, previews the complete `SKILL.md` with source and file count, then requires scope selection and explicit confirmation before installation. Git sources are cloned without a working-tree checkout first; Everpeace inspects the bounded repository tree, collapses mirrored packages with the same Skill name in favor of canonical `skills/<name>` directories, and checks out only validated candidate directories. Repositories may therefore contain more manifest files than distinct installable Skills without failing the candidate limit.
- **View installed Skills**: browse a compact catalog with scope, readiness/conflict state, and a two-line description before opening the complete instructions; select **Use in next prompt** to prefill `$skill-name` in the composer.

Project installs go to the repository root's `.agents/skills`; user installs go to `$CODEX_HOME/skills` (normally `~/.codex/skills`). Existing names are never overwritten, and duplicate names across discovered roots are marked as conflicts and withheld from automatic or explicit activation until resolved. URL installation is public-only, accepts no embedded credentials, validates every redirect against local/private addresses, applies download/extraction/file limits, rejects path traversal and symbolic links, and installs through a temporary directory. Private repositories, authenticated downloads, updates, and deletion are outside the current flow. See [Codex capability mapping](docs/architecture/CODEX_CAPABILITIES.md).

Behavior notes:

- The core turn loop adapts Codex's sampling/tool/follow-up flow in TypeScript, with per-tool result persistence, cancellable request retries, and overlapping-turn protection. It is not the complete Codex runtime; see [source mapping and scope](docs/architecture/AGENT_LOOP.md).

- Permission profiles keep sandbox scope separate from approvals: `read-only` asks before model shell, web, and MCP calls and uses Codex `:read-only`; `ask` asks before each call and uses `:workspace` after shell approval; `workspace-write` runs model shell in `:workspace` without per-command prompts while web and MCP still ask; `full-access` selects `:danger-full-access` after a second explicit confirmation.
- `read_file` reads workspace UTF-8 files up to 128 KiB; `list_directory` lists up to 500 entries. Outside paths and resolved symlink escapes are rejected. File contents enter model context and persisted session data; avoid reading secrets.
- Permissions last for this process across `/new`, `/clear`, and `/resume`; restarting resets to `workspace-write` with web tools enabled. Changing permissions preserves context; JSONL never restores full access.
- Model shell commands are launched through the pinned `@openai/codex@0.155.1` native OS sandbox and fail closed if that runtime cannot start. Windows model commands use PowerShell because Git Bash/MSYS cannot initialize inside the restricted token; macOS/Linux use Bash. Direct `!` commands remain outside the model sandbox. See [design and limits](docs/architecture/PERMISSIONS.md).
- `read-only`, `ask`, and `workspace-write` require approval before each web request; `full-access` skips that prompt. Search queries are sent to Bing, with DuckDuckGo as a fallback; opening a result sends a request to that site.
- Web page reads allow only public HTTP/HTTPS targets, validate redirects, block local/private network addresses, apply time and response-size limits, and treat returned content as untrusted data.
- Search availability and result quality depend on the external search services and the current network connection. A failed web request is returned to the model so it can explain the limitation or try another source.
- A direct `!<command>` is user-authored, requires no second confirmation, and is not added to model context.
- Model names come directly from the selected endpoint's `/models` response during login.
- Logging in again with the same `base_url + model_name` updates the key instead of creating a duplicate registration.
- Remote custom base URLs must use HTTPS; HTTP is allowed only for local endpoints.
- Everpeace fails closed if the operating system credential store is unavailable and never falls back to plaintext storage.
- Linux uses the persistent Secret Service and does not fall back to an in-memory kernel keyring.
- Every model shell call runs in a separate Codex sandbox process, so `cd` and temporary environment variables do not persist between calls. `full-access` intentionally retains the current user's authority.
- The TUI requires an interactive terminal and reports an error when its input or output is redirected.

While a model turn is running, the composer stays available with the `Add guidance while working` placeholder. Submitted messages are recorded immediately and applied at the next safe checkpoint: sampling is interrupted when possible, while an already-running tool is allowed to checkpoint its result first. The model then continues with the durable context and your correction. `Ctrl+C` still cancels the active turn immediately; any submitted guidance is retained in the session context for the next turn. Elapsed time uses `s`, then `m s`, then `h m s` after the corresponding thresholds.

## Project structure

```text
src/
├─ cli/          # CLI entry point and login/models/logout/run commands
├─ agent/        # ReAct loop and session state
├─ codex/        # Pinned Codex CLI launcher
├─ mcp/          # Codex-configured MCP client runtime
├─ providers/    # DeepSeek, OpenAI, and compatible endpoint adapters
├─ skills/       # Codex host skill discovery and progressive reads
├─ storage/      # Operating system credentials and model registry
├─ tui/          # Ink views, state machine, login wizard, and composer
└─ tools/        # Agent tool definitions and executors

tests/unit/      # Unit tests organized by source domain
```

## Build and install

Install from this repository with pnpm so the checked-in Windows node-pty fixes are applied. The GitHub Release distributes source; installing this project as an npm dependency does not inherit its pnpm patches.

```powershell
pnpm build
pnpm link --global
everpeace login
everpeace models
everpeace
everpeace logout
```

## Verification

```powershell
pnpm typecheck
pnpm test
pnpm build
```
- Ctrl+C cancels the active model turn, approval wait, or shell command without exiting. When idle, it clears a nonempty draft; with an empty draft it exits.
- Up/Down browse previous input at the first/last line and restore the current draft. Slash-menu selection takes precedence. Modified Enter inserts a newline when supported; multiline bracketed paste never submits automatically. Windows Terminal may require `/terminal-setup` to distinguish Shift+Enter from Enter.
- Input history is shared across restarts: up to 1,000 entries / 4 MiB in `input-history.json` next to the sessions directory. Login wizard secrets are excluded, but manually typed secrets in prompts or commands are not automatically redacted. Clearing history does not remove session records.
- While a model-requested shell command is running, its bounded live preview shows up to the first five and last five rows with an omission count, shrinking symmetrically on short terminals. Direct `!` commands continue to prioritize the latest five rows, and completed output keeps its compact summary. `/outputs` displays retained output (up to 10,000 lines / 2 MiB per UI record); truncated data cannot be recovered there. Model shell commands capture stdout/stderr separately, up to 1 MiB each, and have no interactive stdin. Direct `!` commands retain interactive input.
