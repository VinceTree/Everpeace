import type { AgentTaskOptions, AgentTurnResult } from "../agent/react-agent.js";
import type { LearnedTurnOutcome } from "../memory/learned-memory.js";
import type { AgentMode } from "../plan/runtime.js";
import type { FileAttachment } from "../agent/file-attachments.js";
import type { SessionGoal } from "../storage/session-store.js";
import type { BashResult } from "../tools/bash.js";
import { formatWorkflowSummary, type CodingWorkflowRuntime } from "./runtime.js";
import type { VerificationSuiteResult, WorkflowRunResult, WorkflowTaskSource } from "./types.js";
import { verificationPrompt } from "./verifier.js";

export interface CodingTaskAgent {
  runTurn(userInput: string, signal?: AbortSignal, options?: { mode?: AgentMode; attachments?: readonly FileAttachment[] }): Promise<AgentTurnResult>;
  beginTask?(options: AgentTaskOptions): void | Promise<void>;
  endTask?(): void | Promise<void>;
  waitForBackgroundJobs?(signal?: AbortSignal): Promise<unknown>;
  cancelBackgroundJobs?(reason?: unknown): Promise<unknown>;
  finalizePendingGoalCompletion?(allow: boolean): Promise<void>;
  finishMemoryTurn?(outcome: LearnedTurnOutcome): Promise<void>;
}

export interface CodingTaskRunnerHost {
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
  if (result.stopReason === "budget_limited") return "Goal token budget reached. Work stopped before further tools or model requests.";
  if (result.stopReason === "usage_limited") return "Goal usage could not be measured reliably. Work stopped before further tools or model requests.";
  if (result.stopReason === "step_limit") return "Agent step limit reached. Work stopped without reporting completion.";
  return "Agent turn deadline reached. Work stopped without reporting completion.";
}

/** Shared production coding lifecycle used by interactive and benchmark hosts. */
export class CodingTaskRunner {
  readonly #agent: CodingTaskAgent;
  readonly #workflow: CodingWorkflowRuntime;
  readonly #host: CodingTaskRunnerHost;
  #running = false;

  constructor(options: { agent: CodingTaskAgent; workflow: CodingWorkflowRuntime; host: CodingTaskRunnerHost }) {
    this.#agent = options.agent;
    this.#workflow = options.workflow;
    this.#host = options.host;
  }

  async run(input: CodingTaskRunnerInput): Promise<CodingTaskRunnerResult> {
    if (this.#running) throw new Error("A coding task is already running or cleaning up");
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
        if (taskSource === "session_resume") await this.#workflow.resumeTurn();
        else await this.#workflow.beginTurn({ mode: "default", source: taskSource });
        workflowStarted = true;
      } else if (nextMode === "default" && this.#workflow.state.phase === "diagnose") {
        const repair = await this.#workflow.startRepairTurn();
        if (repair.phase === "blocked") {
          await this.#agent.finalizePendingGoalCompletion?.(false);
          await this.#agent.finishMemoryTurn?.("failed");
          this.#host.onSystemMessage?.("Automatic repair stopped after three diagnostic rounds. Start a new task to authorize more changes.");
          return taskResult("completed", lastAgentResult, lastWorkflowResult);
        }
      }

      const started = now();
      lastAgentResult = await this.#agent.runTurn(nextText, input.signal, {
        mode: nextMode,
        ...(nextAttachments === undefined ? {} : { attachments: nextAttachments }),
      }) ?? {};
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
      lastWorkflowResult = await this.#workflow.finishTurn(this.#host.executeVerification, input.signal);
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
      await Promise.allSettled([
        this.#agent.cancelBackgroundJobs?.(error) ?? Promise.resolve(),
        this.#agent.finalizePendingGoalCompletion?.(false) ?? Promise.resolve(),
        this.#agent.finishMemoryTurn?.(input.signal?.aborted ? "stopped" : "failed") ?? Promise.resolve(),
      ]);
      throw error;
    } finally {
      try {
        await this.#agent.endTask?.();
      } finally {
        this.#running = false;
      }
    }
  }
}
