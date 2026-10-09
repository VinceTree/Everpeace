# Everpeace

**A personal coding agent that takes a workspace from a plan to checked changes.**

[简体中文](README.zh-CN.md) · [Usage guide](docs/USAGE.md) · [Developer docs](docs/README.md)

[![Test](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml/badge.svg)](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Everpeace is a DeepSeek-first, Windows-first CLI for personal Node.js and TypeScript projects. One agent reads project rules, searches code, proposes a plan, edits files and runs the checks declared by your project. You can work in an inline terminal conversation, automate a task with `everpeace exec`, or call the same runner from TypeScript.

The host decides whether a coding task is finished: it discovers `typecheck → lint → test → build`, runs available checks in order, stops at the first failure and allows at most three repair rounds. Missing checks, stale evidence, cancellation and incomplete usage remain visible.

## Start here

Use **Node.js 22+**, Git and **pnpm 10.22.0**. Install from the repository so its Windows `node-pty` patches are applied. Keep optional dependencies enabled for bundled code search.

```powershell
git clone https://github.com/VinceTree/Everpeace.git
cd Everpeace
pnpm install --frozen-lockfile
pnpm dev
```

In the terminal, run `/login`, choose DeepSeek, enter your masked API key and select the original model ID returned by the service. OpenAI and custom HTTPS Responses endpoints are also supported; capabilities depend on the endpoint. Keys stay in the system credential store, outside project files and Sessions.

```text
/login
/plan
Explain the request budget flow and propose a focused regression fix.
```

Review or revise the submitted plan, approve it, then explicitly start execution. `/diff` reviews changes; `/status` shows request settings and usage; `/resume` restores a Session. `/doctor` runs local diagnostics. `/doctor --live` makes a model request and can incur cost.

For the built CLI:

```powershell
pnpm build
pnpm link --global
everpeace
```

Current source version: **0.3.24**. This source update does not create a GitHub Release.

## What the agent helps you do

| Work | How it supports you |
| --- | --- |
| Understand a project | Root-to-directory rules, bundled search, `@` attachments and an on-demand project map. Optional read-only TypeScript navigation supports definition, references, implementation and hover. |
| Make a reviewed change | Plan revision and approval, observed-file edits, permission-bound previews, change review and conflict-aware undo. |
| Continue a longer task | Durable Sessions, independent forks, context checkpoints, task-owned background commands and verification debt preserved across recovery. |

Configured MCP tools, resources and prompts and local Skills extend the agent. Learned Memory can retain preferences and verified lessons. Public web tools check redirects and network boundaries. See the [usage guide](docs/USAGE.md) for setup and limits.

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

## Control and boundaries

- Model shell commands run in a pinned native sandbox. Windows uses PowerShell through MXC. Sandbox or LSP network-probe failure blocks execution. Optional language servers must already be installed and explicitly configured.
- File updates require a current observed version. Approval and undo cannot overwrite a later user edit. Session recovery restores work, while current permissions govern new actions.
- While approval is pending, an empty prompt accepts `y` to approve or `n`/Enter to reject. Once you type a draft, Enter sends guidance and does not approve the tool.
- Resizing command windows keeps their content and drafts visible. Long Markdown histories share resize observation without adding a listener for every block.
- `Ctrl+C` cancels active work and waits for cleanup. While idle it clears a draft, then exits. User-written `!` commands run in a separate host PTY, own terminal input and stay outside model context.
- Request budgets include retries, compaction and repair. Unknown usage prevents another bounded request; reasoning tokens are a subset of output tokens. Token budgets are not strict billing caps.

Offline regressions and native probes establish engineering behavior. Real-model coding quality, reliability and cost still require measured testing; Windows Terminal manual acceptance is tracked separately. [Current evidence and pending gates](docs/HANDOFF.md) · [DeepSeek test preparation](docs/benchmark/READINESS.md).

## Develop and contribute

```powershell
pnpm typecheck
pnpm test
pnpm build
```

There is currently no lint script. Start with [AGENTS.md](AGENTS.md) and the [documentation map](docs/README.md). Report reproducible issues through [GitHub Issues](https://github.com/VinceTree/Everpeace/issues).

Licensed under [Apache 2.0](LICENSE). Maintained by [VinceTree](https://github.com/VinceTree).
