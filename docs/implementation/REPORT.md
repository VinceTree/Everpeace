# Optimization candidate: evidence and remaining acceptance

This candidate implements the ten requested areas against the restored local source. It does **not** claim that all effectiveness criteria passed. The production repair limit remains three rounds and teams remain explicitly configured. Current candidate identity, final checks and publication status are maintained in [HANDOFF](../HANDOFF.md).

## Acceptance by area

| Item | Existing implementation retained | Strengthening delivered | Evidence / remaining acceptance |
| --- | --- | --- | --- |
| 1 Repair allocation | Three-round production ceiling | Evaluation-only environment/auth stop, type/lint two-round limit, unchanged-diagnostic stop; independent regression/scope classification | [Real comparison](evidence/repair-report.md) is insufficient; no strategy promotion |
| 22 Verification | Project check discovery and VerificationEvidence | Changed-line mapping, fresh workspace/report binding, host-only independent-source binding; old evidence remains readable | Changed-line and verification regression tests; line execution does not establish meaningful assertions or functional correctness |
| 23 Safety | fast-check boundary framework | Generated address/path spellings, permission/cancel sequences, real child cancellation and cleanup; tenfold scheduled scale | Windows regression checks; platform skips remain uncovered; campaign cleanup failures are preserved and block promotion |
| 24 Privacy | Permanent default, retention previews, safe exports, Session leases | More credential formats, multiline/truncated output protection, attachment scans, complete storage map including team journals | CLI/TUI and scanning regressions; scanning cannot establish absence of all secrets |
| 25 Memory | Project 90-day expiry and explicit user preferences | Provenance requirement, revision history, correction/disable refresh before subsequent requests; standalone review CLI | [Real experiment](evidence/memory-report.json): filtered group 30/30; total 89/90 with one parsing failure and unknown usage |
| 26 Team efficiency | Explicit optional root plus two members | Frozen paired design, independent acceptance and regressions, full planned denominators, category gates | [Real comparison](evidence/team-report.md) insufficient; no recommended category or automatic enabling |
| 27 Team workspaces | Nested workspace and existing Git worktree support | Host raw-byte integration, streaming hashes, 64 MiB/file and 256 MiB/snapshot, recovery journals, conditional rollback | Binary create/replace/delete, concurrent edits, cancellation/recovery, junction and disk-failure regressions; submodules/LFS fetching remain unsupported |
| 28 State ownership | Request/context/stream modules | Independent protocol types, TurnLifecycle, ToolDispatcher and durable AgentHistoryWriter | Agent request/event/termination and persistence regression checks; public ReactAgent/CLI/SDK remain compatible |
| 29 Web extraction | Bounded DOM parser and public-network protection | Scored body candidates, nested lists, table headers, fences and links | [24-page comparison](evidence/web-comparison.json), old regex and pre-change DOM; all annotated code retained. Licensed technical content uses synthetic site chrome, not a general-web claim |
| 30 Performance | Request-purpose metering, /perf and safe JSON export | Phase detail and top three contributors, overlap distinction, team integration timing, failed/unknown request accounting | Performance/export regression checks; identical calls are observations, not proof of waste. Single-agent campaign duplicate-read counts remain unknown where not recorded |

## Real-model experiment limits

Both repair and team campaigns froze twelve authored tasks, five repetitions per arm, paired random order, hidden acceptance and independent regression assertions. Four balanced pairs ran concurrently against the same endpoint and machine; arms within a pair ran sequentially. This controls ordering but does not remove shared endpoint or machine contention. Models and parameters were frozen per campaign. Credentials were loaded only through the existing AuthStorage and ModelRegistry.

Token and campaign budgets were explicitly `null`: unlimited, with complete accounting attempted. Process timeouts, cancellation and cleanup safety still applied. Each planned run appears either as a result or a recorded skip; failed and unknown runs were not removed. Recorded Windows `taskkill` cleanup failures stopped each campaign and retained pending runs as skips. No safety/cleanup, quality, metering or efficiency gate was relaxed to produce a positive result.

Repair recorded 81 of 120 planned runs: 46 passed, 32 failed, 3 errors, 39 skipped; 33 runs have unknown usage. Team recorded 29 of 120: 0 passed, 28 failed, 1 error, 91 skipped; 28 runs have unknown usage. These are insufficient comparisons, not evidence that the candidate policy is faster or that teams improve quality. The apparent wall-time ratio is not an accepted improvement when quality, completeness and usage gates fail.

The Memory experiment completed 90 requests: no-memory 30/30, valid-memory 29/30, filtered/corrected-memory 30/30. The single failure is retained, along with incomplete usage. All filtered snapshots excluded the stale convention. Six synthetic question tasks test filtering and answer behavior; they do not establish long-term project productivity or universal lesson correctness.

The earlier interrupted pilot is retained in [pilot-interruption.json](evidence/pilot-interruption.json). It had an infrastructure error: synthetic preparation initially lacked a pristine Git HEAD. The corrected evaluator commits the healthy fixture before seeding a defect. Pilot and final campaigns are separate; their results were not pooled or replaced. Known recorded consumption is a lower bound whenever usage is unknown, never a billing total. [Repair metering](evidence/repair-metering.json), [team metering](evidence/team-metering.json), and [Memory metering](evidence/memory-metering.json) retain this distinction.

Raw plans, JSONL, model transcripts, frozen harness and original reports remain locally under `.cache/evaluation`. Only diagnostic records without raw code, arguments, absolute customer paths or credentials are included in the public evidence directory. The measured harness identity is recorded in each run; final request-count reporting and large-file fingerprint alignment occurred afterward and are not represented as measurements of a new model run.

## Reproduction

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm install:smoke
pnpm install:clean
pnpm ci:verify
pnpm prove:web
pnpm exec tsx tests/fixtures/prove-optimization.ts
```

The two portable configurations in [evaluation-configs](evaluation-configs/repair.json) use the local registered model ID and explicit unlimited budgets. Choose a newly named artifact directory and update the ID for another machine before running. Authentication stays in the keyring. Freeze the checkout, entry, source/build identity and task digest before comparing another revision; do not edit measured sources during execution.

```sh
pnpm benchmark:optimization --config docs/implementation/evaluation-configs/repair.json --parallel-pairs 4 --live
pnpm benchmark:optimization --config docs/implementation/evaluation-configs/team.json --parallel-pairs 4 --live
pnpm benchmark:memory --live --model-id REGISTERED_MODEL_ID --harness FROZEN_CHECKOUT --output NEW_OUTPUT_DIRECTORY
```

The Memory entry is a parameterized reproduction of the recorded helper, not an additional executed campaign. Its output directory must not exist. To cancel a balanced campaign, use its configured `cancel.request` file or Ctrl+C. Unknown usage and cleanup failure continue to block promotion.

## Migration and user operations

VerificationEvidence v1 and v2 remain readable. Missing independent sources and changed-line evidence are unknown, not synthetic successes. Session records keep additive fields; no history rewrite is required. Legacy Memory without reviewed provenance remains readable but requires review before injection; expiry, disable and supersession are enforced for new requests. Confidence represents extraction confidence, not correctness probability.

Use `/privacy` to inspect exact storage locations and exclusions; `/privacy retention forever|30|90|180|<days>` changes future cleanup policy. `/privacy cleanup` previews deletion. Default export includes diagnostic metadata; conversation export is separately preview-bound, redacted, and refuses overwriting an existing file. Owned attachments are included in deletion. Memory, credentials, input history, exports, team snapshots and transaction journals have independent lifecycles. Inspect retained teams using `/team` and the explicit team cleanup action.

Use `everpeace memory list` and `everpeace memory inspect project <id>` to inspect a revision. `renew`, `disable`, `delete`, and `correct` require that revision. This CLI requires no model request or credential lookup. `/memory` provides the corresponding interactive review. `/perf` shows wall time, overlapping accumulated phases and request-purpose tokens; privacy diagnostic export is the safe report channel.

Binary integration is host-owned: model patch parameters do not carry binary bytes. Conflicts preserve user and worker content. Per-file writes are atomic, and multi-file integration has a recoverable journal; it is not one filesystem-wide atomic transaction. Unknown ownership, incomplete snapshots, Git submodules and symbolic-link escape still fail closed. Explicit cleanup is required for retained recovery material.

## Distribution

This is a source prerelease. The manifest remains private to prevent accidental npm publication. GitHub provides tagged source archives and a sanitized evidence asset. It does not contain a portable `.tgz` claiming verified native installation. The existing formal package pipeline retains Windows native, Linux build, consumer, security and evidence gates. A future server/native runner can execute those gates against a fresh candidate; old receipts do not authorize a new artifact.
