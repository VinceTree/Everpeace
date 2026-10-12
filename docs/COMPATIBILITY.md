# Public CLI and SDK compatibility

The exec JSONL contract is independent of Session JSONL storage. Single-agent exec defaults to schema 1; team exec defaults to schema 2. Schemas shipped in `contracts/` describe records. Package versions do not silently reinterpret schema versions. `everpeace` and `everpeace/sdk` export the same `runTask` entry.

Consumers must tolerate additional optional fields, match events by type and tool calls by `call_id`, and treat unknown usage as unknown. Existing required fields, types, units, absence semantics and enums remain stable within a schema. New event types or incompatible meanings require explicit version selection. v1 and v2 remain supported throughout 0.x. Removal requires a later major version, migration instructions and at least two minor releases **and** 90 days of notice.

| Exit | Meaning |
| --- | --- |
| 0 | Successful settlement; inspect workflow result/status to distinguish verified work, no changes and a submitted plan |
| 1 | Runtime or output failure |
| 2 | Configuration/arguments invalid or unavailable |
| 3 | Host verification unsuccessful/unavailable |
| 4 | Step/token/time or incomplete-usage limit |
| 5 | Approval or structured user input required; no automatic approval |
| 130 / 143 | SIGINT / SIGTERM termination after cleanup, where the OS permits delivery |

SDK results have optional stable `errorCode`; the JSONL terminal field is `error_code`. Identifiers are CONFIGURATION_ERROR, RUNTIME_ERROR, VERIFICATION_FAILED, LIMIT_REACHED, INTERACTION_REQUIRED, CANCELLED, OUTPUT_CLOSED, PERSISTENCE_FAILED and CLEANUP_FAILED. Display language never changes them. `error` is diagnostic text, not a stable discriminator. Cleanup failure takes precedence over ordinary cancellation and success.

Configuration failure may produce only `run_finished`. `session_started` identifies the session before task activity. A tool start precedes its matching finish. Team member events can interleave and do not imply that the root task is verified. Awaited SDK callbacks preserve delivery order; callback failure stops the task and waits for cleanup before returning its classified result. A healthy, normally settled JSONL stream has one terminal record and no subsequent events. Closing stdout, killing the process, or breaking a frame can prevent that final record. An unterminated partial line, missing terminal record or invalid middle record is an incomplete run, even if assistant text says it is finished.

SDK `runTask` does not prompt on a terminal. Operational failures resolve as classified results; callers must inspect them. `signal` cancels the task, and `onEvent` may be async. Callback exceptions must not be retried as model requests. Reliable late usage is retained even after cancellation; missing usage is never filled with zero.

Compatibility fixtures and their hashes are under `tests/fixtures/public-contract`. Tests launch built public CLI/SDK consumers without importing implementation modules. Frozen readers and baseline captures must change only through an explicit compatibility review. Consumer-install checks separately prove the actual packaged artifact.
