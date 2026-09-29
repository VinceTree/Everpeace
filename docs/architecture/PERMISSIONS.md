# Codex Permissions Baseline

Updated: 2026-09-28. The fixed-source three-harness comparison, implemented hardening, native probe evidence, and remaining optimization plan are in [SANDBOX.md](./SANDBOX.md). This does not claim full runtime equivalence.

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

Permission changes do not rebuild the agent or lose context. Every tool call checks current policy; each model request includes it. User policy is stored as versioned JSON under the platform config directory. An optional `.everpeace/permissions.json` project policy is treated as untrusted input: its mode is intersected with the user mode, web and model-shell networking can only be disabled, and project `allow` command rules are ignored. No JSONL schema change.

Model-shell networking is an independent persisted setting. Its default delegates to the selected native profile. When disabled, each sandbox launch passes `--sandbox-state-disable-network`; refusal or unsupported profile composition fails closed rather than running on the host. This setting does not grant or revoke public web or MCP access. Selecting full access clears a user-level network deny, but a project-level deny remains restrictive and can make an unsupported full-access/network-denied composition fail closed. Domain allowlists are not offered without a managed proxy.

Model shell execution calls the pinned `@openai/codex@0.155.1` CLI instead of reimplementing OS policy. A missing CLI/platform binary, unsupported OS, or sandbox setup failure is returned as a failed tool result; Everpeace never retries the command directly on the host. Windows model commands use PowerShell because Git Bash/MSYS cannot initialize its service inside the Codex restricted token. macOS/Linux model commands use Bash.

The model Bash path and other Codex CLI calls share one bounded process executor. Payload commands are never automatically replayed based on stdout/stderr. Only payload-free helper invocations retain a bounded setup retry; cancellation, timeout, and failures remain fail-closed. Model shell invocations explicitly include managed requirements and filter inherited credential/startup variables before launching the Node wrapper; backend default credential exclusions are also enabled.

Immediately before each model command, the host freezes an effective policy with the workspace, additional read roots, protected paths, backend profile, environment behavior and approval scope. Workspace/ask mode supplies a complete named child of `:workspace`: control directories are read-only and the platform Everpeace state root is inaccessible. The host creates `.everpeace` before launch because the Windows backend cannot deny a target that does not exist, and rejects a symbolic-link/junction control path. Full access remains an explicit exception. A managed-policy conflict fails the launch.

Persisted `/permissions` command rules are evaluated in addition to the profile. Top-level `;`, newline, pipeline and conditional segments are checked independently; longest-prefix and `deny > ask > allow` precedence still apply within a segment. Command substitution, unmatched syntax and nested shell/interpreter execution require approval, while an explicit deny text hidden in unresolved syntax remains denied. This analyzer is deliberately conservative and is not described as a full shell parser. If the policy changes while approval is open, the reviewed command or patch is rejected and must be submitted again. Direct user `!` commands never consult these rules.

Workspace edits prefer the compatibility `apply_patch` function tool. It is workspace-relative, bounded, symlink-aware, optionally hash-checked, and atomically applies a preflighted batch. Patch preview and execution protect `.git`, `.codex`, `.agents`, and `.everpeace` unless the host has enabled full-access editing. Alternate data streams are rejected. The model shell now applies the same control-directory write boundary through its native profile, but `read_file`, `list_directory`, workflow snapshots and patching still run in the host rather than an isolated file worker. Patch contents remain in the normal function-call context.

File tools reject lexical traversal, resolved symlink/junction escapes, and Windows alternate streams. Reads accept regular UTF-8 text up to 128 KiB; nonrecursive directory lists cap at 500 entries. File content enters model context and therefore JSONL: avoid reading secrets. These tools do not access the keyring.

## Security Limits and Future Work

`:danger-full-access` deliberately has host-user authority. The web toggle does not restrict model API traffic, MCP transports, or user-authored direct commands. For sandboxed profiles, shell network behavior is controlled by the selected Codex profile; an approval does not by itself remove sandbox restrictions.

Path checks block static escapes, not races caused by a concurrent hostile process replacing path components between validation and use, nor hard-linked sensitive files already exposed inside a workspace. Trusted workspaces and OS access controls remain necessary. No secret-detection or prompt-injection-immunity claim is made.

Everpeace now opts into backend managed requirements for shell launch, but does not implement a unified managed policy for every host tool, automatic reviewer, proxy/domain policy, extra writable-root UI, or complete runtime orchestration. Its persisted command analyzer is narrower than Codex managed policy: user rules live in platform config, while project rules can only restrict and cannot elevate. Do not label it Codex Auto or claim parity with all Codex security layers. Tests cover profile mapping, fail-closed launch construction, file confinement, Bash/web/MCP approvals, context preservation, transient UI and full-access warning cancellation. A real Windows native profile probe has verified ordinary workspace writes and `.everpeace` denial; native network denial and Linux/macOS enforcement, live-model and full TUI acceptance remain pending.
