# Codex Permissions Baseline

Research date: 2026-09-17. This comparison does not claim security equivalence. pi and Grok Build have not yet been evaluated.

## Official Excerpts and Sources

- [Permissions](https://learn.chatgpt.com/docs/permission-modes): "The sandbox defines which files and network resources ChatGPT can access." Approvals separately govern when actions pause for review. The CLI entry point is `/permissions`.
- [Sandbox](https://learn.chatgpt.com/docs/sandboxing): "The sandbox applies to spawned commands, not just to built-in file operations." Codex uses native OS enforcement. `on-request` asks to cross boundaries; `never` does not itself remove sandbox restrictions.
- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security): `workspace-write` plus `on-request` permits autonomous work inside the sandbox. Shell network and web tools are separate surfaces. Writable roots protect `.git`, `.agents`, and `.codex`. Current docs retire explicitly configured `untrusted`; older examples should not be copied blindly.
- [Permission profiles](https://learn.chatgpt.com/docs/permissions): beta named profiles combine filesystem and network policy. Built-ins include `:read-only`, `:workspace`, and `:danger-full-access`. Network domain enforcement additionally needs an active proxy; domain rules alone are insufficient.
- [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules): prefix rules allow, prompt, or forbid commands outside the sandbox; they do not replace isolation.
- [CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli): `/permissions` selects approval presets or named profiles for future actions.

Official developer URLs redirected to learn.chatgpt.com during research. These pages were fetched, not inferred from snippets.

## Everpeace Implementation

| Control | Behavior |
| --- | --- |
| `/permissions` | Shared centered inline command window; Esc returns to the same conversation |
| `ask`, default | Every model Bash command requires user approval |
| `read-only` | All model Bash denied; dedicated workspace file tools available |
| `full-access` | Bash without approvals, after a second explicit warning/confirmation |
| Files | `read_file` and `list_directory`, workspace-only in every mode |
| Web | Independent tool enable/disable setting; public-address checks retained |
| Direct `!` | Explicit user command, unchanged, no model context |
| Lifetime | Process-local; retained across new/clear/resume, reset on restart |

Permission changes do not rebuild the agent or lose context. Every tool call checks current policy; each model request includes it. Permissions are not restored from project files, model output, or JSONL, so resuming cannot silently restore elevated authority. No JSONL schema change.

File tools reject lexical traversal, resolved symlink/junction escapes, and Windows alternate streams. Reads accept regular UTF-8 text up to 128 KiB; nonrecursive directory lists cap at 500 entries. File content enters model context and therefore JSONL: avoid reading secrets. These tools do not access the keyring.

## Security Limits and Future Work

This is application-level tool permission management, NOT an OS sandbox. Approved Bash and full-access Bash run with the host account's permissions, including outside-workspace writes and network. The web toggle does not restrict shell networking, model API traffic, or user-authored commands. Read-only refers to model local tools, not session storage writes or direct user commands.

Path checks block static escapes, not races caused by a concurrent hostile process replacing path components between validation and use, nor hard-linked sensitive files already exposed inside a workspace. Trusted workspaces and OS access controls remain necessary. No secret-detection or prompt-injection-immunity claim is made.

Do not label ask mode Codex Auto/workspace-write. Autonomous shell execution within a boundary needs a real sandbox, not a regex command allowlist. OS backends, extra roots, prefix grants, persistent profiles, managed policy, automatic review, and dedicated file editing remain future work. Compare pi/Grok Build on enforcement, approvals, scope, persistence, revocation, network, and auditability.

Tests cover file reads/listing and static escapes, invalid/binary/oversized data, Bash deny/approval/full access, disabled web, context preservation, transient UI and full-access warning cancellation. Real Windows Terminal and live-model acceptance remain pending.
