import { persistState } from "../storage/persistence-error.js";
import { randomUUID } from "node:crypto";
import type { ApplyPatchOperation, ApplyPatchResult } from "../tools/apply-patch.js";
import { TurnCheckpoint, type UndoResult } from "./checkpoint.js";
import type { BashResult } from "../tools/bash.js";
import { discoverVerificationCommands, runVerificationCommand, runVerificationSuite, selectVerificationCommand, selectVerificationCommands, verificationPrompt } from "./verifier.js";
import { WorkspaceChangeTracker, type WorkspaceChangeObservation } from "./workspace-tracker.js";
import { createWorkflowState, type VerificationSuiteResult, type WorkflowPatchFollowup, type WorkflowReviewResult, type WorkflowRunResult, type WorkflowState, type VerificationCommand, type WorkflowResultClassification } from "./types.js";

export interface WorkflowRuntimeOptions {
  workspacePath: string;
  initialState?: WorkflowState;
  onState?(state: WorkflowState): void | Promise<void>;
  review?(changedPaths: readonly string[], signal?: AbortSignal): Promise<WorkflowReviewResult>;
  now?: () => string;
}

export interface WorkflowTurnOptions {
  mode?: "default" | "plan";
}

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

  async beginTurn(options: WorkflowTurnOptions = {}): Promise<WorkflowState> {
    const taskId = randomUUID();
    this.#checkpoint.clear();
    this.#changed = false;
    this.#patchChanged = false;
    this.#shellObserved = false;
    this.#trackingLimited = false;
    this.#gitTrackingComplete = false;
    this.#state = {
      ...createWorkflowState(taskId, this.#now()),
      phase: options.mode === "plan" ? "plan" : "understand",
    };
    this.#commandsPromise = discoverVerificationCommands(this.#workspacePath);
    await this.#tracker.begin();
    await this.#save();
    return this.state;
  }

  async capturePatch(operations: readonly ApplyPatchOperation[]): Promise<void> {
    if (this.#state.phase === "blocked") throw new Error("The coding workflow is blocked; start a new task before applying more changes");
    await this.#checkpoint.capture(operations);
    await this.#set({ phase: "implement", checkpoint_available: this.#checkpoint.available });
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
    await this.#set({ phase: "verify_fast", changed_paths: [...paths], checkpoint_available: this.#checkpoint.available });
    const commands = await (this.#commandsPromise ?? discoverVerificationCommands(this.#workspacePath));
    const command = selectVerificationCommand(commands, "fast");
    if (!command) {
      await this.#set({ phase: "implement" });
      return { prompt: "The patch was applied. No safe fast verification command was discovered; inspect the changed files and continue with focused checks." };
    }
    const verification = await runVerificationCommand(command, run, signal);
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
    signal?.throwIfAborted();
    await this.#refreshObservedChanges();
    if (this.#state.phase === "blocked") {
      await this.#set({ phase: "blocked", result: "failed" });
      return { state: this.state, changed: this.#changed };
    }
    if (!this.#changed && !this.#trackingLimited) {
      await this.#set({ phase: "done", result: "no_changes" });
      return { state: this.state, changed: false };
    }
    for (let refreshes = 0; ; refreshes += 1) {
      await this.#set({ phase: "verify_full", verification_retries: refreshes });
      // Re-read the manifest before every pass so checks created or changed by
      // the task (or by a prior verification pass) control the current suite.
      const before = await this.#refreshObservedChanges();
      const commands = await discoverVerificationCommands(this.#workspacePath);
      signal?.throwIfAborted();
      const suite = await runVerificationSuite(selectVerificationCommands(commands, "full"), run, signal);
      signal?.throwIfAborted();
      const after = await this.#refreshObservedChanges();
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

      const stale = before.available && before.complete && after.available && after.complete
        && before.revision !== after.revision;
      if (stale && refreshes < MAX_VERIFICATION_REFRESHES) continue;
      if (stale) {
        const reason = `Workspace contents changed during final verification after ${refreshes + 1} passes`;
        const unavailable: VerificationSuiteResult = { ...suite, status: "unavailable", stale: true, reason };
        await this.#set({
          phase: "done",
          result: "unverified",
          result_reason: reason,
          ...(verification ? { last_verification: verification } : {}),
          last_verification_suite: unavailable,
        });
        return { state: this.state, ...(verification ? { verification } : {}), verificationSuite: unavailable, changed: true };
      }
      return this.#finishReview(signal, suite, verification);
    }
  }

  async #finishReview(
    signal: AbortSignal | undefined,
    suite: VerificationSuiteResult,
    verification: WorkflowRunResult["verification"],
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
    await this.#set({ phase: "done", result });
    return { state: this.state, ...(verification ? { verification } : {}), verificationSuite: suite, review, changed: true };
  }

  async observeShellExecution(): Promise<WorkspaceState> {
    if (this.#state.phase === "blocked") throw new Error("The coding workflow is blocked; start a new task before running more tools");
    this.#shellObserved = true;
    await this.#refreshObservedChanges();
    return { state: this.state, changed: this.#changed };
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

  async undo(): Promise<UndoResult> {
    const result = await this.#checkpoint.undo();
    if (result.status === "undone" || result.status === "conflict") {
      await this.#set({ checkpoint_available: false, changed_paths: this.#state.changed_paths.filter((item) => !result.restored.includes(item)) });
    }
    return result;
  }

  async #refreshObservedChanges(): Promise<WorkspaceChangeObservation> {
    const observation = await this.#tracker.observe();
    if (observation.available && observation.complete) {
      this.#gitTrackingComplete = true;
      this.#changed = observation.changedPaths.length > 0;
      this.#trackingLimited = false;
      await this.#set({
        changed_paths: observation.changedPaths,
        tracking_limited: false,
        checkpoint_available: this.#checkpoint.available,
      });
      return observation;
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

  async #set(patch: Partial<WorkflowState>): Promise<void> {
    this.#state = {
      ...this.#state,
      ...patch,
      changed_paths: patch.changed_paths ? [...patch.changed_paths] : [...this.#state.changed_paths],
      updated_at: this.#now(),
    };
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
  return `Development workflow result: ${result.state.result ?? "unverified"}. Changed paths: ${paths}. Verification: ${checks}.${reason}`;
}
