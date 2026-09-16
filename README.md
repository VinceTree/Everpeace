# Everpeace

**English** | [简体中文](./README.zh-CN.md)

Everpeace is a ReAct coding agent with an interactive TUI. It supports DeepSeek, OpenAI, and custom OpenAI-compatible APIs. Regular messages are handled by the selected model, which may request Bash tool calls. You can also run a local command directly with `!<command>`.

API keys are never read from environment variables or written to the project or configuration JSON. Everpeace stores keys in the operating system credential store. Its local model registry contains only the model name, base URL, and credential reference.

## Requirements

- Node.js 22+
- pnpm
- Bash on macOS/Linux, or Git Bash/WSL Bash on Windows
- An API key for DeepSeek, OpenAI, or a compatible service

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
✦ Everpeace Agent (v0.1.19) · 天下长平，以规司矩

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
```

The input area follows the terminal's available width and reserves the final column to prevent Windows Terminal from wrapping automatically. The startup model/directory panel uses Codex's 56-cell inner-width cap (60 columns including padding and borders), pre-truncates every row, and shrinks in narrower terminals without wrapping. The composer grows only for explicit newlines; long input is horizontally clipped instead of wrapping when the terminal font size changes.

The TUI runs inline, so the normal scroll wheel can browse the completed Everpeace conversation. After Ctrl + scroll wheel changes the font size, Everpeace performs a synchronized source-backed redraw after Codex's 75 ms trailing delay, restoring the complete banner and conversation without exposing an empty intermediate frame.

The first normal prompt creates a local JSONL session. Everpeace saves the visible transcript and the model context needed to continue the conversation, while a separate background model request generates a short title from that first prompt. `/new` immediately creates and enters an empty session; its temporary title is replaced after the first prompt. `/resume` lists every local session by title and last activity time, restores its original model and working directory, and continues appending to the same file. Session files live under the platform application-state directory (`%APPDATA%\Everpeace\sessions` on Windows).

Composer shortcuts follow Codex conventions: `Enter` submits; `Shift+Enter`, `Alt+Enter`, or `Ctrl+J` inserts a newline; `Home`/`End` and `Ctrl+A`/`Ctrl+E` move to the current line's start/end; `Ctrl+U`/`Ctrl+K` delete to the current line's start/end; `Ctrl+W` deletes the previous word; and `Ctrl+Y` restores the most recently killed text. Arrow keys, `Ctrl+B/F/P/N`, and `Alt+B/F` also move the cursor.

Everpeace disables terminal focus reporting at startup, shutdown, and after `!` commands, preventing `[I` and `[O` from appearing in the composer when switching windows.

TUI commands:

- `/login`: Sign in and activate a model immediately.
- `/model`: Switch to a registered model and reset the conversation context.
- `/models`: List all registered models and credential states.
- `/new`: Immediately create and enter a new local session.
- `/resume`: List and resume local JSONL sessions.
- `/logout`: Select and remove models with their operating system credentials.
- `/clear`: End the current conversation and start a fresh session on the next prompt while retaining the active model.
- `/help`, `/exit`: Show help or exit Everpeace.
- `!<command>`: Run a command directly in the native system shell (PowerShell on Windows, Bash on macOS/Linux) without confirmation. PTY-formatted output streams into the TUI history without suspending or refreshing the whole interface.

Behavior notes:

- Every command requested by the model requires confirmation.
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
