# Codex Permissions Baseline

取消期限、Job 进程归属、持久批次恢复、allow 迁移与子包验证的现行契约见 [可靠性加固](RELIABILITY_HARDENING.md)。

当前安全加固契约（文件后端、敏感内容、验证依据、MCP 与隐私迁移）见 [安全加固](SECURITY_HARDENING.md)，与旧说明冲突时以该契约及当前实现为准。

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
| Files | Windows local NTFS native worker, fixed workspace identity and handle-relative access; sensitive-read review; unavailable elsewhere |
| Web | Independent enable/disable setting for built-in web tools; public-address checks retained |
| MCP | Independent approval surface; not enabled or disabled by the built-in web switch |
| Direct `!` | Explicit user PTY command, unchanged, outside model sandbox and model context |
| Lifetime | User policy persists in the platform config directory; optional project policy can only restrict it |

Plan mode keeps the workspace read-only and follows Web and sensitive-transmission approvals; it no longer bypasses ask/read-only Web approval.

Permission changes do not rebuild the agent or lose context. Every tool call checks current policy; each model request includes it. User policy is stored as versioned JSON under the platform config directory. An optional `.everpeace/permissions.json` project policy is treated as untrusted input: its mode is intersected with the user mode, web and model-shell networking can only be disabled, and project `allow` command rules are ignored. No JSONL schema change.

Model-shell networking is an independent persisted setting. Its default denies networking; explicit enablement requires per-command approval. When disabled, each sandbox launch passes `--sandbox-state-disable-network`; refusal or unsupported profile composition fails closed rather than running on the host. This setting does not grant or revoke public web or MCP access. Selecting full access clears a user-level network deny, but a project-level deny remains restrictive and can make an unsupported full-access/network-denied composition fail closed. Domain allowlists are not offered without a managed proxy.

Model shell execution calls the pinned `@openai/codex@0.162.0` CLI instead of reimplementing OS policy. A missing CLI/platform binary, unsupported OS, or sandbox setup failure is returned as a failed tool result; Everpeace never retries the command directly on the host. Windows model commands use PowerShell because Git Bash/MSYS cannot initialize its service inside the Codex restricted token. macOS/Linux model commands use Bash.

The model Bash path and other Codex CLI calls share one bounded process executor. Payload commands are never automatically replayed based on stdout/stderr. Only payload-free helper invocations retain a bounded setup retry; cancellation, timeout, and failures remain fail-closed. Model shell invocations explicitly include managed requirements and filter inherited credential/startup variables before launching the Node wrapper; backend default credential exclusions are also enabled.

Immediately before each model command, the host freezes an effective policy with the workspace, additional read roots, protected paths, backend profile, environment behavior and approval scope. Workspace/ask mode supplies a complete named child of `:workspace`: control directories are read-only and the platform Everpeace state root is inaccessible. The host creates `.everpeace` before launch because the Windows backend cannot deny a target that does not exist, and rejects a symbolic-link/junction control path. Full access remains an explicit exception. A managed-policy conflict fails the launch.

Persisted `/permissions` command rules are evaluated in addition to the profile. Top-level `;`, newline, pipeline and conditional segments are checked independently; longest-prefix and `deny > ask > allow` precedence still apply within a segment. Command substitution, unmatched syntax and nested shell/interpreter execution require approval, while an explicit deny text hidden in unresolved syntax remains denied. This analyzer is deliberately conservative and is not described as a full shell parser. If the policy changes while approval is open, the reviewed command or patch is rejected and must be submitted again. Direct user `!` commands never consult these rules.

Workspace edits use the compatibility `apply_patch` function tool. It is workspace-relative, bounded and symlink-aware. Production update/delete requires the host-observed raw-byte hash; approval binds the preview version and permission revision. Windows NTFS updates preserve the original under an exclusive handle, then install without overwriting a concurrent target; the path may briefly be absent. Creates are exclusive. A failed batch rolls back only already-written files that still match its post-image, reporting conflicts and rollback failures rather than promising batch atomicity. Patch preview and execution protect `.git`, `.codex`, `.agents`, and `.everpeace` unless the host has enabled full-access editing. Alternate data streams are rejected. The model shell applies the control-directory write boundary through its native profile. Workspace content reads and mutations use the native file worker. Git metadata and application storage retain separate host boundaries. Patch contents remain in the normal function-call context. See [TOOLS](TOOLS.md).

File tools reject lexical traversal, traversed reparse points, multiple hard links and Windows alternate streams. Workspace identity is pinned for the process; content opens use held parent handles. Reads accept regular UTF-8 text up to 16 MiB with line pagination and a raw-byte fingerprint; directory lists cap at 500 entries. Sensitive paths and detected secrets are masked or explicitly authorized before model context and JSONL. These tools do not access the keyring. Configured LSP and default stdio MCP use native policies with credential paths denied and networking disabled.

## Security Limits and Future Work

`:danger-full-access` deliberately has host-user authority. The web toggle does not restrict model API traffic, MCP transports, or user-authored direct commands. For sandboxed profiles, shell network behavior is controlled by the selected Codex profile; an approval does not by itself remove sandbox restrictions.

The native file worker covers held-handle path races and rejects hard-linked targets on supported local NTFS. Git object databases, native shell/LSP policies, explicit host/full-access modes and application storage are separate boundaries. Secret detection is incomplete, and no prompt-injection-immunity claim is made.

Everpeace now opts into backend managed requirements for shell launch, but does not implement a unified managed policy for every host tool, automatic reviewer, proxy/domain policy, extra writable-root UI, or complete runtime orchestration. Its persisted command analyzer is narrower than Codex managed policy: user rules live in platform config, while project rules can only restrict and cannot elevate. Do not label it Codex Auto or claim parity with all Codex security layers. Tests cover profile mapping, fail-closed launch construction, file confinement, Bash/web/MCP approvals, context preservation, transient UI and full-access warning cancellation. A real Windows native profile probe has verified ordinary workspace writes and `.everpeace` denial; native network denial and Linux/macOS enforcement, live-model and full TUI acceptance remain pending.

## 团队权限与审批

成员权限不高于根，worker 最高 workspace-write，调查／审查只读。子 Agent 不持有 MCP 外部副作用工具；需要用户回答交给根汇总。根与成员审批共用队列，明确来源、动作、目录，权限 revision 改变收束整个团队。整合依然走现有预览、版本与回滚保护，详见 [TEAMS](TEAMS.md)。

## Prompt Injection 验收范围

普通 README、网页、搜索、MCP 返回与终端输出不能提升权限或覆盖当前用户决定。生产 coding runner 的六入口 × 六攻击矩阵断言零越界/凭据/禁止网络副作用及拒绝后的替代调用仍被宿主拒绝。来源标签不代替 revision 绑定审批、文件边界或 native sandbox；已授予 full-access 的宿主能力不宣称受到原生隔离限制。见 [安全与诊断契约](SECURITY_AND_DIAGNOSTICS.md#外部内容与授权)。
