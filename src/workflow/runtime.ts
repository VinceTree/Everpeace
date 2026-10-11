import { persistState } from "../storage/persistence-error.js";
import { randomUUID } from "node:crypto";
import type { ApplyPatchOperation, ApplyPatchResult } from "../tools/apply-patch.js";
import { TurnCheckpoint, type UndoResult } from "./checkpoint.js";
import type { BashResult } from "../tools/bash.js";
import { ProcessCleanupError } from "../tools/process-completion.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { discoverVerificationCommands, runVerificationCommand, runVerificationSuite, selectVerificationCommand, selectVerificationCommands, verificationPrompt } from "./verifier.js";
import { WorkspaceChangeTracker, type WorkspaceChangeObservation } from "./workspace-tracker.js";
import { formatVerificationEvidence, invalidateVerificationEvidence } from "./verification-evidence.js";
import { createWorkflowState, type VerificationSuiteResult, type WorkflowPatchFollowup, type WorkflowReviewResult, type WorkflowRunResult, type WorkflowState, type VerificationCommand, type WorkflowResultClassification, type WorkflowTaskSource } from "./types.js";

export interface WorkflowRuntimeOptions {
  workspacePath: string;
  initialState?: WorkflowState;
  onState?(state: WorkflowState): void | Promise<void>;
  review?(changedPaths: readonly string[], signal?: AbortSignal): Promise<WorkflowReviewResult>;
  now?: () => string;
}

export interface WorkflowTurnOptions {
  mode?: "default" | "plan";
  source?: WorkflowTaskSource;
}

type WorkflowStatePatch = { [Key in keyof WorkflowState]?: WorkflowState[Key] | undefined };

const MAX_VERIFICATION_REFRESHES = 2;

/** Coordinates the production coding loop without changing the model's ReAct protocol. */
export class CodingWorkflowRuntime {
  readonly #workspacePath: string;
  readonly #checkpoint: TurnCheckpoint;
  readonly #tracker: WorkspaceChangeTracker;
  readonly #onState: ((state: WorkflowState) => void | Promise<void>) | undefined;
  readonly #review: ((changedPaths: readonly string[], signal?: AbortSignal) => Promise<WorkflowReviewResult>) | undefined;
  readonly #now: () => string;
  #state: WorkflowState;
  #commandsPromise: Promise<VerificationCommand[]> | undefined;
  #changed = false;
  #patchChanged = false;
  #shellObserved = false;
  #trackingLimited = false;
  #gitTrackingComplete = false;
  #cleanupFailure: ResourceCleanupError | undefined;

  constructor(options: WorkflowRuntimeOptions) {
    this.#workspacePath = options.workspacePath;
    this.#checkpoint = new TurnCheckpoint(options.workspacePath);
    this.#tracker = new WorkspaceChangeTracker(options.workspacePath);
    this.#onState = options.onState;
    this.#review = options.review;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#state = options.initialState ?? createWorkflowState(randomUUID(), this.#now());
  }

  get state(): WorkflowState { return structuredClone(this.#state); }
  get checkpointAvailable(): boolean { return this.#checkpoint.available; }
  get workspacePath(): string { return this.#workspacePath; }

  /** Preserve debt without launching snapshots while resource ownership is unknown. */
  async recordCleanupFailure(failure: ResourceCleanupError = new ProcessCleanupError("Process ownership is unresolved")): Promise<void> {
    this.#cleanupFailure ??= failure;
    this.#trackingLimited = true;
    await this.#set({
      phase: "blocked", result: "unverified", pending_verification: true, tracking_limited: true,
      result_reason: this.#cleanupFailure.resource === "process"
        ? "Process cleanup failed; process ownership is unresolved"
        : "Model stream cleanup failed; request ownership is unresolved",
    });
  }

  assertCleanupComplete(): void {
    if (this.#cleanupFailure) throw this.#cleanupFailure;
  }

  async #verify<T>(run: () => Promise<T>): Promise<T> {
    this.assertCleanupComplete();
    try { return await run(); }
    catch (error) {
      if (error instanceof ProcessCleanupError) {
        try { await this.recordCleanupFailure(error); }
        catch (persistenceError) {
          throw new ProcessCleanupError(new AggregateError([error, persistenceError], `${error.message}; cleanup debt could not be persisted`));
        }
      }
      throw error;
    }
  }

  async beginTurn(options: WorkflowTurnOptions = {}): Promise<WorkflowState> {
    this.assertCleanupComplete();
    const taskId = randomUUID();
    this.#checkpoint.clear();
    this.#changed = false;
    this.#patchChanged = false;
    this.#shellObserved = false;
    this.#trackingLimited = false;
    this.#gitTrackingComplete = false;
    const prior = this.#state.pending_verification || this.#state.result === "unverified" || this.#state.result === "failed"
      ? { task_id: this.#state.task_id, result: this.#state.result === "unverified" ? "unverified" as const : "failed" as const, ...(this.#state.result_reason ? { reason: this.#state.result_reason } : {}) }
      : this.#state.prior_unverified;
    this.#state = {
      ...createWorkflowState(taskId, this.#now(), options.source ?? "user"),
      phase: options.mode === "plan" ? "plan" : "understand",
      ...(prior ? { prior_unverified: prior } : {}),
    };
    this.#commandsPromise = discoverVerificationCommands(this.#workspacePath);
    await this.#tracker.begin();
    await this.#save();
    return this.state;
  }

  /** Rebuild process-local trackers without clearing persisted verification debt. */
  async resumeTurn(): Promise<WorkflowState> {
    this.assertCleanupComplete();
    this.#checkpoint.clear();
    this.#patchChanged = false;
    this.#shellObserved = false;
    this.#trackingLimited = false;
    this.#gitTrackingComplete = false;
    this.#commandsPromise = discoverVerificationCommands(this.#workspacePath);
    await this.#tracker.begin();
    await this.#tracker.trackPaths(this.#state.changed_paths);
    this.#changed = this.#state.pending_verification === true || this.#state.changed_paths.length > 0;
    await this.#set({ task_source: "session_resume", checkpoint_available: false });
    return this.state;
  }

  async capturePatch(operations: readonly ApplyPatchOperation[]): Promise<void> {
    if (this.#state.phase === "blocked") throw new Error("The coding workflow is blocked; start a new task before applying more changes");
    await this.#tracker.trackPaths(operations.map((operation) => operation.path));
    await this.#checkpoint.capture(operations);
    await this.#set({ phase: "implement", pending_verification: true, checkpoint_available: this.#checkpoint.available });
  }

  async afterPatch(
    operations: readonly ApplyPatchOperation[],
    result: ApplyPatchResult,
    run: (command: string, signal?: AbortSignal, timeoutMs?: number) => Promise<BashResult>,
    signal?: AbortSignal,
  ): Promise<WorkflowPatchFollowup> {
    if (result.status !== "applied") {
      if (!this.#changed) this.#checkpoint.clear();
      await this.#set({ checkpoint_available: this.#checkpoint.available });
      return {};
    }
    await this.#checkpoint.recordApplied(operations, result);
    const paths = new Set(this.#state.changed_paths);
    operations.forEach((operation) => paths.add(operation.path));
    this.#changed = true;
    this.#patchChanged = true;
    await this.#refreshObservedChanges();
    await this.#set({ phase: "verify_fast", pending_verification: true, changed_paths: [...paths], checkpoint_available: this.#checkpoint.available });
    const commands = await (this.#commandsPromise ?? discoverVerificationCommands(this.#workspacePath));
    const command = selectVerificationCommand(commands, "fast");
    if (!command) {
      await this.#set({ phase: "implement" });
      return { prompt: "The patch was applied. No safe fast verification command was discovered; inspect the changed files and continue with focused checks." };
    }
    const verification = await this.#verify(() => runVerificationCommand(command, run, signal));
    await this.#set({
      phase: verification.passed ? "implement" : "diagnose",
      last_verification: verification,
      ...(verification.passed ? {} : { result: "failed" as const }),
    });
    return {
      verification,
      ...(verification.passed ? {} : { prompt: verificationPrompt(verification) }),
    };
  }

  async finishTurn(
    run: (command: string, signal?: AbortSignal, timeoutMs?: number) => Promise<BashResult>,
    signal?: AbortSignal,
  ): Promise<WorkflowRunResult> {
    this.assertCleanupComplete();
    signal?.throwIfAborted();
    let before = await this.#refreshObservedChanges();
    if (this.#state.phase === "blocked") {
      await this.#set({ phase: "blocked", result: "failed" });
      return { state: this.state, changed: this.#changed };
    }
    if (!this.#changed && !this.#trackingLimited) {
      if (this.#state.prior_unverified) {
        const reason = `A prior task (${this.#state.prior_unverified.task_id}) still has ${this.#state.prior_unverified.result} changes`;
        await this.#set({ phase: "done", result: "unverified", result_reason: reason, pending_verification: true });
        return { state: this.state, changed: false };
      }
      await this.#set({ phase: "done", result: "no_changes", pending_verification: false });
      return { state: this.state, changed: false };
    }
    for (let refreshes = 0; ; refreshes += 1) {
      await this.#set({ phase: "verify_full", verification_retries: refreshes });
      // Re-read the manifest before every pass so checks created or changed by
      // the task (or by a prior verification pass) control the current suite.
      if (refreshes > 0) before = await this.#refreshObservedChanges();
      const commands = await discoverVerificationCommands(this.#workspacePath);
      signal?.throwIfAborted();
      let suite = await this.#verify(() => runVerificationSuite(selectVerificationCommands(commands, "full"), run, signal, { workspacePath: this.#workspacePath, changedPaths: before.changedPaths, ...(before.available && before.complete && before.revision ? { revision: before.revision } : {}) }));
      signal?.throwIfAborted();
      const after = await this.#refreshObservedChanges();
      const stale = before.available && before.complete && after.available && after.complete && before.revision !== after.revision;
      if (stale && suite.status === "failed" && suite.evidence) suite = { ...suite, stale: true, evidence: invalidateVerificationEvidence(suite.evidence) };
      const verification = suite.results.find((result) => !result.passed) ?? suite.results.at(-1);
      if (suite.status === "failed") {
        const phase = this.#state.repair_attempts >= this.#state.max_repair_attempts && this.#state.repair_attempts > 0
          ? "blocked" as const
          : "diagnose" as const;
        await this.#set({
          phase,
          result: "failed",
          ...(verification ? { last_verification: verification } : {}),
          last_verification_suite: suite,
          ...(phase === "blocked" ? { result_reason: "Automatic repair limit reached" } : {}),
        });
        return { state: this.state, ...(verification ? { verification } : {}), verificationSuite: suite, changed: true };
      }

      if (stale && refreshes < MAX_VERIFICATION_REFRESHES) continue;
      if (stale) {
        const reason = `Workspace contents changed during final verification after ${refreshes + 1} passes`;
        const unavailable: VerificationSuiteResult = { ...suite, status: "unavailable", stale: true, reason, ...(suite.evidence ? { evidence: invalidateVerificationEvidence(suite.evidence) } : {}) };
        await this.#set({
          phase: "done",
          result: "unverified",
          result_reason: reason,
          ...(verification ? { last_verification: verification } : {}),
          last_verification_suite: unavailable,
        });
        return { state: this.state, ...(verification ? { verification } : {}), verificationSuite: unavailable, changed: true };
      }
      return this.#finishReview(signal, suite, verification, after.revision);
    }
  }

  async #finishReview(
    signal: AbortSignal | undefined,
    suite: VerificationSuiteResult,
    verification: WorkflowRunResult["verification"],
    verificationRevision?: string,
  ): Promise<WorkflowRunResult> {
    signal?.throwIfAborted();
    await this.#set({
      phase: "review",
      ...(verification ? { last_verification: verification } : {}),
      last_verification_suite: suite,
    });
    let review: WorkflowReviewResult = { passed: true };
    if (this.#patchChanged && !this.#gitTrackingComplete) {
      const checkpointReview = await this.#checkpoint.reviewCurrent();
      if (!checkpointReview.passed) review = {
        passed: false,
        ...(checkpointReview.error ? { error: checkpointReview.error } : {}),
      };
    }
    if (review.passed && this.#review) {
      try {
        review = await this.#review(this.#state.changed_paths, signal);
        signal?.throwIfAborted();
      } catch (error) {
        if (signal?.aborted) throw error;
        review = { passed: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!review.passed) {
      const prompt = review.error
        ? `Review failed: ${review.error}\n\nInspect the changed files, make a focused fix, and verify again.`
        : "Review failed. Inspect the changed files, make a focused fix, and verify again.";
      const phase = this.#state.repair_attempts >= this.#state.max_repair_attempts && this.#state.repair_attempts > 0
        ? "blocked" as const
        : "diagnose" as const;
      await this.#set({ phase, result: "failed", ...(phase === "blocked" ? { result_reason: "Automatic repair limit reached" } : {}) });
      return { state: this.state, ...(verification ? { verification } : {}), verificationSuite: suite, review, prompt, changed: true };
    }
    const result: WorkflowResultClassification = suite.status === "passed" && !this.#trackingLimited
      ? "verified"
      : "unverified";
    await this.#set({
      phase: "done",
      result,
      pending_verification: result !== "verified",
      ...(result === "verified" ? { prior_unverified: undefined, result_reason: undefined } : {}),
      ...(verificationRevision ? { verification_revision: verificationRevision } : {}),
    });
    return { state: this.state, ...(verification ? { verification } : {}), verificationSuite: suite, review, changed: true };
  }

  async observeShellExecution(): Promise<WorkspaceState> {
    this.assertCleanupComplete();
    if (this.#state.phase === "blocked") throw new Error("The coding workflow is blocked; start a new task before running more tools");
    this.#shellObserved = true;
    await this.#refreshObservedChanges();
    return { state: this.state, changed: this.#changed };
  }

  async runManualVerification(
    commands: readonly VerificationCommand[],
    run: (command: string, signal?: AbortSignal, timeoutMs?: number) => Promise<BashResult>,
    options: { supplemental: boolean; signal?: AbortSignal },
  ): Promise<VerificationSuiteResult> {
    this.assertCleanupComplete();
    options.signal?.throwIfAborted();
    await this.#tracker.trackPaths(this.#state.changed_paths);
    const before = await this.#tracker.observe();
    const suite = await this.#verify(() => runVerificationSuite(commands, run, options.signal, { workspacePath: this.#workspacePath, changedPaths: this.#state.changed_paths, supplemental: options.supplemental, ...(before.available && before.complete && before.revision ? { revision: before.revision } : {}) }));
    options.signal?.throwIfAborted();
    const after = await this.#tracker.observe();
    const gitBound = before.available && before.complete && after.available && after.complete;
    const stale = gitBound && before.revision !== after.revision;
    let structurallyBound = false;
    if (!gitBound && this.#checkpoint.available) structurallyBound = (await this.#checkpoint.reviewCurrent()).passed;
    const settled: VerificationSuiteResult = stale
      ? { ...suite, status: "unavailable", stale: true, reason: "Workspace contents changed during manual verification", ...(suite.evidence ? { evidence: invalidateVerificationEvidence(suite.evidence) } : {}) }
      : !gitBound && !structurallyBound
        ? { ...suite, status: "unavailable", reason: before.reason ?? after.reason ?? "The verification result could not be bound to a complete workspace snapshot" }
        : suite;
    const verification = settled.results.find((result) => !result.passed) ?? settled.results.at(-1);
    const maySettle = !options.supplemental && this.#state.pending_verification === true && settled.status === "passed" && !stale;
    await this.#set({
      ...(maySettle ? { phase: "done" as const, result: "verified" as const, pending_verification: false } : {}),
      ...(verification ? { last_verification: verification } : {}),
      last_verification_suite: settled,
      ...(after.revision ? { workspace_revision: after.revision } : {}),
      ...(maySettle && after.revision ? { verification_revision: after.revision } : {}),
    });
    return settled;
  }

  async startRepairTurn(): Promise<WorkflowState> {
    if (this.#state.phase === "diagnose") {
      if (this.#state.repair_attempts >= this.#state.max_repair_attempts) {
        await this.#set({ phase: "blocked", result: "failed", result_reason: "Automatic repair limit reached" });
      } else {
        await this.#set({ phase: "implement", repair_attempts: this.#state.repair_attempts + 1 });
      }
    }
    return this.state;
  }

  async stopEvaluationRepairs(reason: string): Promise<void> {
    if (this.#state.task_source !== "benchmark" || this.#state.phase !== "diagnose") throw new Error("Evaluation repair stop is unavailable outside a benchmark diagnostic round");
    await this.#set({ phase: "blocked", result: "failed", pending_verification: true, result_reason: reason });
  }

  async undo(): Promise<UndoResult> {
    this.assertCleanupComplete();
    const result = await this.#checkpoint.undo();
    if (result.status === "undone" || result.status === "conflict") {
      await this.#set({ checkpoint_available: false, changed_paths: this.#state.changed_paths.filter((item) => !result.restored.includes(item)) });
    }
    return result;
  }

  async #refreshObservedChanges(): Promise<WorkspaceChangeObservation> {
    this.assertCleanupComplete();
    const observation = await this.#tracker.observe();
    this.assertCleanupComplete();
    if (observation.available && observation.complete) {
      this.#gitTrackingComplete = true;
      const retainedDebt = this.#state.pending_verification === true && this.#state.task_source === "session_resume"
        ? this.#state.changed_paths
        : [];
      const changedPaths = [...new Set([...observation.changedPaths, ...retainedDebt])].sort((left, right) => left.localeCompare(right));
      this.#changed = changedPaths.length > 0;
      this.#trackingLimited = false;
      await this.#set({
        changed_paths: changedPaths,
        tracking_limited: false,
        ...(observation.revision ? { workspace_revision: observation.revision } : {}),
        checkpoint_available: this.#checkpoint.available,
      });
      return { ...observation, changedPaths };
    }
    this.#gitTrackingComplete = false;
    this.#changed = this.#patchChanged || this.#shellObserved;
    this.#trackingLimited = this.#shellObserved || observation.available;
    await this.#set({
      tracking_limited: this.#trackingLimited,
      checkpoint_available: this.#checkpoint.available,
    });
    return observation;
  }

  async #set(patch: WorkflowStatePatch): Promise<void> {
    const next = {
      ...this.#state,
      ...patch,
      changed_paths: patch.changed_paths ? [...patch.changed_paths] : [...this.#state.changed_paths],
      updated_at: this.#now(),
    } as WorkflowState & Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
    this.#state = next;
    await this.#save();
  }

  async #save(): Promise<void> {
    await persistState("Workflow persistence failed", () => this.#onState?.(this.state));
  }
}

interface WorkspaceState { state: WorkflowState; changed: boolean }

export function formatWorkflowSummary(result: WorkflowRunResult): string | undefined {
  if (!result.changed && result.state.result === "no_changes" && !result.state.tracking_limited) return undefined;
  const paths = result.state.changed_paths.length > 0 ? result.state.changed_paths.join(", ") : "unknown";
  const suite = result.verificationSuite ?? result.state.last_verification_suite;
  const checks = suite
    ? suite.status === "unavailable"
      ? `unavailable (${suite.reason ?? "no conventional checks"})`
      : `${suite.status}; ran ${suite.results.map((item) => item.command.command).join(", ") || "none"}${suite.skipped.length > 0 ? `; skipped ${suite.skipped.map((item) => item.command).join(", ")}` : ""}`
    : "not run";
  const reason = result.state.result_reason ? ` Reason: ${result.state.result_reason}.` : "";
  return `Development workflow result: ${result.state.result ?? "unverified"}. Changed paths: ${paths}. Project checks: ${checks}.${reason} ${formatVerificationEvidence(suite?.evidence)}`;
}
