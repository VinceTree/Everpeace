# Everpeace

[Public interface contract](docs/COMPATIBILITY.md) · [Contributing](CONTRIBUTING.md) · [FAQ](docs/FAQ.md) · [Installation status](docs/INSTALLATION.md) · [Candidate notes](docs/RELEASE_NOTES.md)

Host display: `--lang auto|en|zh-CN`, `EVERPEACE_LANG` and `/language`. `--accessible` provides append-only TTY interaction; redirected automation uses `exec --json`. [Core-experience acceptance snapshot](docs/core-experience/STATUS.md).


**Candidate 0.6.0-rc.4.** The hardened workspace file backend requires Windows and local NTFS. Other platforms report unavailable file access. See [current validation and limitations](docs/HANDOFF.md); real-model security evaluation remains paused.

**Plan, edit and verify your Node.js / TypeScript project from the terminal.**

[简体中文](README.zh-CN.md) · [Usage guide](docs/USAGE.md) · [Tool acceptance](#real-tools-checked-changes) · [Developer docs](docs/README.md)

[![Test](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml/badge.svg)](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Everpeace is a DeepSeek-first, Windows-first coding harness for personal Node.js and TypeScript projects, available as a terminal CLI, `everpeace exec`, and a TypeScript SDK. It connects the model to project rules, code tools, isolated commands, persistent Sessions and host verification. By default, one agent searches code, proposes a plan, edits files and runs the checks declared by your project.

Work through a plan, review the edits and let the host check the result. It discovers `typecheck → lint → test → build`, runs available checks in order, stops at the first failure and allows at most three repair rounds. Missing checks, stale evidence, cancellation and incomplete usage remain visible.

Persistent Goals retain the full objective in current model context, including after compaction. Completion requires an objective audit plus host acceptance for the same still-active goal and coding turn; new user guidance invalidates earlier completion intent. Blocked status requires the same reported condition across three consecutive host turns; repeated tool calls cannot count as extra turns.

## Start here

Use **Node.js 22+**, Git and **pnpm 10.30.3**, with a Windows local NTFS workspace. Source builds also require MinGW-w64 g++ or Visual Studio C++ Build Tools. Keep optional dependencies enabled for bundled code search.

```powershell
git clone https://github.com/VinceTree/Everpeace.git
cd Everpeace
pnpm install --frozen-lockfile
pnpm files:build
pnpm dev
```

In the terminal, run `/login`, choose DeepSeek, enter your masked API key and select the original model ID returned by the service. OpenAI, OpenCode Go and custom HTTPS Responses endpoints are also supported; capabilities depend on the endpoint. Keys stay in the system credential store, outside project files and Sessions.

For OpenCode Go, choose its login preset and the Flash ID returned by its catalog. The preset uses `https://opencode.ai/inference/go/openai/v1`; model discovery uses Go's separate catalog route. Requests identify Everpeace and send a stable `x-opencode-session` header. Go remains a compatible endpoint with conservative default capabilities; authenticated Responses, tools and usage still require live verification. See the [Go documentation](https://opencode.ai/v2/docs/console/go/) for model availability and workspace region settings.

Model connections honor `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (lowercase names take precedence). Set these before starting the CLI when your endpoint needs a proxy; `ALL_PROXY` alone is insufficient. Proxy settings apply to model traffic, while model shell commands retain their sandbox network policy.

Windows sandboxed commands reuse the host pnpm toolchain: an explicit `PNPM_HOME` is preserved, and its standard host location is fixed before launch when unset.

For a relay that explicitly supports the DeepSeek Responses contract, select `/model profile deepseek`, then `/reasoning high`. `/status` shows the profile, its capability source, and the reasoning value actually sent. This is user configuration, not proof of relay compatibility. Unknown endpoints default to conservative settings; `/model profile auto` restores endpoint detection. Full reasoning items are preserved between tool rounds. Experimental prompt and tool-feedback optimizations remain disabled by default until task quality and measured token use justify them.

Web page reads retain a bounded list of source links, so the agent can follow an official site's navigation and verify citations when search results are broad. Supported Bing click links expose their destination URLs for source discovery; page reads still validate public network boundaries.

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

`pnpm build` clears the generated `dist` directory before compiling. A redirected `dist` is rejected, and type errors produce no new output; fix the errors and rebuild before running the CLI.

Current source version: **0.6.0-rc.4** (source prerelease).

## Real tools, checked changes

| Historical plan | Success / planned | Failed | Timeout / error / cancelled / skipped | Unknown Usage |
| --- | --- | --- | --- | --- |
| Initial tool acceptance | 7 / 13 | 6 | 0 / 0 / 0 / 0 | 5 |
| Later tool acceptance | 5 / 7 | 2 | 0 / 0 / 0 / 0 | 2 |
| Separate retry plan | 1 / 2 | 1 | 0 / 0 / 0 / 0 | 1 |

These are historical `grok-4.6` relay runs. Different source/build candidates remain separate; missing evaluation or intervention evidence is marked **insufficient**. Three additional plans lack summaries and have unknown outcomes. This is not a result for the current candidate or DeepSeek. [Per-run evidence and missing records](docs/benchmark/PUBLIC_REPORT.md). The nine new task categories have offline scorer proofs and zero new model runs.

Root-to-directory rules, `@` attachments and an on-demand project map help the agent understand your code. Edits use current file observations, permission-bound previews and conflict-aware undo. Sessions, forks and context checkpoints preserve work and verification debt across recovery.

Configured MCP tools, resources and prompts and local Skills extend the agent. Learned Memory can retain preferences and verified lessons. Public web tools check redirects and network boundaries. Search falls back to Bing China and DuckDuckGo when the first provider is unavailable. See the [usage guide](docs/USAGE.md) for setup and limits.

Facts from newly completed conversations include host-bound source references when available. `memory_lookup` returns direct `session_event_read` arguments; older entries retain a search query. Exact counts, historical recommendations and date updates should be checked against the original message. Source-chain checks run offline with `node --import tsx scripts/benchmark/prove-memory-sources.mjs <new-evidence-directory>`; see the [Memory protocol](docs/benchmark/MEMORY_FACT_PRESERVATION.md).

Memory captures attributed facts from normally completed conversations; reusable coding lessons still require verified turns. Save a lasting preference with `/remember <preference>`; review conflicts through `/memory candidates` or `everpeace memory candidates list`. Inspect, accept, correct and reject candidates locally with a preview of affected rules. Clearing user Memory applies across workspaces; project clearing affects the current workspace.

MCP stdio programs require separate startup trust and default to a native workspace sandbox with networking denied. `/mcp trust <server>` reviews launch identity, `/mcp reconnect` starts or reloads, and `/mcp revoke <server>` cancels access. `/mcp mode <server> host` explicitly selects host user authority and revokes old trust; review and trust again before starting. Changed executable or entry-script bytes require new trust; dynamic launchers require approval at every startup. Windows host stdio requires a verified executable and argv; configure an interpreter explicitly for `.cmd`/`.bat` entry points. Remote MCP requires HTTPS. Loopback HTTP requires its own exception; redirects are blocked. Missing startup approval returns `interaction_required` (exit 5) in headless CLI/SDK runs.

If sandbox preparation fails before an MCP process starts, status retains the startup cause and the connection can close normally. Started processes still require confirmed cleanup.

Search uses DOM selectors by default. `/web` can explicitly select Brave LLM Context; its key stays in the system credential store, and saving sends no request. `/doctor --live` previews bounded streaming/tool/usage/cancellation probes and defaults to Cancel. `/cost` records user-priced estimates, unknown/partial metering and task warnings; request token budgets are not spending caps. [Security and diagnostic contracts](docs/architecture/SECURITY_AND_DIAGNOSTICS.md).

`/privacy` shows persistence and retention, previews cleanup and exports diagnostics. First setup recommends 30 days and requires a preview review; existing settings stay unchanged. `/history no-save` excludes the next input from input history; the Session still saves it. Suspected secret inputs offer masking, original-text authorization or cancellation; original secrets stay out of input history. Session deletion also removes linked history; older unlinked entries need `/history clear`. `everpeace privacy --help` provides local CLI controls. `/perf` reports measured time and tokens; Project Memory expires after 90 days until reviewed with `/memory`. [Privacy contracts](docs/architecture/SECURITY_HARDENING.md).

Report vulnerabilities privately through [GitHub Security](https://github.com/VinceTree/Everpeace/security/advisories/new). See [SECURITY.md](SECURITY.md) for supported releases and coordinated disclosure. Dependency audit, redacted secret scans, license policy and candidate-bound SBOM evidence are required before merging and publishing.

## Memory reader results and comparisons

This fixed, pre-audited **11-question LongMemEval-S development pilot** used `deepseek-v4.1-flash` through OpenCode Go for both answering and grading, one run per arm, and an **8,000-character retrieved-body limit**. It tested a no-tool fact-memory reader, not a complete coding harness. One incomplete fact store was excluded before the run; existing complete stores were reused without extraction.

| Local strategy | Correct / planned | Accuracy | Public-answer tokens |
| --- | ---: | ---: | ---: |
| Current BM25 fact retrieval — default | 10 / 11 | 90.91% | 28,784 |
| Protected evidence aggregation — experimental | 9 / 11 | 81.82% | 29,507 |

Both arms correctly answered **4 mummies** and **$5,150 minimum combined sale** ($5,000 necklace + at least $150 vanity). Protected aggregation recovered the old aggregator's two lost facts and preserved every current-strategy entry; audited necessary-evidence coverage remained **16/18**, with no gain over current BM25. QA adoption criteria were not met, so it was **not promoted to the default**. The sole score regression came from two different generations with **identical context and request hashes**; this single run does not establish a retrieval-caused regression.

All **22 public answers** completed; the six smoke cases passed in both arms (**12/12**). The entire new run used **68 requests / 68,982 input+output tokens** (62,315 input + 6,667 output), including smoke and grading, with **zero new unknown usage or pending requests**. This is reader-and-grader usage; earlier fact-store construction is excluded. Historical unknown usage remains separate. These are automatic grades on development cases, without human scoring review or formal confidence intervals. [Per-question results and frozen conditions](docs/benchmark/MEMORY_RECALL_REPORT.json).

**External memory references — different experimental conditions, not a leaderboard:**

| System / primary source | Published evidence | Reader / judge | Context reported by that run |
| --- | --- | --- | --- |
| [Hindsight](https://benchmarks.hindsight.vectorize.io/) · [published output manifest](https://github.com/vectorize-io/agent-memory-benchmark/blob/main/blob-manifest.json) | Recounted **11/11 matching question IDs**; full run **473/500 (94.6%)** | Gemini 3.1 Pro Preview / Gemini 2.5 Flash-Lite | Full-run mean **43,624.5 tokens** |
| [Mastra Observational Memory](https://mastra.ai/research/observational-memory) | **468/500 (93.60%)** from category counts; author's **94.87%** is a six-category macro average | gpt-5-mini / GPT-4o; observations use Gemini 2.5 Flash | Mean approximately **30k tokens** |
| [Zep](https://www.getzep.com/research/) | **451/500 (90.2%)** | GPT-5.4 / GPT-5.4 | Median **4,408 tokens** |

Hindsight's 11 IDs and question texts match this pilot, but identical histories have **not** been established. The external runs use different models, graders and context budgets; their published scores were inspected, not independently reproduced. Hindsight and its benchmark publisher share an organization. The 500-question results are not scores on our 11-question subset, and tokens are not interchangeable with our character budget. No cross-system quality, cost or latency advantage is established.

For complete coding harnesses, the comparison currently covers documented mechanisms:

| Harness / primary source | Relevant mechanism | Same-condition result in this pilot |
| --- | --- | --- |
| [DS Harness session query](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-query/README.md) | Exact event reads, bounded source context and relationship traces | Not run |
| [OpenCode](https://opencode.ai/docs/config/#compaction) | Configurable compaction, pruning and reserved context | Not run; Go was only the model service |
| [Claude Code](https://code.claude.com/docs/en/memory) | Persistent rules and an auto-memory index with on-demand topic files | Not run |

Everpeace has production `memory_lookup` and Session source-reading tools, but this reader pilot did not enable them. [Comparison methodology and evidence limits](docs/benchmark/MEMORY_GAP_ANALYSIS.md) · [Current handoff](docs/HANDOFF.md).

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
- Multi-file edits use durable, conditional recovery. Inspect retained batches with `everpeace recover-batch <workspace>` and recover an ID after interactive review. Files up to 16 MiB support small patches; patch payloads remain limited to 512 KiB. Explicit nested-package checks use `/verify --package <relative-path>`. Windows process cleanup uses a verified Job owner; unresolved cleanup blocks later tasks. See [reliability boundaries](docs/architecture/RELIABILITY_HARDENING.md).
- File tools reject reparse points and hard-linked targets. Updates preserve the original, check raw bytes under an exclusive write/delete boundary, and install without overwriting a concurrent target. The path may briefly be absent. Recover retained originals with `everpeace recover-file <workspace> <relative-backup-path>`; later user saves block recovery.
- Sensitive reads offer masking, one-time original access or rejection before model context and Session storage. Original access triggers fresh Web/MCP approvals. Model shell networking defaults off; enabling it authorizes each process separately. Plan displays workspace writes, public networking and sensitive outward transmission separately. [Security boundaries and remaining risks](docs/architecture/SECURITY_HARDENING.md).
- Changed verification scripts or a restored task without a trusted baseline require review; rejection keeps the task unverified.
- Restored verification debt remains pending even when no changed paths are known. Fresh authorized checks must pass; unavailable workspace tracking keeps the result unverified.
- `Ctrl+C` cancels active work and waits for cleanup. While idle it clears a draft, then exits. User-written `!` commands run in a separate host PTY, own terminal input and stay outside model context.
- Resizing preserves the composer draft and reflows history. Terminal mouse, focus and cursor reports are ignored by the composer.
- Request budgets include retries, compaction and repair. Unknown usage prevents another bounded request; reasoning tokens are a subset of output tokens. Token budgets are not strict billing caps.
  Failed requests with unknown usage retain safe HTTP/error categories without logging provider error bodies or headers.

For approval keys, terminal controls and integration setup, see the [usage guide](docs/USAGE.md). Broader coding quality, reliability and cost still require measured testing. [Development status](docs/HANDOFF.md) · [DeepSeek test preparation](docs/benchmark/READINESS.md).

The [official DeepSeek experiment protocol](docs/benchmark/CODING_COMPETITIVENESS.md) prepares 12 upstream tasks, serial equal-budget pairs, a pinned dsh comparison, and Memory, web and performance pilots. Preparation and offline proof do not call models. Official coding success rates, strategy gains and costs remain unmeasured.

## Develop and contribute

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run these gates in order and stop on failure, then run `git diff --check`. Start with [AGENTS.md](AGENTS.md) and the [documentation map](docs/README.md). Report reproducible issues through [GitHub Issues](https://github.com/VinceTree/Everpeace/issues).

The [offline performance protocol](docs/benchmark/LOCAL_PERFORMANCE.md) compares CLI process startup, Session recovery, history search and project scanning with fixed fixtures and saved samples. CLI help timing excludes terminal prompt readiness; local results do not imply model or cross-platform gains.

`pnpm benchmark:memory-batch <prepare|preflight|run|resume|report> <absolute evidence root>` provides the [Go/DeepSeek Memory campaign](docs/benchmark/MEMORY_BATCH.md). Live execution requires `--live` and user authorization; unknown usage blocks resume. Reports use an adapted DeepSeek judge and do not represent official GPT-4o benchmark scores.

For offline gap analysis, use `python scripts/benchmark/analyze-memory.py --campaign <campaign-root> --output <new-analysis-root>` (Python 3.10+, existing Node/tsx). It snapshots evidence outside the campaign and makes no model requests. Add `--replay <snapshot-root>` to recompute captured bytes or `--wait-for-stop` to analyze once the running campaign settles. [Findings, comparison conditions and limits](docs/benchmark/MEMORY_GAP_ANALYSIS.md).

Prepare the fact-preservation experiment offline with `python scripts/benchmark/prepare-memory-facts.py prepare --campaign <campaign-root> --snapshot <analysis-snapshot> --output <new-preparation-root>`, then check it with `python scripts/benchmark/prepare-memory-facts.py verify --root <preparation-root>`. This creates split manifests, candidate replay evidence and synthetic tasks; the preparation itself does not run production capture or models. The bounded pilot entry below validates the implemented candidate. [Protocol and limits](docs/benchmark/MEMORY_FACT_PRESERVATION.md).

The small fact-memory pilot uses `pnpm benchmark:memory-pilot prepare <new-absolute-root> <preparation-root> <baseline-root>` after the four validation gates, then `pnpm benchmark:memory-pilot run <absolute-root> --live`. It is limited to 12 development questions, two arms and six smoke cases under a shared 2,000,000-token budget; it never starts the holdout or full batch.

To continue only skipped pilot items after explicit authorization, use `pnpm benchmark:memory-pilot prepare-skipped <new-absolute-root> <sealed-parent-root>`, then run the new root with `--live`. Completed items, failed items and passed smoke cases are retained; parent unknown usage remains disclosed.

The BGE-base/MMR experiment uses `pnpm benchmark:memory-recall prepare-bge-model <new-model-root>` and `prepare-bge <new-root> <parent> <child> <semantic-audit-json> <model-root>`, followed by the same `preflight`, `run --live`, and `report` commands. It preserves all baseline evidence and compares direct relevance with MMR for complementary additions. Model assets remain explicit and the normal default stays `current`. The new paired pilot completed all 22 answers: `current` 9/11 and BGE/MMR 10/11, with no regressions among baseline-correct questions. It recovered the magazine evidence, used 68,027 input+output tokens including smoke and judging, and met the preset experiment adoption criteria. This is one run on studied development questions, not held-out validation. [Public result](docs/benchmark/MEMORY_BGE_MMR_REPORT.json).

Local semantic recall is an explicit experimental candidate. Use `pnpm benchmark:memory-recall prepare-model <new-model-root>`, then `prepare-semantic <new-root> <parent> <child> <semantic-audit-json> <model-root>`, followed by `preflight`, `run --live`, and `report`. It runs pinned E5 ONNX weights on the local CPU, preserves the complete BM25 baseline, and requires both audited missing facts before live evaluation. The normal default remains `current`; model assets are never downloaded implicitly. Windows requires compatible VC++ runtime libraries. The earlier E5 offline screen retained 16/18 required facts under both thresholds, but recovered neither missing magazine fact; it did not qualify for live QA, and consumed no new API tokens. See the [evaluation protocol](docs/benchmark/MEMORY_FACT_PRESERVATION.md).

For aggregation-loss repair, use `pnpm benchmark:memory-recall prepare-protected <new-absolute-root> <sealed-parent> <sealed-child> <evidence-audit-json>`. This explicitly freezes the preservation-repair gate: preserve every baseline row and recover audited losses before the authorized reader pilot. It reports evidence gain separately; the default quality-and-cost adoption criteria still apply.

The sealed-store recall pilot uses `pnpm benchmark:memory-recall prepare <new-absolute-root> <sealed-parent> <sealed-child> <evidence-audit-json>`, followed by `preflight <root>`, `run <root> --live`, and `report <root>`. It compares frozen local retrieval candidates without extraction. The default prepare mode requires improved audited evidence without losses, explicit authorization and a new 500,000-token budget; otherwise it stops offline. See [the protocol](docs/benchmark/MEMORY_FACT_PRESERVATION.md).

Learned Memory now ranks eligible facts and evidence with local BM25 within the existing context budget. Retrieval-only replay is available with `node --import tsx scripts/benchmark/replay-memory-recall.mjs <parent-root> <child-root> <anchor-audit-json> <new-output>`; it reuses stored facts without model requests or extraction.

Finished pilots can be compared offline with `python scripts/benchmark/compare-memory-fact-pilots.py --before <old-root> --after <new-root> --output <new-analysis-root>`. This reads existing ledgers, keeps failed and skipped items, and makes no model requests.

After an authorized repair, `prepare <new-root> --continue-from <stopped-root>` freezes the parent evidence and retains complete verified coding chains. Failed attempts and unknown usage stay visible; the new candidate requires preflight and smoke again. Public QA runs entirely on the new candidate by default.

Add `--continue-unrun` only after approval of the documented protocol change to preserve all terminal public results and run only unstarted items. Closed service failures are retained without retry; pending requests still block recovery, historical usage stays incomplete, and formal confidence intervals are disabled.

Licensed under [Apache 2.0](LICENSE). Maintained by [VinceTree](https://github.com/VinceTree).

## Network and source installation

Public web and remote Skill requests bind validated DNS addresses to the actual connection, including HTTP/HTTPS proxy CONNECT. Configure host HTTP_PROXY, HTTPS_PROXY and NO_PROXY (lowercase variants are supported). Proxy infrastructure is trusted; SOCKS/PAC are unsupported and failures do not fall back to a direct connection. HTTPS certificate verification remains enabled. [Network boundary](docs/architecture/NETWORK.md).

Source installation uses pnpm and the pinned node-pty patch. Run `pnpm files:build`, `pnpm install:verify`, `pnpm build`, `pnpm files:smoke`, `pnpm process:smoke`, then `pnpm install:smoke`. `pnpm install:clean` checks a fresh source installation and recompiles the file worker and process owner. Native file race tests use `pnpm files:verify`. The packer requires a verified Windows file worker and process owner, includes its digest and rejects fault-injection workers; ordinary npm/pnpm pack remains blocked. Formal portable packaging and consumer delivery still require separate acceptance. npm registry publication remains pending.

Node 22 CI runs the full suite on Windows and portable privacy/network/provider tests on Linux. Linux/macOS workspace file access is unavailable in this candidate; portable tests do not establish native file support. Release still requires dedicated Windows and package acceptance; no Release is created by a source push. [Windows runner](docs/WINDOWS_RUNNER.md). Development gates run `typecheck → lint → test → build`, stopping on failure, followed by UI/document and installation checks. Paid tests need separate numerical authorization.

Hosted Windows omits nested native sandbox cases. Dedicated native acceptance requires them, including MCP discovery, filtering and startup isolation; host MCP protocol and cleanup tests still run on hosted Windows.
