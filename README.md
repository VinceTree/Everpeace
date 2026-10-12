# Everpeace

**Plan, edit and verify your Node.js / TypeScript project from the terminal.**

[简体中文](README.zh-CN.md) · [Usage guide](docs/USAGE.md) · [Tool acceptance](#real-tools-checked-changes) · [Developer docs](docs/README.md)

[![Test](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml/badge.svg)](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Everpeace is a DeepSeek-first, Windows-first CLI for personal Node.js and TypeScript projects. By default, one agent reads project rules, searches code, proposes a plan, edits files and runs the checks declared by your project. You can work in an inline terminal conversation, automate a task with `everpeace exec`, or call the same runner from TypeScript.

Work through a plan, review the edits and let the host check the result. It discovers `typecheck → lint → test → build`, runs available checks in order, stops at the first failure and allows at most three repair rounds. Missing checks, stale evidence, cancellation and incomplete usage remain visible.

## Start here

Use **Node.js 22+**, Git and **pnpm 10.22.0**. Install from the repository so its Windows `node-pty` patches are applied. Keep optional dependencies enabled for bundled code search.

```powershell
git clone https://github.com/VinceTree/Everpeace.git
cd Everpeace
pnpm install --frozen-lockfile
pnpm dev
```

In the terminal, run `/login`, choose DeepSeek, enter your masked API key and select the original model ID returned by the service. OpenAI and custom HTTPS Responses endpoints are also supported; capabilities depend on the endpoint. Keys stay in the system credential store, outside project files and Sessions.

Model connections honor `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (lowercase names take precedence). Set these before starting the CLI when your endpoint needs a proxy; `ALL_PROXY` alone is insufficient. Proxy settings apply to model traffic, while model shell commands retain their sandbox network policy.

For a relay that explicitly supports the DeepSeek Responses contract, select `/model profile deepseek`, then `/reasoning high`. `/status` shows the profile, its capability source, and the reasoning value actually sent. This is user configuration, not proof of relay compatibility. Unknown endpoints default to conservative settings; `/model profile auto` restores endpoint detection. Full reasoning items are preserved between tool rounds. Experimental prompt and tool-feedback optimizations remain disabled by default until task quality and measured token use justify them.

Web page reads retain a bounded list of source links, so the agent can follow an official site's navigation and verify citations when search results are broad.

```text
/login
/plan
Explain the request budget flow and propose a focused regression fix.
```

Review or revise the submitted plan, approve it, then explicitly start execution. `/diff` reviews changes; `/status` shows request settings and usage; `/resume` restores a Session. `/doctor` runs local diagnostics. `/doctor --live` previews bounded probes; starting them explicitly can incur cost.

For the built CLI:

```powershell
pnpm build
pnpm link --global
everpeace
```

Current source version: **0.5.3**.

## Real tools, checked changes

| Historical plan | Success / planned | Failed | Timeout / error / cancelled / skipped | Unknown Usage |
| --- | --- | --- | --- | --- |
| Initial tool acceptance | 7 / 13 | 6 | 0 / 0 / 0 / 0 | 5 |
| Later tool acceptance | 5 / 7 | 2 | 0 / 0 / 0 / 0 | 2 |
| Separate retry plan | 1 / 2 | 1 | 0 / 0 / 0 / 0 | 1 |

These are historical `grok-4.6` relay runs. Different source/build candidates remain separate; missing evaluation or intervention evidence is marked **insufficient**. Three additional plans lack summaries and have unknown outcomes. This is not a result for the current candidate or DeepSeek. [Per-run evidence and missing records](docs/benchmark/PUBLIC_REPORT.md). The nine new task categories have offline scorer proofs and zero new model runs.

Root-to-directory rules, `@` attachments and an on-demand project map help the agent understand your code. Edits use current file observations, permission-bound previews and conflict-aware undo. Sessions, forks and context checkpoints preserve work and verification debt across recovery.

Configured MCP tools, resources and prompts and local Skills extend the agent. Learned Memory can retain preferences and verified lessons. Public web tools check redirects and network boundaries. Search falls back to Bing China and DuckDuckGo when the first provider is unavailable. See the [usage guide](docs/USAGE.md) for setup and limits.

MCP stdio programs require separate startup trust. Use `/mcp trust <server>` to review and save approval for the current workspace and exact configuration, `/mcp reconnect` to start or reload, and `/mcp revoke <server>` to cancel access. Approval allows the program to run with your host user permissions; MCP tool-call approval does not sandbox it. Remote MCP requires HTTPS. Loopback HTTP requires its own explicit exception; redirects are blocked. Headless CLI/SDK runs return `interaction_required` (exit 5) before model requests when startup approval is missing.

Search uses DOM selectors by default. `/web` can explicitly select Brave LLM Context; its key stays in the system credential store, and saving sends no request. `/doctor --live` previews bounded streaming/tool/usage/cancellation probes and defaults to Cancel. `/cost` records user-priced estimates, unknown/partial metering and task warnings; request token budgets are not spending caps. [Security and diagnostic contracts](docs/architecture/SECURITY_AND_DIAGNOSTICS.md).

`/privacy` shows local persistence and retention (forever by default), previews cleanup, scans credentials and exports diagnostic summaries; conversation export requires a separate review. `everpeace privacy --help` provides the local CLI. `/perf` separates wall time, cumulative phases and known tokens; missing measurements stay unknown. Workflow reports distinguish project checks from independent functional verification. Project Memory expires after 90 days and pauses recall until reviewed with `/memory`; team workers can use authorized Git subdirectories and existing linked worktrees. [Evidence, privacy and performance contracts](docs/architecture/VALIDATION_PRIVACY_PERFORMANCE.md).

Report vulnerabilities privately through [GitHub Security](https://github.com/VinceTree/Everpeace/security/advisories/new). See [SECURITY.md](SECURITY.md) for supported releases and coordinated disclosure. Dependency audit, redacted secret scans, license policy and candidate-bound SBOM evidence are required before merging and publishing.

## Automate the same workflow

```powershell
everpeace exec "Fix the failing test and run the project checks" -C C:\projects\my-app --model deepseek-flash --token-budget 100000 --json
```

`exec` uses the same permissions, tools, Session storage, verification and cleanup as the terminal. It stops when user interaction is required. `--plan` inspects without implementing; `--resume <session-id>` continues in a fresh fork. JSONL consumers must inspect the final event and process exit code, including cancellation and output-pipe failures.

```typescript
import { runTask } from 'everpeace/sdk';

const result = await runTask({
  prompt: 'Fix the failing test and run the project checks',
  workspacePath: 'C:/projects/my-app',
  model: 'deepseek-flash',
  tokenBudget: 100_000,
});
console.log(result.classification);
```

The SDK uses registered credentials; it does not accept an API key in task options. [Full options, events and exit codes](docs/USAGE.md#non-interactive-execution).

## Optional Agent teams

Open `/team on` to enable collaboration, then `/team` to configure role models and limits or inspect members. The root Agent can delegate investigation, coding and review to at most two children; the default total is three Agents. Settings apply while idle. `Ctrl+C` cancels the team and waits for cleanup.

```powershell
everpeace exec "Implement two independent changes and verify the project" --team --max-agents 3 --worker-model <registered-id> --json
```

SDK: add `team: { maxAgents: 3, models: { worker: '<registered-id>' } }` to `runTask`. Role selectors use registered model IDs and inherit the root model when omitted. Coding members use isolated Git worktrees seeded from current workspace bytes, including uncommitted changes. Integration protects concurrent edits; only the root's final checks establish success. Plan permits read-only members. Default shared limits are 96 provider attempts and 30 minutes; root limits can be stricter.

Team JSONL uses schema v2; ordinary execution retains v1. Interrupted or conflicting artifacts remain available for explicit continuation or cleanup in `/team`. [Configuration, recovery and limits](docs/USAGE.md#agent-teams). Engineering fixtures cover collaboration; no real-model speed, token savings or success-rate claim is made.

## Control and boundaries

- Model shell commands run in a pinned native sandbox. Windows uses PowerShell through MXC. Sandbox or LSP network-probe failure blocks execution. Optional language servers must already be installed and explicitly configured.
- File updates require a current observed version. Approval and undo cannot overwrite a later user edit. Session recovery restores work, while current permissions govern new actions.
- `Ctrl+C` cancels active work and waits for cleanup. While idle it clears a draft, then exits. User-written `!` commands run in a separate host PTY, own terminal input and stay outside model context.
- Request budgets include retries, compaction and repair. Unknown usage prevents another bounded request; reasoning tokens are a subset of output tokens. Token budgets are not strict billing caps.
  Failed requests with unknown usage retain safe HTTP/error categories without logging provider error bodies or headers.

For approval keys, terminal controls and integration setup, see the [usage guide](docs/USAGE.md). Broader coding quality, reliability and cost still require measured testing. [Development status](docs/HANDOFF.md) · [DeepSeek test preparation](docs/benchmark/READINESS.md).

## Develop and contribute

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run these gates in order and stop on failure, then run `git diff --check`. Start with [AGENTS.md](AGENTS.md) and the [documentation map](docs/README.md). Report reproducible issues through [GitHub Issues](https://github.com/VinceTree/Everpeace/issues).

Licensed under [Apache 2.0](LICENSE). Maintained by [VinceTree](https://github.com/VinceTree).

## Network and source installation

Public web and remote Skill requests bind validated DNS addresses to the actual connection, including HTTP/HTTPS proxy CONNECT. Configure host HTTP_PROXY, HTTPS_PROXY and NO_PROXY (lowercase variants are supported). Proxy infrastructure is trusted; SOCKS/PAC are unsupported and failures do not fall back to a direct connection. HTTPS certificate verification remains enabled. [Network boundary](docs/architecture/NETWORK.md).

Source installation uses pnpm and the pinned node-pty patch. Run `pnpm install:verify`, build, then `pnpm install:smoke`; maintainers can run `pnpm install:clean` for a clean source installation. To produce a portable tarball, run `pnpm build` then `pnpm pack:release --output <empty-directory>`. It bundles the patched native dependency and its license; plain npm/pnpm pack is rejected. `pnpm install:consumer <package-directory> --local` checks clean npm, pnpm and global installation without model credentials. Portable candidates are built on Ubuntu 24.04 x64: the packer compiles Linux PTY in audited staging and retains the upstream Windows prebuilds, so pnpm need not execute a bundled child script. The producer needs Python, make and a C++ compiler; Windows local packing is development only. Other Linux systems/architectures remain unverified. npm registry publication remains pending.

Windows/Linux have Node 22 CI. **macOS support is experimental**, with no complete CI or native sandbox acceptance. Release requires an exact main commit, all platform and package checks, and dedicated Windows native acceptance; an absent runner or skipped required test blocks publishing. Maintainer setup and failure-drill instructions: [Windows runner](docs/WINDOWS_RUNNER.md). Development gates are `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` in order, stopping on failure, plus `git diff --check`. [Current team evaluation preparation](docs/benchmark/TEAM_READINESS.md) uses offline evidence and requires separate numerical authorization for paid tests.
