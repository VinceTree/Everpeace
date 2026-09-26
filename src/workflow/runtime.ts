import { randomUUID } from "node:crypto";
import type { ApplyPatchOperation, ApplyPatchResult } from "../tools/apply-patch.js";
import { TurnCheckpoint, type UndoResult } from "./checkpoint.js";
import { discoverVerificationCommands, runVerificationCommand, selectVerificationCommand, verificationPrompt } from "./verifier.js";
import { createWorkflowState, type WorkflowPatchFollowup, type WorkflowRunResult, type WorkflowState } from "./types.js";

export interface WorkflowRuntimeOptions {
  workspacePath: string;
  initialState?: WorkflowState;
  onState?(state: WorkflowState): void | Promise<void>;
  now?: () => string;
}

export interface WorkflowTurnOptions {
  mode?: "default" | "plan";
}

/** Coordinates the production coding loop without changing the model's ReAct protocol. */
export class CodingWorkflowRuntime {
  readonly #workspacePath: string;
  readonly #checkpoint: TurnCheckpoint;
  readonly #onState: ((state: WorkflowState) => void | Promise<void>) | undefined;
  readonly #now: () => string;
  #state: WorkflowState;
  #commandsPromise: ReturnType<typeof discoverVerificationCommands> | undefined;
  #changed = false;

  constructor(options: WorkflowRuntimeOptions) {
    this.#workspacePath = options.workspacePath;
    this.#checkpoint = new TurnCheckpoint(options.workspacePath);
    this.#onState = options.onState;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#state = options.initialState ?? createWorkflowState(randomUUID(), this.#now());
  }

  get state(): WorkflowState { return { ...this.#state, changed_paths: [...this.#state.changed_paths] }; }
  get checkpointAvailable(): boolean { return this.#checkpoint.available; }
  get workspacePath(): string { return this.#workspacePath; }

  async beginTurn(options: WorkflowTurnOptions = {}): Promise<WorkflowState> {
    const taskId = randomUUID();
    this.#checkpoint.clear();
    this.#changed = false;
    this.#state = {
      ...createWorkflowState(taskId, this.#now()),
      phase: options.mode === "plan" ? "plan" : "understand",
    };
    this.#commandsPromise = discoverVerificationCommands(this.#workspacePath);
    await this.#save();
    return this.state;
  }

  async capturePatch(operations: readonly ApplyPatchOperation[]): Promise<void> {
    await this.#checkpoint.capture(operations);
    await this.#set({ phase: "implement", checkpoint_available: this.#checkpoint.available });
  }

  async afterPatch(
    operations: readonly ApplyPatchOperation[],
    result: ApplyPatchResult,
    run: (command: string, signal?: AbortSignal, timeoutMs?: number) => Promise<import("../tools/bash.js").BashResult>,
    signal?: AbortSignal,
  ): Promise<WorkflowPatchFollowup> {
    if (result.status !== "applied") {
      if (!this.#changed) this.#checkpoint.clear();
      return {};
    }
    await this.#checkpoint.recordApplied(operations, result);
    const paths = new Set(this.#state.changed_paths);
    operations.forEach((operation) => paths.add(operation.path));
    this.#changed = true;
    await this.#set({ phase: "verify_fast", changed_paths: [...paths], checkpoint_available: this.#checkpoint.available });
    const commands = await (this.#commandsPromise ?? discoverVerificationCommands(this.#workspacePath));
    const command = selectVerificationCommand(commands, "fast");
    if (!command) {
      await this.#set({ phase: "implement" });
      return { prompt: "The patch was applied. No safe fast verification command was discovered; inspect the changed files and continue with focused checks." };
    }
    const verification = await runVerificationCommand(command, run, signal);
    await this.#set({
      phase: verification.passed ? "implement" : this.#nextFailurePhase(),
      last_verification: verification,
    });
    return {
      verification,
      ...(verification.passed ? {} : { prompt: verificationPrompt(verification) }),
    };
  }

  async finishTurn(
    run: (command: string, signal?: AbortSignal, timeoutMs?: number) => Promise<import("../tools/bash.js").BashResult>,
    signal?: AbortSignal,
  ): Promise<WorkflowRunResult> {
    if (!this.#changed || this.#state.phase === "blocked") {
      await this.#set({ phase: this.#state.phase === "blocked" ? "blocked" : "done" });
      return { state: this.state, changed: this.#changed };
    }
    await this.#set({ phase: "verify_full" });
    const commands = await (this.#commandsPromise ?? discoverVerificationCommands(this.#workspacePath));
    const command = selectVerificationCommand(commands, "full");
    if (!command) {
      await this.#set({ phase: "review" });
      await this.#set({ phase: "done" });
      return { state: this.state, changed: true };
    }
    const verification = await runVerificationCommand(command, run, signal);
    if (verification.passed) {
      await this.#set({ phase: "review", last_verification: verification });
      await this.#set({ phase: "done" });
      return { state: this.state, verification, changed: true };
    }
    await this.#set({ phase: this.#nextFailurePhase(), last_verification: verification });
    return { state: this.state, verification, changed: true };
  }

  async undo(): Promise<UndoResult> {
    const result = await this.#checkpoint.undo();
    if (result.status === "undone" || result.status === "conflict") {
      await this.#set({ checkpoint_available: false, changed_paths: this.#state.changed_paths.filter((item) => !result.restored.includes(item)) });
    }
    return result;
  }

  #nextFailurePhase(): "diagnose" | "blocked" {
    const next = this.#state.repair_attempts + 1;
    return next > this.#state.max_repair_attempts ? "blocked" : "diagnose";
  }

  async #set(patch: Partial<WorkflowState>): Promise<void> {
    this.#state = {
      ...this.#state,
      ...patch,
      changed_paths: patch.changed_paths ? [...patch.changed_paths] : [...this.#state.changed_paths],
      repair_attempts: patch.phase === "diagnose" || patch.phase === "blocked"
        ? this.#state.repair_attempts + 1
        : this.#state.repair_attempts,
      updated_at: this.#now(),
    };
    await this.#save();
  }

  async #save(): Promise<void> {
    await this.#onState?.(this.state);
  }
}
