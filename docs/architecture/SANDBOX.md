# Sandbox comparison and optimization plan

Audit date: 2026-09-28. Baseline: Everpeace 0.2.22. This is a comparison of inspected implementations, not a universal ranking or a claim of equivalent enforcement.

## Fixed references

- Codex source: [`c0d26949`](https://github.com/openai/codex/tree/c0d26949be4144c751894ae96e28d3db2208b764). Runtime compatibility was checked separately against installed `@openai/codex@0.155.1`, its CLI help, and [`rust-v0.155.1/debug_sandbox.rs`](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/cli/src/debug_sandbox.rs). New upstream features are not assumed to exist in the pinned package.
- oh-my-pi: [`cabfa74e`](https://github.com/can1357/oh-my-pi/tree/cabfa74e1f6b4e8f53d1afb71b652c024db339fd), particularly [bash executor](https://github.com/can1357/oh-my-pi/blob/cabfa74e1f6b4e8f53d1afb71b652c024db339fd/packages/coding-agent/src/exec/bash-executor.ts), [process ownership/cancellation](https://github.com/can1357/oh-my-pi/blob/cabfa74e1f6b4e8f53d1afb71b652c024db339fd/crates/pi-shell/src/process.rs), and the separate [robomp workspace deployment](https://github.com/can1357/oh-my-pi/blob/cabfa74e1f6b4e8f53d1afb71b652c024db339fd/python/robomp/src/sandbox.py).
- Grok Build: [`f0e3be11`](https://github.com/xai-org/grok-build/tree/f0e3be1100ef5252488e3be8bb0e91cf68d8c305), [sandbox implementation](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-sandbox/src/lib.rs), [profiles](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-sandbox/src/profiles.rs), and [sandbox guide](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md).
- [Official security documentation](https://learn.chatgpt.com/docs/security): approvals and execution isolation serve different purposes. Source inspection and local tests determine the specific claims below.

## Comparison and decision

| Dimension | Everpeace before this change | Codex | oh-my-pi | Grok Build |
| --- | --- | --- | --- | --- |
| Enforcement unit | Each model shell invocation uses the pinned native backend; Node file tools and MCP remain outside it | Native platform sandbox plus permission-aware tool orchestration; current source also has sandboxed filesystem execution surfaces | Inspected main shell uses brush/native execution and host PTY, with application permission classification; this is not evidence of general OS confinement | With enforcement enabled on supported Unix, restricts the agent process and inherited children |
| Platform fit | Windows PowerShell, Linux/macOS Bash | Windows backends, Linux isolation, macOS Seatbelt | Cross-platform shell execution; separate robomp deployment uses UID/workspace/container arrangements | Landlock/Seatbelt and supplementary Linux mechanisms; non-Unix/non-enforce build has a no-op implementation |
| Network | Built-in web toggle is separate from shell profile and MCP | Permission policy and managed network machinery | Main shell features do not establish a kernel network boundary | Child-network restriction is Linux-only in this revision; documented as no-op on macOS |
| Failure | No host fallback, but text-based helper retry could replay a command | Typed execution/sandbox orchestration | Per-run owned process handles, cancellation, timeout/output lifecycle | Some unsupported/apply-failure branches warn and return success; specific deny protections have stronger refusal paths |
| Configuration protection | Workspace path checks did not exclude control metadata in `apply_patch`; explicit `-P` omitted managed requirements opt-in | Built-in metadata protections and requirements-aware policy resolution | Permission checks and deployment trust boundaries must be evaluated separately | Protects global hook/config paths in selected profiles; documents which profiles/platforms enforce them |

For this project's Windows-first local TypeScript architecture, retaining the pinned Codex backend is the best fit of the three inspected choices. Replacing it with Grok's process-wide restrictions would affect keyring access, Session persistence, directory switching, API/MCP connections and direct user commands. Those require a separate execution worker design, not a wrapper swap. oh-my-pi's process ownership and output lifecycle are useful references; its shell session reuse should not be adopted until permission changes and cwd/environment isolation have tests.

## Confirmed gaps

1. **P0 — output-triggered replay:** stdout/stderr from a payload can contain `helper_unknown_error` or generic sandbox-helper wording. The former retry condition did not even require a failed exit. It could rerun a successful or partially successful command.
2. **P0 — inherited launcher environment:** the Node CLI launcher inherited the entire host environment before OS isolation. `NODE_OPTIONS` can load code there, and credential-shaped variables reach the launcher. The backend's own environment policy is a separate, later boundary.
3. **P0 — host editor bypass:** `apply_patch` did not protect `.git`, `.codex`, `.agents`, or `.everpeace`, and did not reject Windows alternate-stream syntax. File confinement alone is insufficient for control metadata.
4. **P1 — managed requirements omitted:** the installed CLI explicitly ignores managed requirements with a named `-P` invocation unless `--include-managed-config` is supplied. Selecting a familiar profile name does not establish full managed-policy parity.
5. **P1 — application metadata remains shell-writable:** native Windows smoke verified `.git` protection, but `.everpeace` was writable under the built-in workspace profile. The new host-editor guard does not close this shell route.
6. **P1 — rule parsing is narrower than an execution policy:** current command rules match raw string prefixes. Compound commands, interpreters, substitutions and rule intersection need a dedicated parser and tests. A prefix match is not a sandbox boundary.
7. **P1 — incomplete common filesystem boundary:** file tools, patching, workflow snapshots and MCP execute in the host process. MCP can perform remote side effects that local process confinement cannot undo.
8. **P2 — process lifecycle and observability:** process-tree termination is requested, but the 500 ms result watchdog does not prove every descendant is dead. Sandbox readiness/denial currently lacks a dedicated diagnostic surface.

## Phase A — implemented local hardening

- [x] Commands cannot be automatically replayed based on output, whether or not the payload uses the `--` delimiter. Retain legacy bounded helper retry only for the exact profile-only sandbox invocation. A successful exit cannot be classified as helper failure. Ignore late `close` callbacks after settlement.
- [x] Filter inherited model-shell variables before starting the Node launcher: names containing KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL and known runtime/startup injection variables. Retain ordinary paths, platform variables and toolchain settings. Do not filter the direct-user PTY or MCP configuration paths.
- [x] Explicitly enable backend default credential exclusions and pass `--include-managed-config`. A conflicting managed requirement fails the launch; it does not cause a retry without the flag or a host fallback.
- [x] In-process patch preview and dispatch reject control metadata unless host code explicitly enables it after full-access selection. Validate the whole batch before writes; reject alternate-stream paths even with full access. Recheck cancellation and read-only mode after asynchronous workflow checkpoint capture.
- [x] Add regressions for replay on both successful and failed payloads, credential/startup filtering at the actual fake-launcher boundary, pre-cancelled launch, patch batch rejection, and host-controlled full-access editing.

Environment filtering is name-based defense in depth, not complete secret discovery. Explicit trusted backend configuration may set additional environment values; mounted/readable files and credential services require their own policies. `full-access` still means host-user filesystem authority, but does not disable the inherited-variable filter. Direct user commands retain their environment.

## Phase B — unify policy across shell and file tools

Implement this as a separately validated policy change; Phase A must not be presented as completing it.

1. Define an immutable effective policy containing workspace roots, protected paths, network mode, environment policy, approval scope and backend identity. Refresh before each new command; recheck current policy after approval. Preserve project-only restrictions when user settings change.
2. Extend the native profile to make `.everpeace` and the application's user-global permission/state paths read-only to model execution. Validate missing directories, creation after launch, case folding, Windows junctions, rename/parent replacement and Linux/macOS behavior. Do not silently drop unsupported denies. Keep full access an explicit exception.
3. Route read/list/edit through an isolated local worker or supported pinned filesystem executor with the same effective policy. Keep AuthStorage, Session storage and the TUI in the host. Define brokered file access rather than granting the worker access to the keyring or all application state.
4. Replace raw prefix approval with platform-aware command analysis. Every executable segment must pass; nested interpreters and unresolved syntax require whole-command approval or denial. Intersect project restrictions independently of user allows. Do not advertise regex filtering as reliable shell parsing.
5. Add a shell-network control distinct from public web and MCP. Default to the existing profile behavior for compatibility; any network denial must be enforced by the selected backend. Unsupported enforcement fails closed. Domain allowlists require a managed proxy and cannot be inferred from the web toggle.

Acceptance: same protected targets fail through shell and patch; malicious project configuration cannot expand roots or weaken rules; denied compound commands never launch; permission changes invalidate stale approvals; Windows/Linux/macOS tests identify actual enforcement and capability failures. No migration of permissions into Session JSONL.

## Phase C — lifecycle, diagnostics and measured performance

1. Introduce typed outcomes (launch failure, policy refusal, command exit, timeout, cancellation), preserving original command exit/output. A helper retry requires a machine-verifiable pre-execution failure, not matching stderr.
2. Track owned process handles or native job/process groups, inspired by oh-my-pi; verify descendants exit before claiming termination. Quarantine late output after settlement. Maintain direct-user PTY cancellation behavior.
3. Add a transient sandbox diagnostic view: installed backend version, requested/effective policy where available, enforcement availability and probe results. Never infer enforcement from environment markers or expose credentials.
4. Benchmark fixed harmless commands with warm/cold backend startup, cancellation and output size. Only consider reusable workers after tests prove policy, cwd, environment and descendant isolation between requests. No promised percentage speedup.

Acceptance: fake launch failures cause no fallback or replay; cancellation leaves no surviving fixture descendants; output remains bounded; a test fixture cannot mutate metadata, escape roots or use blocked networking. Real provider requests are unnecessary for these sandbox checks. Repeat native probes on Windows, Linux/WSL and macOS before claiming cross-platform acceptance.

## Native smoke evidence and limits

Windows Node with the installed pinned backend was exercised using disposable directories and fixed fixture commands, without model/API requests. Workspace writes succeeded, non-temp sibling writes failed, read-only workspace writes failed, and `.git` writes failed. A sibling inside the system temp directory was writable, as a temporary-directory grant permits; this is not a workspace escape test. `.everpeace` remained writable via shell and is explicitly tracked in Phase B.

Linux/macOS native isolation, live terminal approval flows, process-tree ownership and network-denial probes are not covered by these Windows filesystem results. Automated counts and the latest full-validation status belong in `../HANDOFF.md`.
