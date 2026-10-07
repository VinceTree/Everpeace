# Everpeace

The terminal transcript mirrors Codex's resize-reflow row caps. Source-backed replay keeps a terminal-specific tail: VS Code 1,000 rows, Windows Terminal 9,001, WezTerm 3,500, Alacritty 10,000, and 1,000 for other terminals. The estimate uses source text and the current terminal width because Ink does not expose final layout measurements. Session JSONL, model context, input navigation and `/outputs` retain their complete data.


**English** | [简体中文](./README.zh-CN.md)

Everpeace is a DeepSeek-first, Windows-first personal development CLI with an interactive inline TUI and a non-interactive `exec` command. It also supports OpenAI and custom OpenAI-compatible Responses endpoints. The selected model can use a Codex-sandboxed shell, inspect and edit a workspace, run the project's complete verification suite, search the web, call configured MCP tools, and load local Codex skills. In the TUI, you can also run a local command directly with `!<command>`.

Model API keys are never read from environment variables or written to the project or configuration JSON. Everpeace stores them in the operating system credential store. Its local model registry contains only the model name, base URL, and credential reference. Separately, user-configured MCP servers may reference bearer tokens or headers through environment-variable names, following Codex MCP configuration.

## Requirements

- Node.js 22+
- pnpm
- Bash on macOS/Linux; Windows model commands use the system PowerShell inside the Codex sandbox
- An API key for DeepSeek, OpenAI, or a compatible service
- Outbound HTTPS access to Bing or DuckDuckGo and any public pages the agent reads

`pnpm install` installs Everpeace's pinned `@vscode/ripgrep@1.18.0` binary for the current platform; a system `rg` is neither required nor used. Do not disable optional dependencies: when the matching platform package is absent, workspace search, the `@` file picker, and `/doctor` report that bundled ripgrep is unavailable and ask you to reinstall. That release provides packages for Windows x64/arm64/ia32, macOS x64/arm64, and Linux x64/arm64/arm/ia32/ppc64/riscv64/s390x; other operating-system and architecture pairs have no bundled search binary.

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

The API key is never displayed in the terminal. After the model list loads, select one of the original model IDs returned by the server. Everpeace securely saves it and activates it for the current session; use `/doctor --live` when you want a bounded model-generation check:

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

## Non-interactive execution

`everpeace exec` runs the same production Agent, Session persistence, permissions, sandbox tools, verification/repair loop, history attachments, and cleanup without mounting Ink:

```text
everpeace exec [prompt] [-C <directory>] [--model <id-or-name>]
               [--resume <session-id>]
               [--plan] [--json] [--token-budget <n>]
               [--permission-mode <mode>] [--timeout-ms <n>] [--max-steps <n>]
```

Pass the prompt as one positional argument or through non-TTY stdin; using both is an error, and an interactive terminal with neither exits immediately. Piped input is limited to 8 MiB. During development, use the same interface through `pnpm dev -- exec ...`. `-C` defaults to the current directory. Model selection first matches a registered ID, then a unique model name; omitting `--model` works only when exactly one credential-backed model is available. `everpeace exec --help` returns before loading the model registry, credential store, MCP, or TUI.

Every task that passes startup creates a normal Session with a deterministic `Exec: ...` title, so it can later be inspected or resumed in the TUI. `--resume <session-id>` instead forks an existing same-workspace Session into an independent child and continues it with a new prompt: it restores the saved context, workflow, task progress, and the model recorded on the source Session (`--resume` and `--model` cannot be combined). The child clears its `fork_pending_resume` marker once a resumed task settles as `verified` or `no_changes`. `--plan` runs a read-only plan pass that inspects the workspace, prints the submitted implementation plan as the assistant text, and never edits files or auto-approves execution. `--permission-mode <read-only|ask|workspace-write>` overrides the saved permission tier for one run; `full-access` is never selectable from exec, and saved web/shell-network/command-rule restrictions still apply. The command reads existing learned Memory but disables capture for that run. It cannot auto-approve: a permission prompt or structured question is persisted as a paired tool result, reported as `interaction_required`, and stops after cleanup. `--token-budget` covers coding, compaction, retries, and repair; `--timeout-ms` and `--max-steps` also apply across the complete task rather than resetting for repair rounds.

Without `--json`, stdout contains only the final assistant text; progress and host-verification summaries go to stderr. Once the exec output layer initializes, `--json` emits UTF-8 JSONL with `schema_version: 1`, an ISO `timestamp`, and the allowlisted fields below. Event types are `session_started`, `assistant_message`, `tool_started`, `tool_finished`, `workflow_updated`, `interaction_required`, and one final `run_finished` after task cleanup. A top-level syntax or module-startup error is reported on stderr with exit 2 before JSONL starts. All text is stripped of terminal controls and redacted; reasoning content and raw provider responses are never exported, while aggregate reasoning/cache counts may appear in usage.

Assistant text is preserved in full after redaction, including answers over 64 KiB. JSONL writes each answer as one complete record using bounded chunks without interleaving other records. Other events, including their JSON escaping and newline, fit within 64 KiB and report `truncated: true` when previews are shortened. Encoded output buffering is capped at 1 MiB; writes wait for the consumer, and 30 seconds without write progress cancels the task and triggers cleanup. Closing either output pipe has the same effect. If cancellation or output failure interrupts a JSONL record, the stream may end with that partial record and no final event; consumers must check the process exit code as well as complete records.

| JSONL `type` | Allowlisted payload |
| --- | --- |
| `session_started` | `session_id`, `model_id`, `model_name`, `workspace`; `parent_session_id` when the run is a `--resume` fork |
| `assistant_message` | `text` |
| `tool_started` / `tool_finished` | `name`, `call_id`; finished events may include `status` (`completed`, `failed`, `cancelled`, or `skipped`) and a bounded `output` preview |
| `workflow_updated` | `phase`, `task_id`, `changed_paths`, `repair_attempts`, `max_repair_attempts`, `pending_verification`; optional `result`, `result_reason` |
| `interaction_required` | `kind` (`approval` or `question`), `tool`, optional `prompt` |
| `run_finished` | optional `session_id`; `status` (`success`, `runtime_error`, `configuration_error`, `verification_failed`, `limit_reached`, `interaction_required`, or `cancelled`); `usage_complete`; optional `stop_reason`, `workflow_result`, and `usage` with `input_tokens`, `output_tokens`, and optional `reasoning_tokens`, `cached_input_tokens`, `cache_write_input_tokens` |

The same non-interactive task is available as a small TypeScript SDK. `import { runTask } from "everpeace/sdk"` accepts a prompt plus the exec options above (including `resume`, `plan`, and `permissionMode`), streams the same events through `onEvent`, and resolves with the classified result. Credentials and sessions resolve from the system keyring and default store unless a host injects its own registry or session store; the SDK never mounts Ink and never auto-approves interactive prompts.

Exit codes are fixed: `0` for host `verified` or `no_changes`; `1` for a runtime/cleanup failure or failed/stalled output pipe; `2` for argument/startup configuration errors; `3` for `failed` or `unverified` verification; `4` for token, usage, step, or deadline limits; `5` for required interaction; and `130`/`143` for SIGINT/SIGTERM. Output failure waits for task and output-writer cleanup before exit.

On macOS/Linux, if `bash` is not in `PATH`, configure it explicitly:

```powershell
$env:EVERPEACE_BASH_PATH="/custom/path/to/bash"
```

## Usage

```text
✦ Everpeace Agent (v0.3.8) · 天下长平，以规司矩

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

The TUI's own interface is English throughout. While a turn is active, a provider-aware status such as `Waiting for DeepSeek (3s • ctrl+c to interrupt)` changes to `Working` during tool dispatch. A separate `Thinking` timer appears only after the provider emits a reasoning-stage event. Responses-capable providers stream assistant text and tool progress live; an endpoint is switched to buffered mode only after it explicitly rejects streaming before emitting any event. Interrupted or incomplete streams are retried from the last durable context and never execute half-received tools. Compatible buffered endpoints still show phase, approval, and command previews. Assistant replies render GitHub-flavored Markdown, including headings, lists, emphasis, links, tables, inline code, and fenced code. Fenced code and Bash/PowerShell commands use language-aware terminal highlighting with bounded-size safety fallbacks.

Commands are visually separate from conversation text: active commands show `Running`, completed model commands show `Ran`, and direct commands show `You ran`, with status color, shell, duration, and retained output underneath. Standard unified diffs in assistant `diff` fences or command output include old/new line gutters, cyan headers, green additions, and red deletions. True-color terminals receive light/dark-aware backgrounds; lower-color and `NO_COLOR` environments retain structural markers without requiring color. Restored legacy UI messages are translated for display without modifying session JSONL or translating user/assistant content.

The input area follows the terminal's available width and reserves the final column to prevent Windows Terminal from wrapping automatically. The startup model/directory panel uses Codex's 56-cell inner-width cap (60 columns including padding and borders), pre-truncates every row, and shrinks in narrower terminals without wrapping. The composer grows only for explicit newlines; long input is horizontally clipped instead of wrapping when the terminal font size changes.

The TUI runs inline, so the normal scroll wheel can browse the completed Everpeace conversation. After Ctrl + scroll wheel changes the font size, Everpeace performs a synchronized source-backed redraw after Codex's 75 ms trailing delay, restoring the complete banner and conversation without exposing an empty intermediate frame.

The first normal prompt creates a local JSONL session. Everpeace saves the conversation transcript and the model context needed to continue it, while a separate background model request generates a short title from that first prompt. Slash commands with informational or selection interfaces open an isolated temporary screen that hides the banner, transcript, composer, and global status bar. Command windows are centered horizontally and vertically, capped at 80 columns, and shrink with safe margins on narrow terminals. Press `Esc` to replay and return to the same session; command-screen contents are not added to session history. Direct `!` command output remains part of the recoverable transcript. `/new` immediately creates and enters an empty session; its temporary title is replaced after the first prompt. `/resume [query]` searches titles and user/assistant messages in the current workspace by default, can toggle to all workspaces, previews nearby conversation, and restores the original model, working directory, Goal, and verification state. Session files live under the platform application-state directory (`%APPDATA%\Everpeace\sessions` on Windows).

Everpeace also keeps a separate learned-experience memory. After workflow verification and five minutes of real idle time, the current model may extract up to three evidence-linked candidates and consolidate non-conflicting lessons in the background. The persistent queue survives Agent recreation and process restarts; foreground work pauses background requests. Explicit long-term preferences are stored separately at user scope. Memory lives under the platform application-state directory (`%APPDATA%\Everpeace\memory` on Windows), never in the repository. Every logical Agent step refreshes a revisioned snapshot using the current request and files actually read; retries reuse that snapshot. The prompt receives a short untrusted index, while the read-only `memory_lookup` tool can retrieve a selected entry's redacted evidence. Secrets are redacted before truncation and again before storage, conflicts stay pending for review, and current user instructions and repository evidence always take precedence.

`/status` opens a centered, isolated command screen showing the active model, actual Responses protocol, compaction strategy, reasoning level, endpoint, workspace, Session ID, context occupancy, and cumulative input, output, reasoning, cache-hit, and cache-write tokens. Coding and auxiliary model usage are displayed separately; auxiliary requests include title, Skill, Memory, and live doctor work. Cache reads and writes are tracked independently; a hit rate is calculated only over samples that included cache data and is marked partial when some samples omitted it. DeepSeek uses automatic prefix caching without sending OpenAI cache fields. Official OpenAI models may use a Session-scoped cache key and native compaction. Coding usage and request settings persist with the Session.

Composer shortcuts follow Codex conventions: `Enter` submits; `Shift+Enter`, `Alt+Enter`, or `Ctrl+J` inserts a newline; `Home`/`End` and `Ctrl+A`/`Ctrl+E` move to the current line's start/end; `Ctrl+U`/`Ctrl+K` delete to the current line's start/end; `Ctrl+W` deletes the previous word; and `Ctrl+Y` restores the most recently killed text. Arrow keys, `Ctrl+B/F/P/N`, and `Alt+B/F` also move the cursor.

Typing `@` opens a bounded workspace-file picker. Selecting a file inserts an explicit reference such as `@"src/example.ts"`; add `#L10-L40` for a range. On submission Everpeace reads each reference afresh and attaches its labeled excerpt once to model context while keeping the original prompt in input history and title generation. References in inline or fenced code stay literal. A message may contain up to eight excerpts, with a default 200 lines, an explicit maximum of 1,000 lines, 32 KiB per excerpt, and 64 KiB total. Invalid, missing, binary, or oversized references keep the draft and show an error. Attachments do not authorize later edits.

Typing `/` at the start of the composer opens a slash-command menu below the input. The list filters by case-insensitive prefix as you type, shows up to eight commands at once, and scrolls to any remaining matches. Use `Up`/`Down` or `Ctrl+P/N` to select, `Enter` to run the selected command, `Tab` to complete it without running, and `Esc` to dismiss the menu while keeping the input.

Everpeace disables terminal focus reporting at startup, shutdown, and after `!` commands, preventing `[I` and `[O` from appearing in the composer when switching windows.

TUI commands:

- `/login`: Sign in and activate a model immediately.
- `/model`: Switch to a registered model and reset the conversation context.
- `/models`: List all registered models and credential states.
- `/status`: Show provider protocol, compaction mode, reasoning level, context usage, and independent token/cache statistics.
- `/diff`: Review staged, unstaged, and untracked workspace changes in a file list with highlighted, paged detail; binary, symlink, submodule, and truncation states are explicit.
- `/context`: Inspect the last admitted coding request's model, estimates, sources, tools, attachments, item counts, and redacted previews without making a model request.
- `/tasks`: Inspect the current model-authored execution checklist and the latest host workflow result. Checklist completion is advisory and never replaces verification.
- `/verify [command]`: Run the complete discovered workspace suite with cancellation and file-revision binding. An explicit command is recorded only as supplemental evidence.
- `/undo`: Undo the latest Agent turn when its files are unchanged; user edits are never overwritten.
- `/permissions`: Select read-only, ask-for-approval, workspace-write, or full-access mode; control public web and model-shell networking separately; and persist user/project command policy.
- `/mcp`: Reload Codex MCP configuration, connect enabled servers, and inspect server/tool/resource/prompt status.
- `/skills`: Create, install, inspect, and explicitly invoke local Skills.
- `/memory`: View learned experience and separate Memory-model usage, globally enable or disable both reading and learning, control reading/capture for the current chat, inspect the last snapshot actually injected with `/memory view`, archive or clear entries, or run `/memory remember <preference>` to save a lasting user preference. Chat policy is restored with its Session; these settings govern learned Memory, independently of on-demand Session history.
- `/plan`: Enter strict read-only planning mode, answer structured strategy questions, and approve a plan before execution. The same blocking question surface is available during coding when the model needs clarification; coding cancellation stops the active task. Dispatch rejects tools not offered in a Plan step, including editing and Goal mutations.
- `/goal <objective> [--tokens N]`: Create, inspect, pause, resume, and automatically continue a persistent session goal. Once returned usage reaches the budget or cannot be measured reliably, further tools, model requests, and automatic verification/repair stop with an explanation. An in-flight request can exceed the remaining budget.
- `/compact`: Compact model context while keeping the full visible transcript. Official OpenAI uses native Responses compaction; DeepSeek and conservative compatible endpoints use an 8K-token summary that retains the latest two complete interaction units and open tool chains. Automatic compaction reserves output and safety headroom, and a confirmed context overflow can recover once without replaying tools.
- `/reasoning off|low|high|max`: Set the reasoning level captured by the next task. The default is `high`; official DeepSeek receives `max` unchanged.
- `/doctor [--live]`: Inspect Node, platform, actual shell, sandbox backend/profile, network mode, Git/bundled ripgrep, optional TypeScript LSP configuration, and a real sandbox execution probe. The default is local-only; `--live` sends one bounded connectivity request.
- `/outputs`: Browse retained command output with paged details, highlighted commands, and unified-diff rendering.
- `/history`: Browse or explicitly clear global input history (not sessions).
- `/terminal-setup`: Preview and optionally configure Shift+Enter in stable Windows Terminal; confirmation creates a settings backup before applying a global key binding.
- `/new`: Immediately create and enter a new local session.
- `/fork [title]`: Copy the committed end of the current idle local Session into an independent child and enter it; an optional title replaces the default fork title, and the source model must still be available.
- `/resume [query]`: Search titles and user/assistant messages in this workspace or all workspaces, preview, resume, or permanently batch-delete local JSONL sessions.
- After `/resume`, Up/Down browse that session's saved user prompts and direct commands with source metadata; Down past the newest entry returns to an empty draft. Recalled slash commands do not open the command menu until edited. `/history` still shows global input history.
- `/logout`: Select and remove models with their operating system credentials.
- `/clear`: End the current conversation and start a fresh session on the next prompt while retaining the active model.
- `/help`, `/exit`: Show help or exit Everpeace.
- `!<command>`: Run a command directly in the native system shell (PowerShell on Windows, Bash on macOS/Linux) without confirmation. PTY-formatted output streams into the TUI history without suspending or refreshing the whole interface.

MCP uses the same Codex configuration rather than an Everpeace-specific credential file. Configure servers with `pnpm exec codex mcp add ...` or an equivalent installed Codex CLI, then run `/mcp`. This release supports stdio and Streamable HTTP tools, resources, and prompts, including static/environment headers and bearer-token environment variables. Each server has an independent `connecting`/`reconnecting` lifecycle: transient disconnects remove its tools and retry up to ten times with 500 ms–30 s exponential backoff, while permanent configuration/authentication failures stop immediately. A connection must stay ready for 30 seconds before its retry count resets, and failure to confirm close within five seconds stops automatic recovery. In-flight tool calls are never replayed; business errors, one-call timeouts, and cancellation do not themselves reconnect.

Tool-list changes are fully paginated and published together with their output validators. A failed refresh keeps the complete previous catalog and validation rules. Each Agent step freezes a binding to the connection and full definition, including output schema, execution metadata, and approval annotations; stale calls are rejected, while an already dispatched call retains its original validator. Discovery shares one startup deadline and allows at most 100 pages, 1,000 tools, and 2 MiB of definitions. Tools requiring task-based execution are omitted and shown as unsupported in `/mcp`. An expired HTTP session (404) reconnects for later calls without replaying the failed request.

Resources-only, prompts-only, and instructions-only servers can also connect. `mcp__server__list_resources`, `list_resource_templates`, and `list_prompts` read one live page per call; pass the returned `next_cursor` unchanged as `cursor`. A page over 1,000 items or 1 MiB fails explicitly without a continuation that would skip omitted entries. `read_resource` and `get_prompt` read current content on demand. MCP image/audio/resource-blob content blocks appear as type/size descriptions in model history; structured business data and metadata stay intact. All these calls retain independent MCP approval. `/mcp` reloads configuration and resets recovery state. OAuth credential reuse, header helpers, elicitation, sampling, tasks, and persistent per-tool approvals remain unavailable.

Skills are discovered from `.agents/skills` between the workspace and repository root, the project `.codex/skills`, `$CODEX_HOME/skills`, `~/.agents/skills`, and the platform admin root. Mention `$skill-name` to activate one explicitly for the current turn; otherwise the model can match catalog descriptions and call `read_skill`. Skill metadata is preloaded, while complete instructions and referenced files are read only when needed.

`/skills` is an interactive manager with three flows:

- **Create**: choose project or user scope, describe the workflow, let the active model draft one `SKILL.md`, then validate/improve it with AI, edit the complete file manually, or confirm and save it.
- **Install from URL**: enter a public HTTPS GitHub repository/folder, Git repository root, direct `SKILL.md`, or ZIP URL. Everpeace downloads into temporary staging, validates every discovered package, lets you choose one when the source contains several, previews the complete `SKILL.md` with source and file count, then requires scope selection and explicit confirmation before installation. Git sources are cloned without a working-tree checkout first; Everpeace inspects the bounded repository tree, collapses mirrored packages with the same Skill name in favor of canonical `skills/<name>` directories, and checks out only validated candidate directories. Repositories may therefore contain more manifest files than distinct installable Skills without failing the candidate limit.
- **View installed Skills**: browse a compact catalog with scope, readiness/conflict state, and a two-line description before opening the complete instructions; select **Use in next prompt** to prefill `$skill-name` in the composer.

Project installs go to the repository root's `.agents/skills`; user installs go to `$CODEX_HOME/skills` (normally `~/.codex/skills`). Existing names are never overwritten, and duplicate names across discovered roots are marked as conflicts and withheld from automatic or explicit activation until resolved. URL installation is public-only, accepts no embedded credentials, validates every redirect against local/private addresses, applies download/extraction/file limits, rejects path traversal and symbolic links, and installs through a temporary directory. Private repositories, authenticated downloads, updates, and deletion are outside the current flow. See [Codex capability mapping](docs/architecture/CODEX_CAPABILITIES.md).

The model can retrieve current and older same-workspace history on demand with `session_search`, `session_event_search`, and `session_event_read`, including records removed from active context by compaction. `session_relations(session_id?)` lists direct parent and child forks in the same exact workspace and marks a deleted or replaced parent unavailable. Results identify their Session and time and remain historical, untrusted material: they grant no file-write authority or current verification status. These read-only tools also work in Plan mode and remain available when learned Memory is disabled. Direct `!` output, reasoning, encrypted items, old developer snapshots, Memory results, and the history tools' own results are excluded.

Behavior notes:

- The core turn loop adapts Codex's sampling/tool/follow-up flow in TypeScript, with per-tool result persistence, cancellable request retries, strict stream completion, and one-shot context-limit recovery. It is not the complete Codex runtime; see [source mapping and scope](docs/architecture/AGENT_LOOP.md).
- At automatic-compaction pressure or during the one context-limit recovery, Everpeace first tries one persisted, deterministic pruning pass when durable Session history is available. Old closed tool results must resolve uniquely against the fixed history boundary; results longer than 8,192 Unicode code points keep the first 4,096, last 1,024, and a `session_event_read` recovery reference in valid JSON no larger than 32 KiB. The latest two complete interaction units, open tool chains, user/assistant/developer/reasoning/opaque items, Memory, and history/continuation-tool results remain intact. `context_pruned` is persisted before the effective context is replaced; original history and attachments remain available, cumulative usage is unchanged, and only the current `context_tokens` estimate becomes unknown. If the full request is then small enough, no summary model call is made; otherwise normal provider compaction continues. Low-pressure requests and ordinary network retries do not prune.

- Permission profiles keep sandbox scope separate from approvals: `read-only` asks before model shell, web, and MCP calls and uses Codex `:read-only`; `ask` asks before each call and uses `:workspace` after shell approval; `workspace-write` runs model shell in `:workspace` without per-command prompts, allows enabled public web tools without per-request prompts, and keeps MCP approval separate; `full-access` selects `:danger-full-access` after a second explicit confirmation.
- `read_file` pages workspace UTF-8 files up to 16 MiB by line and returns a raw-byte whole-file SHA-256. `search_files` and `glob_files` invoke the pinned bundled ripgrep through its absolute path with parameterized `--no-config` arguments; the system `PATH` and user ripgrep configuration cannot replace or alter it. Searches return process-local continuation references over bounded snapshots (100 results by default, 200 maximum). Search pagination retains at most 16 searches and 8 MiB of serialized UTF-8 payload, evicting the oldest references; completed and unterminated ripgrep records share the 2 MiB per-search input bound. `list_directory` lists up to 500 entries. Outside paths and resolved symlink escapes are rejected. Oversized model-facing tool results remain valid JSON with a 32 KiB inline preview and an opaque `read_tool_output` reference. Redacted bodies persist as Session attachments, up to the first 2 MiB of each of the latest 16 outputs; reads return up to 24 KiB per page. References survive compaction and restart; optional `session_id` allows only the same workspace. Evicted or legacy process-only bodies are unavailable, and `retention_truncated` identifies content beyond the retention limit. Deleting a Session also deletes its attachments. File contents enter model context and persisted session data; avoid reading secrets.
- Set `EVERPEACE_TYPESCRIPT_LSP` to an existing local language-server executable to expose `code_navigation` for definitions, references, implementations, and hover. Optional arguments and external dependency roots use JSON string arrays in `EVERPEACE_TYPESCRIPT_LSP_ARGS` and `EVERPEACE_TYPESCRIPT_LSP_READ_ROOTS`. Each query starts a fresh server behind the pinned native read-only sandbox, with filtered credentials, protected-path checks, UTF-16/open-close capability validation, bounded protocol traffic, and awaited cleanup. A host connection first confirms the probe target is reachable; the sandbox probe then reports `allowed`, `denied`, or `inconclusive` for that TCP/IPv4 target. Only explicit socket permission denial allows the language server to start; connection refusal or timeout does not count as isolation. The pinned Windows backend still permits the probe, so native LSP navigation remains unavailable there and lexical search remains available. No server is installed automatically, and there is no shared server pool; native platform ambient read and temporary-directory grants still apply.
- User permissions persist in the platform configuration directory and survive restart; `/permissions` can also save a project policy under `.everpeace/permissions.json`. Project policy is fail-closed: it may restrict the user policy, disable model-shell networking, or disable public web, but cannot elevate access. The shell-network switch is enforced by the native backend and does not alter web or MCP access. Changing permissions preserves context; JSONL never restores full access.
- Model shell commands are launched through the pinned `@openai/codex@0.155.1` native OS sandbox and fail closed if that runtime cannot start. Windows model commands use PowerShell because Git Bash/MSYS cannot initialize inside the restricted token; macOS/Linux use Bash. Model shell calls have a 120-second default timeout and return a structured timeout result; direct `!` commands remain outside the model sandbox and keep user-controlled lifetime. See [design and limits](docs/architecture/PERMISSIONS.md).
- Each model shell launch captures an immutable effective policy, includes backend managed requirements, and filters inherited credential/startup variables before the launcher starts. Workspace/ask mode uses a native child profile that keeps `.git`, `.codex`, `.agents`, and the host-created `.everpeace` control directory read-only and denies model reads of global Everpeace state. Command output cannot trigger automatic payload replay. Full access and direct `!` commands retain their documented authority. See the [sandbox comparison and optimization plan](docs/architecture/SANDBOX.md).
- Model edits use the workspace-scoped `apply_patch` tool when possible. Updates accept full content, unified hunks, or one exact `oldText`/`newText` replacement; missing, repeated, stale, mismatched, and policy-denied edits return stable reason codes with corrective guidance. Update/delete still requires a host-recorded `read_file` version; the preview hash and permission revision are bound to execution, creation is exclusive, and rollback refuses to overwrite a later user edit. Patch preview and execution protect `.git`, `.codex`, `.agents`, and `.everpeace` unless full access was explicitly selected; alternate data streams remain blocked. Persisted model Bash rules inspect each top-level command segment; ambiguous substitutions and nested interpreters require approval, and explicit deny rules remain fail-closed. A permission change invalidates an approval that is still pending. Direct `!` commands are unaffected.
- Coding turns use a single personal-development workflow. Each logical step reloads the `AGENTS.md` chain from the workspace root to every accessed target scope, plus declared `package.json` scripts, as lower-priority project context. A newly discovered or changed nested rule defers a structured edit until the next model boundary, and the current rule snapshot remains effective after compaction. Patch success triggers a fast check; final Node/TypeScript verification re-discovers the manifest and runs every declared `typecheck`, `lint`, `test`, and `build` script in that order, stopping at the first failure. Missing checks are reported as unverified rather than passed.
- During coding, the model can replace a persisted checklist of up to 20 pending, in-progress, or completed steps. The latest checklist survives repair turns, Goal continuation, explicit Session resume, and context compaction; a new user task clears it. The status bar and `/tasks` report progress, while host verification remains the only completion authority.
- The host can run up to four explicitly safe read-only tools concurrently while preserving model-order results. This scheduling is independent from a provider's parallel-tool hint; writes, shell, MCP, approvals, cancellation, and conflicting resources remain serial barriers. Requests use one measured snapshot with the real output reserve, while incremental command buffers and 40 ms streamed-text batching keep long turns responsive.
- Git status is parsed as NUL-delimited structured data and changed-file fingerprints are compared with the dirty state captured at task start. This lets model shell edits, repeated edits to an already-dirty file, untracked files, and non-ASCII paths enter the same verification workflow. `list_workspace_changes` and `read_workspace_change` give the model the same bounded staged/unstaged/untracked details used by `/diff`, through process-local captured references; review establishes neither ownership nor write authority. Tracking limits, non-Git shell changes, rejected checks, and exhausted repairs cannot be reported as verified. Legacy `workspace_status` and `workspace_diff` remain read-only; `/undo` still covers only structured edits whose files have not changed again.
- Workflow completion is separate from model response completion. The host displays the observed paths and verification suite result, only verified coding turns can feed successful learned-memory capture, and an active Goal's completion request remains pending until the host accepts final verification. Workflow result metadata is recoverable in Session JSONL without command output, errors, file contents, or undo checkpoints.
- `/fork` is available only while the current local Session is idle and its model remains available. It freezes the source EOF, copies context, timeline, model, chat Memory policy, inherited TaskProgress, and up to 16 retained output attachments under the same opaque IDs, then atomically publishes an independent child. Usage, Goal, repair counters, approvals, undo/file observations, and prior verification success are reset; changed paths and pending verification debt remain. The child persists `fork_pending_resume`, so its first and any unsettled later coding input uses Session-resume semantics until a task settles as `verified` or `no_changes`; Plan, viewing commands, cancellation, errors, limits, and failed/unverified results do not consume it or auto-resume a Goal.
- Up to two non-interactive model commands may run in the background through the same sandbox and permission policy. Jobs expose bounded running previews, can be polled or stopped, default to ten minutes, and are owned by the current coding task. Terminal status metadata is durably surfaced to the model at the next ordinary step; output remains available through polling. Running jobs and undelivered notices share 20 task-local slots. Cancellation, permission tightening, budget stop, failure, final verification, and Agent disposal terminate and await process trees, discard pending notices, and ignore late callbacks. Jobs remain process-local and are not restored with a Session.
- Maintainers can run a credential-free executor/profile startup gate, prove the ten pinned Node fixtures, or run an authorized comparison with `pnpm benchmark:campaign -- --config <campaign.json> --preflight|--prove-fixtures|--live`; see [benchmarking](docs/BENCHMARKING.md). Named baseline/candidate checkouts run through the same fresh Node worker and are bound to revision plus source/build digests. The fixed dsh adapter validates usage at its provider boundary; preflight intercepts that boundary with a synthetic response and blocks sockets. Live mode separately requires authorization, a registered model, and numeric per-task and campaign budgets.
- `read-only` and `ask` require approval before each web request during normal chat; `workspace-write` and `full-access` skip that prompt. Plan mode also treats enabled public web access as read-only research and skips the per-request prompt, while disabling web still denies it. Search queries are sent to Bing, with DuckDuckGo as a fallback; opening a result sends a request to that site.
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

For development, start with [AGENTS.md](AGENTS.md), the [current handoff](docs/HANDOFF.md), and the [knowledge base index](docs/README.md). The index routes each task to architecture notes, source files, and regression tests, so a new agent can reuse project knowledge and inspect only the relevant implementation. Old plans and execution records are kept separately in [the archive](docs/archive/README.md).

```text
src/
├─ cli/          # CLI entry point, argument parsing, and output formats
├─ agent/        # ReAct loop and session state
├─ codex/        # Pinned Codex CLI launcher
├─ exec/         # Public non-interactive task runner and result contract
├─ mcp/          # Codex-configured MCP client runtime
├─ providers/    # DeepSeek, OpenAI, and compatible endpoint adapters
├─ runtime/      # UI-independent production Agent and command factories
├─ skills/       # Codex host skill discovery and progressive reads
├─ storage/      # Credentials, model registry, Sessions, history, and outputs
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
