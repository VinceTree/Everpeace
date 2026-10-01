import { join } from "node:path";
import { ReactAgent, type AgentIO, type ResponseStreamLike, type ResponsesClientLike } from "../agent/react-agent.js";
import { createSessionPromptCacheKey, createProviderRuntime, isOfficialOpenAiBaseUrl, supportsPromptCacheOptions } from "../providers/openai-compatible.js";
import type { RegisteredModel } from "../storage/model-registry.js";
import { SessionStore } from "../storage/session-store.js";
import { DEFAULT_MODEL_BASH_TIMEOUT_MS, runBash, type BashOutputPreview } from "../tools/bash.js";
import { previewApplyPatch, runApplyPatch, type ApplyPatchOperation, type ApplyPatchResult } from "../tools/apply-patch.js";
import { createEffectiveSandboxPolicy } from "../tools/sandbox-policy.js";
import { createCodeNavigationFromEnvironment } from "../tools/code-navigation.js";
import { SkillCatalog } from "../skills/catalog.js";
import { CodingTaskRunner } from "../workflow/task-runner.js";
import { CodingWorkflowRuntime } from "../workflow/runtime.js";
import type { PermissionPolicy } from "../permissions/policy.js";
import { createProviderCapabilityProfile } from "./capabilities.js";
import type { BenchmarkHarnessAdapter, BenchmarkHarnessResult } from "./types.js";

export interface ProductionBenchmarkAdapterOptions {
  model: RegisteredModel;
  sessionsRoot: string;
  permissionPolicy?: PermissionPolicy;
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
    name: "everpeace",
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
        },
      });
      const workflow = new CodingWorkflowRuntime({
        workspacePath,
        onState: (state) => sessionStore.setWorkflow(session.id, state),
      });
      const provider = createProviderRuntime(
        options.model.base_url,
        options.model.api_key,
        comparisonSettings,
        options.model.model_name,
      );
      const client: ResponsesClientLike = {
        responses: {
          create(params, requestOptions) {
            return provider.responses.create(params, requestOptions as never);
          },
          async stream(params, requestOptions) {
            return await provider.responses.stream(params, requestOptions as never) as ResponseStreamLike;
          },
        },
      };
      if (provider.responses.compact) {
        client.responses.compact = (params, requestOptions) => provider.responses.compact!(params, requestOptions as never);
      }
      let navigation;
      try { navigation = createCodeNavigationFromEnvironment(workspacePath); }
      catch { navigation = undefined; }
      const execute = (command: string, signal?: AbortSignal, timeoutMs?: number, onOutput?: (output: BashOutputPreview) => void) => {
        const startup = performance.now();
        return runBash(command, {
          cwd: workspacePath,
          streamOutput: false,
          timeoutMs: timeoutMs ?? DEFAULT_MODEL_BASH_TIMEOUT_MS,
          sandbox: { policy: createEffectiveSandboxPolicy(policy, workspacePath, skills.readableRoots()) },
          onProcessStarted: () => context.onEvent({ type: "timing_recorded", operation: "sandbox_startup", durationMs: performance.now() - startup }),
          ...(signal ? { signal } : {}),
          ...(onOutput ? { onOutput } : {}),
        });
      };
      const io: AgentIO = {
        getSessionId: () => session.id,
        getPermissions: () => ({ ...policy }),
        isToolExecutionBlocked: () => workflow.state.phase === "blocked",
        async confirmBash() { return true; },
        async confirmPatch() { return true; },
        async confirmWeb() { return false; },
        async confirmMcp() { return false; },
        async confirmGoal() { return false; },
        previewPatch(operations) { return previewApplyPatch(operations, workspacePath); },
        async runApplyPatch(operations: readonly ApplyPatchOperation[], signal?: AbortSignal) {
          await workflow.capturePatch(operations);
          signal?.throwIfAborted();
          return runApplyPatch(operations, workspacePath);
        },
        afterPatchApplied(operations: readonly ApplyPatchOperation[], result: ApplyPatchResult, signal?: AbortSignal) {
          return workflow.afterPatch(operations, result, execute, signal);
        },
        async runBash(command, signal) {
          try { return await execute(command, signal); }
          finally { await workflow.observeShellExecution(); }
        },
        async runBackgroundBash(command, signal, timeoutMs, onOutput) {
          try { return await execute(command, signal, timeoutMs, onOutput); }
          finally { await workflow.observeShellExecution(); }
        },
        writeAssistant() {},
        writeAssistantDelta() {},
        writeTool() {},
      };
      const agent = new ReactAgent({
        workspacePath,
        client,
        model: options.model.model_name,
        io,
        parallelReadTools: true,
        providerCapabilities: provider.capabilities,
        requestSettings: provider.settings,
        requestAttemptLedger: context.requestAttemptLedger,
        skills,
        ...(navigation ? { codeNavigation: navigation } : {}),
        ...(isOfficialOpenAiBaseUrl(options.model.base_url) ? {
          promptCacheKey: createSessionPromptCacheKey(session.id),
          ...(supportsPromptCacheOptions(options.model.model_name)
            ? { promptCacheOptions: { mode: "implicit" as const, ttl: "30m" as const } }
            : {}),
        } : {}),
        onHistoryAppend: (items) => sessionStore.appendContext(session.id, items),
        onContextCompacted: (items, automatic, usage) => sessionStore.compactContext(session.id, items, automatic, usage),
        onUsage: (usage) => sessionStore.appendUsage(session.id, usage),
        onPhase: context.onPhase,
        onEvent: context.onEvent,
      });
      try {
        const runner = new CodingTaskRunner({
          agent,
          workflow,
          host: {
            executeVerification: execute,
            async getGoal() { return undefined; },
            async addGoalTime() { return undefined; },
          },
        });
        const result = await runner.run({ text: task.prompt, source: "benchmark", signal: context.signal });
        return {
          terminalOutcome: result.disposition,
          ...(result.agentResult.stopReason ? { stopReason: result.agentResult.stopReason } : {}),
          ...(result.workflowResult?.state.result ? { workflowOutcome: result.workflowResult.state.result } : {}),
          diagnosticRounds: result.diagnosticRounds,
          ...(result.firstVerificationSuite ? { firstVerificationSuiteStatus: result.firstVerificationSuite.status } : {}),
          capabilities: createProviderCapabilityProfile(options.model.base_url, options.model.model_name, {
            streaming: true,
            nativeCompaction: provider.capabilities.compaction === "native",
            promptCache: provider.capabilities.promptCacheOptions,
          }),
        };
      } finally {
        await agent.dispose();
      }
    },
  };
}
