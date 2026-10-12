import type { AgentTaskOptions, AgentTurnResult } from "../agent/react-agent.js";
import type { LearnedTurnOutcome } from "../memory/learned-memory.js";
import type { AgentMode } from "../plan/runtime.js";
import type { FileAttachment } from "../agent/file-attachments.js";
import type { SessionGoal } from "../storage/session-store.js";
import type { BashResult } from "../tools/bash.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { formatWorkflowSummary, type CodingWorkflowRuntime } from "./runtime.js";
import type { VerificationSuiteResult, WorkflowRunResult, WorkflowTaskSource } from "./types.js";
import { verificationPrompt } from "./verifier.js";

export interface CodingTaskAgent {
  recordPerformanceTiming?(operation: string, ms: number): void;
  recordRepairRound?(): void;
  runTurn(userInput: string, signal?: AbortSignal, options?: { mode?: AgentMode; attachments?: readonly FileAttachment[] }): Promise<AgentTurnResult>;
  finishTeamVerification?: ((verified: boolean) => Promise<void>) | undefined;
  prepareTeamVerification?: ((signal?: AbortSignal) => Promise<string | undefined>) | undefined;
  beginTask?(options: AgentTaskOptions): void | Promise<void>;
  endTask?(): void | Promise<void>;
  waitForBackgroundJobs?(signal?: AbortSignal): Promise<unknown>;
  cancelBackgroundJobs?(reason?: unknown): Promise<unknown>;
  finalizePendingGoalCompletion?(allow: boolean): Promise<void>;
  finishMemoryTurn?(outcome: LearnedTurnOutcome): Promise<void>;
}

export interface CodingTaskRunnerHost {
  evaluationRepairDecision?(state: import("./types.js").WorkflowState): string | undefined;
  executeVerification(command: string, signal?: AbortSignal, timeoutMs?: number): Promise<BashResult>;
  getGoal(): Promise<SessionGoal | undefined>;
  addGoalTime(seconds: number): Promise<SessionGoal | undefined>;
  onGoal?(goal: SessionGoal | undefined): void;
  onSystemMessage?(message: string): void;
  onStatus?(status: string | undefined): void;
  resetAssistant?(): void;
  now?: () => number;
}

export interface CodingTaskRunnerInput {
  text: string;
  attachments?: readonly FileAttachment[];
  mode?: AgentMode;
  source?: WorkflowTaskSource;
  signal?: AbortSignal;
}

export interface CodingTaskRunnerResult {
  disposition: "completed" | "stopped" | "plan_approved" | "plan_cancelled";
  agentResult: AgentTurnResult;
  workflowResult?: WorkflowRunResult;
  diagnosticRounds: number;
  firstVerificationSuite?: VerificationSuiteResult;
}

const continuationPrompt = "Continue working toward the active session goal. Call get_goal, make concrete progress, verify the result, and update the goal when complete or genuinely blocked.";

function stoppedMessage(result: AgentTurnResult): string {
  if (result.stopReason === "budget_limited") return "Request token budget reached. Work stopped before further tools or model requests; in-flight billing is not a hard spending cap.";
  if (result.stopReason === "usage_limited") return [result.requestFailure, "Goal usage could not be measured reliably. Work stopped before further tools or model requests."].filter(Boolean).join(" ");
  if (result.stopReason === "step_limit") return "Agent step limit reached. Work stopped without reporting completion.";
  return "Agent turn deadline reached. Work stopped without reporting completion.";
}

/** Shared production coding lifecycle used by interactive and benchmark hosts. */
export class CodingTaskRunner {
  readonly #agent: CodingTaskAgent;
  readonly #workflow: CodingWorkflowRuntime;
  readonly #host: CodingTaskRunnerHost;
  #running = false;
  #cleanupFailure: ResourceCleanupError | undefined;

  constructor(options: { agent: CodingTaskAgent; workflow: CodingWorkflowRuntime; host: CodingTaskRunnerHost }) {
    this.#agent = options.agent;
    this.#workflow = options.workflow;
    this.#host = options.host;
  }

  async run(input: CodingTaskRunnerInput): Promise<CodingTaskRunnerResult> {
    if (this.#host.evaluationRepairDecision && input.source !== "benchmark") throw new Error("Experimental repair decisions require the benchmark entry point");
    if (this.#running) throw new Error("A coding task is already running or cleaning up");
    if (this.#cleanupFailure) throw this.#cleanupFailure;
    this.#running = true;
    let nextText = input.text;
    let nextMode = input.mode ?? "default";
    let nextAttachments = input.attachments;
    let taskSource = input.source ?? "user";
    let workflowStarted = false;
    let lastAgentResult: AgentTurnResult = {};
    let lastWorkflowResult: WorkflowRunResult | undefined;
    let firstVerificationSuite: VerificationSuiteResult | undefined;
    const now = this.#host.now ?? Date.now;
    const taskResult = (
      disposition: CodingTaskRunnerResult["disposition"],
      agentResult: AgentTurnResult,
      workflowResult?: WorkflowRunResult,
    ): CodingTaskRunnerResult => ({
      disposition,
      agentResult,
      diagnosticRounds: workflowResult?.state.repair_attempts ?? this.#workflow.state.repair_attempts,
      ...(workflowResult === undefined ? {} : { workflowResult }),
      ...(firstVerificationSuite === undefined ? {} : { firstVerificationSuite }),
    });

    try {
      await this.#agent.beginTask?.({ mode: nextMode, source: taskSource });
      while (true) {
      input.signal?.throwIfAborted();
      if (nextMode === "default" && !workflowStarted) {
        if (taskSource === "session_resume") await this.#workflow.resumeTurn(input.signal);
        else await this.#workflow.beginTurn({ mode: "default", source: taskSource, ...(input.signal ? { signal: input.signal } : {}) });
        workflowStarted = true;
      } else if (nextMode === "default" && this.#workflow.state.phase === "diagnose") {
        const evaluationStop = this.#host.evaluationRepairDecision?.(this.#workflow.state);
        if (evaluationStop) {
          await this.#workflow.stopEvaluationRepairs(evaluationStop);
          await this.#agent.finalizePendingGoalCompletion?.(false); await this.#agent.finishMemoryTurn?.("failed");
          this.#host.onSystemMessage?.(evaluationStop);
          return taskResult("completed", lastAgentResult, { ...lastWorkflowResult, state: this.#workflow.state, changed: true });
        }
        const repair = await this.#workflow.startRepairTurn();
        if (repair.phase !== "blocked") this.#agent.recordRepairRound?.();
        if (repair.phase === "blocked") {
          await this.#agent.finalizePendingGoalCompletion?.(false);
          await this.#agent.finishMemoryTurn?.("failed");
          this.#host.onSystemMessage?.("Automatic repair stopped after three diagnostic rounds. Start a new task to authorize more changes.");
          return taskResult("completed", lastAgentResult, lastWorkflowResult);
        }
      }

      const started = now();
      const repairStarted = this.#workflow.state.repair_attempts > 0 && this.#workflow.state.phase === "implement" ? performance.now() : undefined;
      try {
        lastAgentResult = await this.#agent.runTurn(nextText, input.signal, {
          mode: nextMode,
          ...(nextAttachments === undefined ? {} : { attachments: nextAttachments }),
        }) ?? {};
      } finally {
        if (repairStarted !== undefined) this.#agent.recordPerformanceTiming?.("repair", performance.now() - repairStarted);
      }
      nextAttachments = undefined;
      input.signal?.throwIfAborted();
      if (lastAgentResult.interactionRequired) {
        await this.#agent.cancelBackgroundJobs?.(new Error("Task stopped for host interaction"));
        await this.#agent.finalizePendingGoalCompletion?.(false);
        await this.#agent.finishMemoryTurn?.("stopped");
        this.#host.resetAssistant?.();
        this.#host.onSystemMessage?.(`Host interaction is required for ${lastAgentResult.interactionRequired.tool}.`);
        return taskResult("stopped", lastAgentResult, lastWorkflowResult);
      }
      if (lastAgentResult.stopReason) {
        await this.#agent.cancelBackgroundJobs?.(new Error(`Task stopped: ${lastAgentResult.stopReason}`));
        await this.#agent.finalizePendingGoalCompletion?.(false);
        await this.#agent.finishMemoryTurn?.("stopped");
        this.#host.resetAssistant?.();
        const goal = await this.#host.getGoal();
        this.#host.onGoal?.(goal);
        this.#host.onSystemMessage?.(stoppedMessage(lastAgentResult));
        return taskResult("stopped", lastAgentResult, lastWorkflowResult);
      }
      if (lastAgentResult.planDecision === "approve") return taskResult("plan_approved", lastAgentResult);
      if (lastAgentResult.planDecision === "cancel") return taskResult("plan_cancelled", lastAgentResult);
      if (nextMode === "plan") return taskResult("completed", lastAgentResult);

      if (this.#agent.waitForBackgroundJobs) {
        this.#host.onStatus?.("Waiting for background commands before final verification");
        await this.#agent.waitForBackgroundJobs(input.signal);
      }
      if (this.#agent.prepareTeamVerification) {
        const teamPrompt = await this.#agent.prepareTeamVerification(input.signal);
        if (teamPrompt) { nextText = teamPrompt; nextMode = "default"; this.#host.resetAssistant?.(); continue; }
      }
      const verificationStarted = performance.now();
      try { lastWorkflowResult = await this.#workflow.finishTurn(this.#host.executeVerification, input.signal); }
      finally { this.#agent.recordPerformanceTiming?.("verification", performance.now() - verificationStarted); }
      firstVerificationSuite ??= lastWorkflowResult.verificationSuite;
      input.signal?.throwIfAborted();
      if (lastWorkflowResult.prompt && this.#workflow.state.phase === "diagnose") {
        await this.#agent.finishMemoryTurn?.("failed");
        nextText = lastWorkflowResult.prompt;
        nextMode = "default";
        this.#host.resetAssistant?.();
        this.#host.onStatus?.("Diagnosing workflow review");
        continue;
      }
      if (lastWorkflowResult.verification && !lastWorkflowResult.verification.passed && this.#workflow.state.phase === "diagnose") {
        await this.#agent.finishMemoryTurn?.("failed");
        nextText = verificationPrompt(lastWorkflowResult.verification);
        nextMode = "default";
        this.#host.resetAssistant?.();
        this.#host.onStatus?.(`Diagnosing ${lastWorkflowResult.verification.command.label}`);
        continue;
      }

      const outcome = lastWorkflowResult.state.result;
      input.signal?.throwIfAborted();
      if (this.#agent.finishTeamVerification) await this.#agent.finishTeamVerification(outcome === "verified");
      await this.#agent.finalizePendingGoalCompletion?.(outcome === "verified" || outcome === "no_changes");
      input.signal?.throwIfAborted();
      await this.#agent.finishMemoryTurn?.(
        outcome === "verified" ? "verified" : outcome === "failed" ? "failed" : "unverified",
      );
      const summary = formatWorkflowSummary(lastWorkflowResult);
      if (summary) this.#host.onSystemMessage?.(summary);
      let goal = await this.#host.addGoalTime(Math.max(0, now() - started) / 1000);
      this.#host.onGoal?.(goal);
      if (goal?.status !== "active") return taskResult("completed", lastAgentResult, lastWorkflowResult);
      if (lastWorkflowResult.state.phase === "blocked" || outcome === "unverified") {
        this.#host.onSystemMessage?.(lastWorkflowResult.state.phase === "blocked"
          ? "Automatic repair stopped after the workflow repair limit. The active goal was not marked complete."
          : "Automatic goal continuation stopped because the coding changes could not be fully verified.");
        return taskResult("completed", lastAgentResult, lastWorkflowResult);
      }
      nextText = continuationPrompt;
      nextMode = "default";
      taskSource = "goal_continuation";
      workflowStarted = false;
      this.#host.resetAssistant?.();
      this.#host.onStatus?.("Continuing active goal");
      }
    } catch (error) {
      const [cleanup] = await Promise.allSettled([
        Promise.resolve().then(() => this.#agent.cancelBackgroundJobs?.(error)),
      ]);
      const failure = error instanceof ResourceCleanupError ? error
        : cleanup?.status === "rejected" && cleanup.reason instanceof ResourceCleanupError ? cleanup.reason
          : error;
      if (failure instanceof ResourceCleanupError) this.#cleanupFailure ??= failure;
      await Promise.allSettled([
        ...(failure instanceof ResourceCleanupError
          ? [Promise.resolve().then(() => this.#workflow.recordCleanupFailure?.(failure))]
          : []),
        this.#agent.finalizePendingGoalCompletion?.(false) ?? Promise.resolve(),
        this.#agent.finishMemoryTurn?.(failure instanceof ResourceCleanupError || !input.signal?.aborted ? "failed" : "stopped") ?? Promise.resolve(),
      ]);
      throw failure;
    } finally {
      try {
        await this.#agent.endTask?.();
      } catch (error) {
        // oxlint-disable-next-line no-unsafe-finally -- Cleanup failure must override a pending result; unfinished resources cannot settle successfully.
        throw this.#cleanupFailure ?? error;
      } finally {
        this.#running = false;
      }
    }
  }
}
