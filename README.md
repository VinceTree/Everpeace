# Everpeace

The terminal transcript mirrors Codex's resize-reflow row caps. Source-backed replay keeps a terminal-specific tail: VS Code 1,000 rows, Windows Terminal 9,001, WezTerm 3,500, Alacritty 10,000, and 1,000 for other terminals. The estimate uses source text and the current terminal width because Ink does not expose final layout measurements. Session JSONL, model context, input navigation and `/outputs` retain their complete data.


**English** | [简体中文](./README.zh-CN.md)

Everpeace is a general-purpose ReAct agent with strong coding abilities and an interactive TUI. It supports DeepSeek, OpenAI, and custom OpenAI-compatible APIs. The selected model can search the web, read public pages, and request Bash tool calls. You can also run a local command directly with `!<command>`.

API keys are never read from environment variables or written to the project or configuration JSON. Everpeace stores keys in the operating system credential store. Its local model registry contains only the model name, base URL, and credential reference.

## Requirements

- Node.js 22+
- pnpm
- Bash on macOS/Linux, or Git Bash/WSL Bash on Windows
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

If `bash` is not in `PATH`, configure it explicitly:

```powershell
$env:EVERPEACE_BASH_PATH="D:\GitBash\Git\usr\bin\bash.exe"
```

## Usage

```text
✦ Everpeace Agent (v0.1.26) · 天下长平，以规司矩

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

The TUI's own interface is English throughout. While a turn is active, a provider-aware status such as `Waiting for DeepSeek (3s • ctrl+c to interrupt)` changes to `Working` during tool dispatch. Assistant replies render GitHub-flavored Markdown, including headings, lists, emphasis, links, tables, inline code, and fenced code. Fenced code and Bash/PowerShell commands use language-aware terminal highlighting with bounded-size safety fallbacks.

Commands are visually separate from conversation text: active commands show `Running`, completed model commands show `Ran`, and direct commands show `You ran`, with status color, shell, duration, and retained output underneath. Standard unified diffs in assistant `diff` fences or command output include old/new line gutters, cyan headers, green additions, and red deletions. True-color terminals receive light/dark-aware backgrounds; lower-color and `NO_COLOR` environments retain structural markers without requiring color. Restored legacy UI messages are translated for display without modifying session JSONL or translating user/assistant content.

The input area follows the terminal's available width and reserves the final column to prevent Windows Terminal from wrapping automatically. The startup model/directory panel uses Codex's 56-cell inner-width cap (60 columns including padding and borders), pre-truncates every row, and shrinks in narrower terminals without wrapping. The composer grows only for explicit newlines; long input is horizontally clipped instead of wrapping when the terminal font size changes.

The TUI runs inline, so the normal scroll wheel can browse the completed Everpeace conversation. After Ctrl + scroll wheel changes the font size, Everpeace performs a synchronized source-backed redraw after Codex's 75 ms trailing delay, restoring the complete banner and conversation without exposing an empty intermediate frame.

The first normal prompt creates a local JSONL session. Everpeace saves the conversation transcript and the model context needed to continue it, while a separate background model request generates a short title from that first prompt. Slash commands with informational or selection interfaces open an isolated temporary screen that hides the banner, transcript, composer, and global status bar. Command windows are centered horizontally and vertically, capped at 80 columns, and shrink with safe margins on narrow terminals. Press `Esc` to replay and return to the same session; command-screen contents are not added to session history. Direct `!` command output remains part of the recoverable transcript. `/new` immediately creates and enters an empty session; its temporary title is replaced after the first prompt. `/resume` lists every local session by title and last activity time, restores its original model and working directory, and continues appending to the same file. Session files live under the platform application-state directory (`%APPDATA%\Everpeace\sessions` on Windows).

`/status` opens a centered, isolated Codex-style command screen showing only status details and `Esc` return guidance. It shows the active model, provider inferred from `base_url`, endpoint, workspace, session ID, current context occupancy, and cumulative input/output tokens reported by the main Responses API loop. Usage totals are persisted with the session and restored by `/resume`, but the status screen itself is never added to the transcript; run `/status` again after restoring to see the recovered totals. Internal title-generation requests are excluded. Known official model IDs use documented context limits, while unknown or custom compatible models show `N/A` instead of a guessed limit.

Composer shortcuts follow Codex conventions: `Enter` submits; `Shift+Enter`, `Alt+Enter`, or `Ctrl+J` inserts a newline; `Home`/`End` and `Ctrl+A`/`Ctrl+E` move to the current line's start/end; `Ctrl+U`/`Ctrl+K` delete to the current line's start/end; `Ctrl+W` deletes the previous word; and `Ctrl+Y` restores the most recently killed text. Arrow keys, `Ctrl+B/F/P/N`, and `Alt+B/F` also move the cursor.

Typing `/` at the start of the composer opens a slash-command menu below the input. The list filters by case-insensitive prefix as you type, shows up to eight commands at once, and scrolls to any remaining matches. Use `Up`/`Down` or `Ctrl+P/N` to select, `Enter` to run the selected command, `Tab` to complete it without running, and `Esc` to dismiss the menu while keeping the input.

Everpeace disables terminal focus reporting at startup, shutdown, and after `!` commands, preventing `[I` and `[O` from appearing in the composer when switching windows.

TUI commands:

- `/login`: Sign in and activate a model immediately.
- `/model`: Switch to a registered model and reset the conversation context.
- `/models`: List all registered models and credential states.
- `/status`: Show the current model, provider, context window, and session token usage.
- `/permissions`: Select read-only, ask-for-approval, or full-access mode and toggle web tools.
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

Behavior notes:

- The core turn loop adapts Codex's sampling/tool/follow-up flow in TypeScript, with per-tool result persistence, cancellable request retries, and overlapping-turn protection. It is not the complete Codex runtime; see [source mapping and scope](docs/architecture/AGENT_LOOP.md).

- Model Bash requires confirmation by default (`ask`). `read-only` denies all model Bash; `full-access` skips approvals after a second explicit confirmation.
- `read_file` reads workspace UTF-8 files up to 128 KiB; `list_directory` lists up to 500 entries. Outside paths and resolved symlink escapes are rejected. File contents enter model context and persisted session data; avoid reading secrets.
- Permissions last for this process across `/new`, `/clear`, and `/resume`; restarting resets to `ask` with web tools enabled. Changing permissions preserves context; JSONL never restores full access.
- This is application-level permission management, not an OS sandbox. Approved Bash can access files and networks with your account permissions. Disabling web tools does not restrict shell networking, model API calls, or direct user commands. See [design and limits](docs/architecture/PERMISSIONS.md).
- Web search and public page reads are read-only tool calls and do not require confirmation. Search queries are sent to Bing, with DuckDuckGo as a fallback; opening a result sends a request to that site.
- Web page reads allow only public HTTP/HTTPS targets, validate redirects, block local/private network addresses, apply time and response-size limits, and treat returned content as untrusted data.
- Search availability and result quality depend on the external search services and the current network connection. A failed web request is returned to the model so it can explain the limitation or try another source.
- A direct `!<command>` is user-authored, requires no second confirmation, and is not added to model context.
- Model names come directly from the selected endpoint's `/models` response during login.
- Logging in again with the same `base_url + model_name` updates the key instead of creating a duplicate registration.
- Remote custom base URLs must use HTTPS; HTTP is allowed only for local endpoints.
- Everpeace fails closed if the operating system credential store is unavailable and never falls back to plaintext storage.
- Linux uses the persistent Secret Service and does not fall back to an in-memory kernel keyring.
- Bash commands run with the current user's permissions and have no additional sandbox.
- Every Bash call runs in a separate process, so `cd` and temporary environment variables do not persist between calls.
- The TUI requires an interactive terminal and reports an error when its input or output is redirected.

## Project structure

```text
src/
├─ cli/          # CLI entry point and login/models/logout/run commands
├─ agent/        # ReAct loop and session state
├─ providers/    # DeepSeek, OpenAI, and compatible endpoint adapters
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
- While model-requested Bash is running, its bounded live preview shows up to the first five and last five rows with an omission count, shrinking symmetrically on short terminals. Direct `!` commands continue to prioritize the latest five rows, and completed output keeps its compact summary. `/outputs` displays retained output (up to 10,000 lines / 2 MiB per UI record); truncated data cannot be recovered there. Model Bash captures stdout/stderr separately, up to 1 MiB each, and has no interactive stdin. Direct `!` commands retain interactive input.
