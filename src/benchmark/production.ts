import { join } from "node:path";
import type { RegisteredModel } from "../storage/model-registry.js";
import { SessionStore } from "../storage/session-store.js";
import type { BashOutputPreview } from "../tools/bash.js";
import { SkillCatalog } from "../skills/catalog.js";
import { LearnedMemoryStore } from "../memory/learned-memory.js";
import { CodingTaskRunner } from "../workflow/task-runner.js";
import { CodingWorkflowRuntime } from "../workflow/runtime.js";
import type { PermissionPolicy } from "../permissions/policy.js";
import { cloneTaskProgress, type TaskProgress } from "../workflow/task-progress.js";
import { createProductionAgent, createProductionCommandExecutor, createProductionWorkflowAgentIO } from "../runtime/production.js";
import { createProviderCapabilityProfile } from "./capabilities.js";
import type { BenchmarkHarnessAdapter, BenchmarkHarnessResult } from "./types.js";
import { TeamStore } from "../team/store.js";
import type { TeamOptions } from "../team/types.js";
import { CandidateRepairPolicy } from "./repair-policy.js";

export interface ProductionBenchmarkAdapterOptions {
  name?: string;
  repairStrategy?: "baseline" | "candidate";
  model: RegisteredModel;
  sessionsRoot: string;
  permissionPolicy?: PermissionPolicy;
  loopStrategy?: import("../agent/tool-feedback-policy.js").LoopStrategy;
  team?: TeamOptions;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-");
}

/**
 * Construct the production Agent/workflow/session stack without mounting Ink.
 * The benchmark evaluator remains outside this stack and scores the resulting workspace.
 */
export function createProductionBenchmarkAdapter(options: ProductionBenchmarkAdapterOptions): BenchmarkHarnessAdapter {
  const comparisonSettings = { reasoningEffort: "high" as const, maxOutputTokens: 32_768 };
  return {
    name: options.name ?? "everpeace",
    managesRepairs: true,
    settlesOnCancellation: true,
    async run(task, context): Promise<BenchmarkHarnessResult> {
      if (!context.requestAttemptLedger) throw new Error("Production benchmark requests require a request-attempt ledger");
      const workspacePath = task.workspacePath;
      const policy = options.permissionPolicy ?? { mode: "workspace-write", web: false, shellNetwork: "deny" };
      const skills = new SkillCatalog(workspacePath);
      const sessionStore = new SessionStore({
        directory: join(options.sessionsRoot, safeName(task.id), String(context.attempt)),
      });
      const session = await sessionStore.create({
        title: task.id,
        titlePending: false,
        workspacePath,
        model: {
          id: options.model.id,
          model_name: options.model.model_name,
          base_url: options.model.base_url,
          request_settings: { ...comparisonSettings },
          ...(options.model.responses_profile === undefined ? {} : { responses_profile: options.model.responses_profile }),
        },
      });
      const workflow = new CodingWorkflowRuntime({
        workspacePath,
        onState: (state) => sessionStore.setWorkflow(session.id, state),
      });
      let taskProgress: TaskProgress | undefined;
      const execute = createProductionCommandExecutor({
        workspacePath,
        policy,
        readableRoots: () => skills.readableRoots(),
        onProcessStarted: (durationMs) => context.onEvent({ type: "timing_recorded", operation: "sandbox_startup", durationMs }),
      });
      const timedExecute = (command: string, signal?: AbortSignal, timeoutMs?: number, onOutput?: (output: BashOutputPreview) => void) => {
        return execute(command, signal, timeoutMs, onOutput);
      };
      const io = createProductionWorkflowAgentIO({
        workspacePath,
        policy: () => policy,
        workflow,
        execute: timedExecute,
        session: {
          getId: () => session.id,
          getTaskProgress: () => taskProgress === undefined ? undefined : cloneTaskProgress(taskProgress),
          async setTaskProgress(progress) {
            await sessionStore.setTaskProgress(session.id, progress);
            taskProgress = cloneTaskProgress(progress);
          },
        },
        interaction: {
          // Benchmark permissions are an explicit harness override: shell and
          // patch approvals are granted; networked integrations and Goal
          // mutation remain unavailable.
          async confirm(_kind, tool) { return tool === "bash" || tool === "patch"; },
        },
      });
      const handle = createProductionAgent({
        model: { ...options.model, request_settings: comparisonSettings },
        ...(options.team ? { team: { ...options.team, ...(context.tokenBudgetRemaining === undefined ? {} : { tokenBudget: Math.min(options.team.tokenBudget ?? context.tokenBudgetRemaining, context.tokenBudgetRemaining) }) }, teamStore: new TeamStore(join(options.sessionsRoot, safeName(task.id), String(context.attempt), "teams")) } : {}),
        ...(options.loopStrategy === undefined ? {} : { loopStrategy: options.loopStrategy }),
        workspacePath,
        io,
        sessionStore,
        sessionId: () => session.id,
        requestAttemptLedger: context.requestAttemptLedger,
        skills,
        mcp: null,
        learnedMemoryStore: new LearnedMemoryStore({ directory: join(options.sessionsRoot, safeName(task.id), String(context.attempt), "memory") }),
        learnedMemoryPolicy: { readExisting: false, captureFuture: false },
        restore: {
          onHistoryAppend: (items) => sessionStore.appendContext(session.id, items),
          onContextCompacted: (items, automatic, usage) => sessionStore.compactContext(session.id, items, automatic, usage),
          onContextPruned: (items, metadata) => sessionStore.pruneContext(session.id, items, metadata),
          onUsage: (usage) => sessionStore.appendUsage(session.id, usage),
          onPhase: context.onPhase,
          onEvent: context.onEvent,
        },
      });
      const agent = handle.agent;
      try {
        const repairPolicy = options.repairStrategy === "candidate" ? new CandidateRepairPolicy() : undefined;
        const runner = new CodingTaskRunner({
          agent,
          workflow,
          host: {
            ...(repairPolicy ? { evaluationRepairDecision: (state: import("../workflow/types.js").WorkflowState) => repairPolicy.decision(state) } : {}),
            executeVerification: timedExecute,
            async getGoal() { return undefined; },
            async addGoalTime() { return undefined; },
          },
        });
        const result = await runner.run({ text: task.prompt, source: "benchmark", signal: context.signal });
        const snapshot = handle.team?.snapshot()?.usage ?? context.requestAttemptLedger.snapshot();
        const saved = await sessionStore.load(session.id);
        const team = handle.team?.snapshot();
        return {
          ...(team ? { teamMetrics: { members: team.members.length, duplicateReads: team.diagnostics?.duplicateReads ?? 0, repeatedFailures: team.diagnostics?.repeatedFailures ?? 0, conflicts: team.members.filter((member) => member.state === "conflict").length }, isolationFailed: team.members.some((member) => ["failed", "cancelled"].includes(member.state) && member.errorCode === "SANDBOX_UNAVAILABLE") } : {}),
          manualInterventions: result.agentResult.interactionRequired ? 1 : 0,
          requestAttempts: snapshot.attempts.filter((attempt) => attempt.status !== "rejected").length,
          usage: {
            inputTokens: snapshot.inputTokens, outputTokens: snapshot.outputTokens, reasoningTokens: snapshot.reasoningTokens, complete: snapshot.complete,
            ...(saved.usage.cached_input_tokens === undefined ? {} : { cachedInputTokens: saved.usage.cached_input_tokens }),
            ...(saved.usage.cache_observed_input_tokens === undefined ? {} : { cacheObservedInputTokens: saved.usage.cache_observed_input_tokens }),
          },
          terminalOutcome: result.disposition,
          ...(result.agentResult.stopReason ? { stopReason: result.agentResult.stopReason } : {}),
          ...(result.workflowResult?.state.result ? { workflowOutcome: result.workflowResult.state.result } : {}),
          diagnosticRounds: result.diagnosticRounds,
          ...(result.firstVerificationSuite ? { firstVerificationSuiteStatus: result.firstVerificationSuite.status } : {}),
          capabilities: createProviderCapabilityProfile(options.model.base_url, options.model.model_name, {
            streaming: true,
            nativeCompaction: handle.provider.capabilities.compaction === "native",
            promptCache: handle.provider.capabilities.promptCacheOptions,
          }),
        };
      } finally {
        try { await handle.dispose(); }
        finally {
          const snapshot = handle.team?.snapshot();
          if (snapshot) context.requestAttemptLedger.importSettledAttempts(snapshot.teamId, snapshot.usage.attempts);
        }
      }
    },
  };
}
