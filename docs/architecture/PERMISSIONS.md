# Codex Permissions Baseline

Research date: 2026-09-19. This comparison does not claim full Codex runtime equivalence. pi and Grok Build have not yet been evaluated.

## Official Sources

- [Permissions](https://developers.openai.com/es-419/docs/permissions): sandbox boundaries and approvals are separate controls; built-in profiles include `:read-only`, `:workspace`, and `:danger-full-access`.
- [MCP](https://developers.openai.com/es-419/docs/extend/mcp?surface=cli): MCP servers have their own configuration, authentication, and tool surfaces.
- [Skills](https://developers.openai.com/es-419/docs/build-skills): Skills use progressive disclosure and do not grant authority by themselves.

Codex uses platform-native enforcement: Seatbelt on macOS, bubblewrap/seccomp with fallback support on Linux/WSL, and restricted-token/elevated Windows backends. The implementation mapping and inspected source revision are recorded in [CODEX_CAPABILITIES.md](./CODEX_CAPABILITIES.md).

## Everpeace Implementation

| Control | Behavior |
| --- | --- |
| `/permissions` | Shared centered inline command window; Esc returns to the same conversation |
| `read-only` | Workspace file reads are allowed; model shell asks, then runs under Codex `:read-only`; built-in web and MCP ask separately |
| `ask` | Every model shell, built-in web, and MCP call asks; approved shell uses Codex `:workspace` |
| `workspace-write`, default | Model shell runs under Codex `:workspace` without per-command approval; enabled public web tools run without per-request approval; MCP still asks |
| `full-access` | Second explicit confirmation selects `:danger-full-access` and skips tool approvals |
| Files | `read_file` and `list_directory`, workspace-only in every mode |
| Web | Independent enable/disable setting for built-in web tools; public-address checks retained |
| MCP | Independent approval surface; not enabled or disabled by the built-in web switch |
| Direct `!` | Explicit user PTY command, unchanged, outside model sandbox and model context |
| Lifetime | User policy persists in the platform config directory; optional project policy can only restrict it |

Plan mode is a read-only planning exception: when web tools remain enabled, `web_search` and `web_fetch` can run without a per-request approval prompt so the agent can research the plan. This matches the normal `workspace-write` web behavior; `read-only` and `ask` still require approval outside Plan mode. Disabling web still denies those calls.

Permission changes do not rebuild the agent or lose context. Every tool call checks current policy; each model request includes it. User policy is stored as versioned JSON under the platform config directory. An optional `.everpeace/permissions.json` project policy is treated as untrusted input: its mode is intersected with the user mode, web can only be disabled, and project `allow` command rules are ignored. No JSONL schema change.

Model shell execution calls the pinned `@openai/codex@0.155.1` CLI instead of reimplementing OS policy. A missing CLI/platform binary, unsupported OS, or sandbox setup failure is returned as a failed tool result; Everpeace never retries the command directly on the host. Windows model commands use PowerShell because Git Bash/MSYS cannot initialize its service inside the Codex restricted token. macOS/Linux model commands use Bash.

The model Bash path and other Codex CLI calls share one bounded process executor. A Windows sandbox helper setup/refresh/unknown failure may be retried once; cancellation, timeout, and the final failure remain fail-closed. Persisted `/permissions` command prefix rules are evaluated in addition to the profile: the longest matching prefix wins, equal-length conflicts resolve `deny > ask > allow`, and direct user `!` commands never consult these rules.

Workspace edits prefer the compatibility `apply_patch` function tool. It is workspace-relative, bounded, symlink-aware, optionally hash-checked, and atomically applies a preflighted batch. It does not grant authority beyond the selected profile and does not persist patch contents outside the normal function-call context.

File tools reject lexical traversal, resolved symlink/junction escapes, and Windows alternate streams. Reads accept regular UTF-8 text up to 128 KiB; nonrecursive directory lists cap at 500 entries. File content enters model context and therefore JSONL: avoid reading secrets. These tools do not access the keyring.

## Security Limits and Future Work

`:danger-full-access` deliberately has host-user authority. The web toggle does not restrict model API traffic, MCP transports, or user-authored direct commands. For sandboxed profiles, shell network behavior is controlled by the selected Codex profile; an approval does not by itself remove sandbox restrictions.

Path checks block static escapes, not races caused by a concurrent hostile process replacing path components between validation and use, nor hard-linked sensitive files already exposed inside a workspace. Trusted workspaces and OS access controls remain necessary. No secret-detection or prompt-injection-immunity claim is made.

Everpeace still does not implement managed policy, automatic reviewer, network proxy/domain policy, extra writable-root UI, or complete runtime orchestration. Its persisted prefix rules are narrower than Codex managed policy: user rules live in platform config, while project rules can only restrict and cannot elevate. Do not label it Codex Auto or claim parity with all Codex security layers. Tests cover profile mapping, fail-closed launch construction, file confinement, Bash/web/MCP approvals, context preservation, transient UI and full-access warning cancellation. A real Windows Codex sandbox smoke test has executed a PowerShell command successfully; live-model and full TUI acceptance remain pending.
