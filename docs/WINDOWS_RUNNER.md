# Dedicated Windows native acceptance

This machine is a release dependency. Hosted Windows still runs the general suite; it does not supply native sandbox evidence. macOS is experimental and has no required release job.

## Machine preparation

Use a dedicated Windows x64 machine or disposable VM with the Windows and virtualization capabilities needed by the pinned MXC backend. Keep personal credentials and daily development work off it. Install Node 22, Git, pnpm 10.22.0 and a current GitHub Actions runner supporting Node 24 actions (at least 2.327.1; use the current maintained runner). Run under a dedicated account with only the setup privileges required by MXC. Do not disable sandbox or network controls to make a probe pass.

Before registration, install the repository with its frozen lockfile and run:

```powershell
pnpm install --frozen-lockfile
pnpm install:verify
$env:EVERPEACE_NATIVE_REQUIRED = '1'
$env:EVERPEACE_NATIVE_MODE = 'required'
pnpm native:verify
```

All required native tests listed in [nativeTests](../scripts/release/policy.mjs) must execute and pass, including authorized subdirectory and existing linked-worktree isolation. A zero-test result, skipped/TODO test, unavailable backend, failed network denial or surviving fixture process is a failure. `native-evidence/receipt.json` records the commit, platform/backend and event-log digest; inspect `success`, not just file presence. An uncommitted local run is development evidence, not release evidence.

## Registration and access

Register the runner in repository Settings → Actions → Runners with labels `self-hosted`, `Windows`, `X64`, `everpeace-native`. Prefer an ephemeral registration and a clean image restored for each job. Registration tokens are short lived; never put them into the repository, logs or this document. The host supervisor must restore the image and destroy the work directory after completion, timeout or cancellation. Refuse a new job until owned fixture processes are gone; quarantine the image on cleanup failure.

Configure repository secret `RUNNER_READ_TOKEN` as a fine-grained token restricted to this repository with **Administration: read**. It is used only by the hosted availability job to list runner status. The default `GITHUB_TOKEN` cannot be assumed to have this permission. Missing secret, insufficient permission, offline/busy runner or mismatched labels blocks acceptance. The native job receives no publishing token. Do not register this runner for untrusted pull requests; the workflow only runs for main dispatch/candidates and scheduled checks.

An availability check is not a reservation. A runner can disappear after the check; a hosted watchdog cancels this workflow if the dedicated job does not start within five minutes. Only that watchdog has Actions cancellation permission, scoped to its own run in code; it has no publishing permission. The native execution timeout is 30 minutes. Operate the supervisor so the checked runner remains available; a queued/failed native job can never publish. Weekly execution detects infrastructure drift but does not replace acceptance on each release candidate.

## Repository activation

After deploying the workflows, set the stable **Required checks** job from Test as a required status check on main, with branches required to be up to date. Preserve existing protection settings. Read back the configuration through GitHub API; merely adding YAML does not enable branch protection. The protection is now active, requires the GitHub Actions check, and applies to administrators. Verify it remains enabled when operating the runner; current evidence belongs in HANDOFF.

Release is dispatched on main with an exact 40-character candidate commit SHA. The workflow confirms that commit belongs to main, checks it on Windows/Linux, builds one tarball, downloads its exact artifact ID for npm/pnpm/global installation, and requires native acceptance before any tag/Release creation. Download consumers and publishing independently verify the tarball SHA-256 against the build output. Version tags must resolve to the candidate; conflicting tags/assets are never overwritten.

First run Release with `failure_drill=true` on a disposable reviewed candidate. Windows executes the intentional failing test; `drill` must observe validation failure, gate failure and publishing skipped. Check the run/job identities and repository tags/Releases to confirm zero publishing. The overall run is expected to fail. This mode can only fail checks and always disables publishing; it is not a bypass. Then run normal acceptance on the intended candidate. Save the workflow URL and artifacts with its exact commit. No model credentials or paid provider calls are needed.

The machine is not yet provisioned. Main's Required checks protection has been activated and read back, and the live failure drill has blocked all publishing; exact commit/run evidence is maintained in HANDOFF. Runner registration and candidate native acceptance remain separate from local tests.
