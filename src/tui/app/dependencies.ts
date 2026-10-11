import { loadTeamWorkspace, removeTeamWorkspace } from "../../team/workspace.js";
import { TeamConfigStore, TeamStore } from "../../team/store.js";
import type { TeamRuntime } from "../../team/runtime.js";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentIO } from "../../agent/react-agent.js";
import {
  createProviderClient,
  createProviderRuntime,
  disposeProviderClient,
  listOfficialModelIds,
} from "../../providers/openai-compatible.js";
import type { RegisteredModel } from "../../storage/model-registry.js";
import { SessionStore } from "../../storage/session-store.js";
import { InputHistory } from "../../storage/input-history.js";
import { runBash } from "../../tools/bash.js";
import { createEffectiveSandboxPolicy } from "../../tools/sandbox-policy.js";
import { runTerminalCommand } from "../../tools/terminal.js";
import type { TuiDependencies, TuiModelRegistry } from "./types.js";
import { truncateEnd } from "../rendering/text-width.js";
import { SearchSettingsStore } from "../../tools/search-provider.js";
import { DiagnosticStore, diagnosticFreshness, runLiveDiagnostics } from "../../providers/doctor.js";
import { CostSettingsStore, CostWarningTracker, summarizeCosts, type RequestCostContext } from "../../status/cost.js";
import {
  defaultPermissions,
  loadPermissionPolicy,
  permissionPolicyRevision,
  savePermissionPolicy,
  type PermissionPolicy,
} from "../../permissions/policy.js";
import { McpRuntime, formatMcpStatus } from "../../mcp/runtime.js";
import { SkillCatalog, formatSkillsStatus } from "../../skills/catalog.js";
import {
  SkillManager,
  normalizeGeneratedSkillMarkdown,
  validateManagedSkillMarkdown,
} from "../../skills/manager.js";
import {
  LearnedMemoryRuntime,
  LearnedMemoryStore,
} from "../../memory/learned-memory.js";
import { resolveCodexCliPath } from "../../codex/cli.js";
import { modelErrorGuidance } from "../../agent/response-errors.js";
import { RequestAttemptLedger } from "../../agent/request-attempt-ledger.js";
import { AuxiliaryRequestExecutor } from "../../agent/auxiliary-request-executor.js";
import { createCodeNavigationFromEnvironment, LanguageServerIsolationError } from "../../tools/code-navigation.js";
import { resolveBundledRipgrep } from "../../tools/ripgrep.js";
import {
  assertCompletedModelResponse,
  defaultModelRequestSettings,
  requestReasoningEffort,
  requestSettingsForPurpose,
  resolveProviderCapabilities,
  type ModelRequestPurpose,
} from "../../providers/capabilities.js";
import {
  createProductionAgent,
  createProductionCommandExecutor,
} from "../../runtime/production.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const packageJson = require("../../../package.json") as { version?: unknown };

function packageVersion(): string {
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

function purposeRequest(model: RegisteredModel, purpose: ModelRequestPurpose): { max_output_tokens: number; reasoning?: { effort: string }; timeoutMs: number } {
  const capabilities = resolveProviderCapabilities(model.base_url, model.model_name, model.responses_profile);
  const coding = defaultModelRequestSettings(capabilities, model.request_settings);
  const settings = requestSettingsForPurpose(purpose, coding);
  const effort = requestReasoningEffort(capabilities, settings.reasoningEffort);
  return { max_output_tokens: settings.maxOutputTokens, ...(effort ? { reasoning: { effort } } : {}), timeoutMs: settings.timeoutMs };
}

async function requestSkillDraft(
  model: RegisteredModel,
  instructions: string,
  input: string,
  execute: <T extends { usage?: unknown; status?: unknown }>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): Promise<string> {
  const runtime = createProviderRuntime(model.base_url, model.api_key, model.request_settings, model.model_name, model.responses_profile);
  try {
    const request = purposeRequest(model, "skill");
    const response = await execute((requestSignal) => runtime.responses.create(
      {
        model: model.model_name,
        instructions,
        input,
        store: false,
        max_output_tokens: request.max_output_tokens,
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      },
      { signal: requestSignal, timeout: request.timeoutMs, maxRetries: 0 },
    ));
    assertCompletedModelResponse(response, "skill");
    const draft = normalizeGeneratedSkillMarkdown(response.output_text);
    validateManagedSkillMarkdown(draft);
    return draft;
  } finally { await runtime.dispose?.(); }
}

export function sanitizeSessionTitle(value: string): string {
  const line = value
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean) ?? "";
  const cleaned = line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^[`*_]+|[`*_]+$/g, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/[。.!！?？:：;；]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateEnd(cleaned, 60);
}

export function createDefaultTuiDependencies(
  registry: TuiModelRegistry,
): TuiDependencies {
  const sessionStore = new SessionStore();
  const teamConfig = new TeamConfigStore();
  const teamStore = new TeamStore();
  let teamModels: RegisteredModel[] = [];
  let activeTeam: TeamRuntime | undefined;
  const version = packageVersion();
  const webSettings = new SearchSettingsStore();
  const costSettings = new CostSettingsStore();
  const costTracker = new CostWarningTracker();
  let activeLedger: RequestAttemptLedger | undefined;
  let costSessionId: () => string | undefined = () => undefined;
  let auxiliaryCostEvent: ((estimate: import("../../status/cost.js").CostEstimate) => void) | undefined;
  const auxiliaryCosts: import("../../status/cost.js").CostEstimate[] = [];
  const costContext = (model: RegisteredModel): RequestCostContext => {
    const id = costSessionId(), onEstimate = auxiliaryCostEvent;
    return { modelId: model.id, price: () => costSettings.price(model.id), tracker: costTracker, async settled(estimate) { auxiliaryCosts.push(estimate); if (id) await sessionStore.appendCost(id, estimate); onEstimate?.(estimate); } };
  };
  const skills = new SkillCatalog(process.cwd());
  const skillManager = new SkillManager({ workspacePath: process.cwd(), catalog: skills });
  const mcp = new McpRuntime({ workspacePath: process.cwd(), version });
  const learnedMemoryStore = new LearnedMemoryStore();
  const auxiliaryExecutor = new AuxiliaryRequestExecutor();
  let activeLearnedMemory: LearnedMemoryRuntime | undefined;
  const manualMemoryControllers = new Set<AbortController>();
  const memoryOperations = new Set<Promise<unknown>>();
  const memoryFailures = new Set<unknown>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const cancelManualMemory = (reason: Error) => {
    for (const controller of manualMemoryControllers) controller.abort(reason);
  };
  const trackMemoryDisposal = (operation: Promise<void>) => {
    const observed = operation.catch((error: unknown) => { memoryFailures.add(error); throw error; });
    memoryOperations.add(observed);
    return observed.finally(() => memoryOperations.delete(observed));
  };
  const runAuxiliary = async <T extends { usage?: unknown; status?: unknown }>(
    purpose: "title" | "skill" | "memory" | "doctor",
    run: (signal: AbortSignal) => Promise<T>,
    scopeSignal?: AbortSignal,
    signal = scopeSignal,
    model?: RegisteredModel,
  ): Promise<T> => {
    return auxiliaryExecutor.execute(purpose, run, scopeSignal, signal, undefined, model ? costContext(model) : undefined);
  };
  return {
    configureWeb: (provider, key) => webSettings.configure(provider, key),
    configureCost: (modelId, price) => costSettings.configure(modelId, price),
    async getCostStatus(modelId) {
      const pricing = await costSettings.price(modelId);
      const id = costSessionId();
      const records = id ? (await sessionStore.load(id)).costs ?? [] : auxiliaryCosts;
      const summary = summarizeCosts(records);
      const accounting = activeLedger?.snapshot();
      return [`Active model pricing: ${pricing ? JSON.stringify(pricing) + " per million tokens" : "not configured"}`, `Request token budget: ${accounting?.tokenBudget ?? "no ledger limit (Goal may impose admission limits)"}; known task consumption: ${accounting ? accounting.inputTokens + accounting.outputTokens : "unknown"}; in-flight requests: ${activeLedger?.openRequests ?? "unknown"}; metering: ${accounting ? accounting.complete ? "complete so far" : "incomplete" : "unknown"}`, `Recorded request estimates: ${summary.requests}; unknown/partial usage or price: ${summary.unknownRequests}`, ...summary.currencies.map((entry) => `${entry.currency}: ${entry.knownAmount.toFixed(6)} estimated ${entry.partial ? "(partial)" : ""}`), "Older sessions may lack request price snapshots; absent estimates are unknown, never zero."].join("\n");
    },
    registry,
    version,
    workspacePath: process.cwd(),
    sessionStore,
    inputHistory: new InputHistory(),
    getAuxiliaryUsage: () => auxiliaryExecutor.getUsage(),
    skillManager,
    async listModels(baseUrl, apiKey, signal) {
      const client = createProviderClient(baseUrl, apiKey);
      try { return await listOfficialModelIds(client, signal); }
      finally { await disposeProviderClient(client); }
    },
    createAgent(model: RegisteredModel, io: AgentIO, restore) {
      costSessionId = () => io.getSessionId?.();
      auxiliaryCostEvent = (estimate) => restore?.onEvent?.({ type: "cost_estimated", estimate });
      activeLedger = new RequestAttemptLedger();
      if (disposed) throw new Error("TUI services have been disposed");
      cancelManualMemory(new Error("Active model changed"));
      let codeNavigation;
      try {
        codeNavigation = createCodeNavigationFromEnvironment(process.cwd(), {
          permissionRevision: () => permissionPolicyRevision(io.getPermissions?.() ?? defaultPermissions()),
        });
      }
      catch { codeNavigation = undefined; }
      const handle = createProductionAgent({
        model,
        costSettingsStore: costSettings,
        costWarningTracker: costTracker,
        ...(restore?.team ? { team: restore.team, teamModels, teamStore, onTeamEvent: async (event) => { if (event.type === "agent_updated" || event.type === "agent_integrated") io.writeTool?.(`[Team ${event.agentId.slice(0, 8)}] ${event.role ?? "member"} · ${event.state ?? "updated"} · ${event.modelId ?? ""}`); } } : {}),
        workspacePath: process.cwd(),
        io,
        sessionStore,
        sessionId: () => io.getSessionId?.(),
        version,
        skills,
        mcp,
        learnedMemoryStore,
        memoryIdleDelayMs: 5 * 60 * 1000,
        memoryMinTranscriptChars: 200,
        runMemoryRequest: (run, context) => auxiliaryExecutor.execute("memory", (signal) => run(signal), context.signal, context.signal, context, costContext(model)),
        requestAttemptLedger: activeLedger,
        ...(codeNavigation ? { codeNavigation } : {}),
        restore: {
          ...(restore?.initialContext === undefined ? {} : { initialHistory: restore.initialContext }),
          ...(restore?.initialTaskProgress === undefined ? {} : { initialTaskProgress: restore.initialTaskProgress }),
          ...(restore?.contextWindow === undefined ? {} : { contextWindow: restore.contextWindow }),
          ...(restore?.initialContextTokens === undefined ? {} : { initialContextTokens: restore.initialContextTokens }),
          ...(restore?.onContextAppend === undefined ? {} : { onHistoryAppend: restore.onContextAppend }),
          ...(restore?.onContextCompacted === undefined ? {} : { onContextCompacted: restore.onContextCompacted }),
          ...(restore?.onContextPruned === undefined ? {} : { onContextPruned: restore.onContextPruned }),
          ...(restore?.onUsage === undefined ? {} : { onUsage: restore.onUsage }),
          ...(restore?.onMemberUsage === undefined ? {} : { onMemberUsage: restore.onMemberUsage }),
          ...(restore?.onPhase === undefined ? {} : { onPhase: restore.onPhase }),
          ...(restore?.onEvent === undefined ? {} : { onEvent: restore.onEvent }),
        },
      });
      activeTeam = handle.team;
      if (activeLearnedMemory) void trackMemoryDisposal(activeLearnedMemory.dispose()).catch(() => undefined);
      activeLearnedMemory = handle.learnedMemory as LearnedMemoryRuntime | undefined;
      return handle.agent;
    },
    async getMemoryStatus(workspacePath) {
      return activeLearnedMemory?.status(workspacePath) ?? learnedMemoryStore.status(workspacePath);
    },
    async getMemoryPrompt(_workspacePath) {
      const snapshot = activeLearnedMemory?.getSnapshot();
      return snapshot
        ? `Snapshot ${snapshot.revision} loaded ${snapshot.loadedAt}\n\n${snapshot.text || "No learned experience was injected."}`
        : "No memory snapshot has been injected in this agent session yet.";
    },
    async setMemoryEnabled(enabled) {
      if (!enabled) cancelManualMemory(new Error("Memory disabled"));
      await (activeLearnedMemory?.setEnabled(enabled) ?? learnedMemoryStore.setEnabled(enabled));
    },
    async clearMemory(scope, workspacePath) {
      cancelManualMemory(new Error("Memory cleared"));
      await (activeLearnedMemory?.clear(scope, workspacePath) ?? learnedMemoryStore.clear(scope, workspacePath));
    },
    async archiveMemory(scope, workspacePath, id) {
      cancelManualMemory(new Error("Memory entry archived"));
      await (activeLearnedMemory?.archive(scope, workspacePath, id) ?? learnedMemoryStore.updateEntry(scope, workspacePath, id, { status: "archived" }));
    },
    async deleteMemoryEntry(scope, workspacePath, id) {
      cancelManualMemory(new Error("Memory entry deleted"));
      await (activeLearnedMemory?.deleteEntry(scope, workspacePath, id) ?? learnedMemoryStore.deleteEntry(scope, workspacePath, id));
    },
    async rememberMemory(model, workspacePath, text, signal) {
      if (disposed) throw new Error("TUI services have been disposed");
      if (memoryFailures.size > 0) throw memoryFailures.values().next().value;
      signal?.throwIfAborted();
      const controller = new AbortController();
      const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const providerRuntime = createProviderRuntime(model.base_url, model.api_key, model.request_settings, model.model_name, model.responses_profile);
      const memoryRuntime = new LearnedMemoryRuntime({
        store: learnedMemoryStore,
        client: {
          responses: {
            create(params, options) {
              return providerRuntime.responses.create(params, { ...options });
            },
          },
        },
        model: model.model_name,
        policy: { captureFuture: false },
        runRequest: (run, context) => auxiliaryExecutor.execute("memory", (signal) => run(signal), context.signal, context.signal, context, costContext(model)),
      });
      manualMemoryControllers.add(controller);
      const operation = (async () => {
        await Promise.resolve();
        try { await memoryRuntime.remember(workspacePath, text, ownedSignal); }
        finally {
          try { await trackMemoryDisposal(memoryRuntime.dispose()); }
          finally { await providerRuntime.dispose?.(); }
        }
      })();
      memoryOperations.add(operation);
      try { await operation; }
      finally { manualMemoryControllers.delete(controller); memoryOperations.delete(operation); }
    },
    async generateSessionTitle(model, firstQuestion, signal) {
      const runtime = createProviderRuntime(model.base_url, model.api_key, model.request_settings, model.model_name, model.responses_profile);
      try {
        const request = purposeRequest(model, "title");
        const response = await runAuxiliary("title", (requestSignal) => runtime.responses.create(
          {
            model: model.model_name,
            instructions:
              "Summarize the user's request as one concise session title. " +
              "Use the same language as the request. Return only the title, " +
              "without Markdown, quotation marks, or ending punctuation.",
            input: firstQuestion,
            store: false,
            max_output_tokens: request.max_output_tokens,
            ...(request.reasoning ? { reasoning: request.reasoning } : {}),
          },
          { signal: requestSignal, timeout: request.timeoutMs, maxRetries: 0 },
        ), undefined, signal, model);
        assertCompletedModelResponse(response, "title");
        const title = sanitizeSessionTitle(response.output_text);
        if (!title) throw new Error("The model returned an empty session title");
        return title;
      } finally { await runtime.dispose?.(); }
    },
    async doctor(model, policy, live, signal) {
      const sandbox = createEffectiveSandboxPolicy(policy, process.cwd(), skills.readableRoots());
      const lines = [
        `Node: ${process.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Shell: ${process.platform === "win32" ? "PowerShell" : "Bash"}`,
        `Workspace: ${process.cwd()}`,
        `Sandbox backend: ${sandbox.backend}`,
        `Sandbox profile: ${sandbox.permissionProfile}`,
        `Shell network: ${sandbox.networkMode}`,
      ];
      try {
        await fs.access(resolveCodexCliPath());
        lines.push("Sandbox executable: discovered");
      } catch (error) {
        lines.push(`Sandbox executable: unavailable (${error instanceof Error ? error.message : String(error)})`);
      }
      try {
        await execFileAsync("git", ["--version"], { timeout: 5_000, windowsHide: true });
        lines.push("git: probe passed");
      } catch (error) {
        lines.push(`git: unavailable (${error instanceof Error ? error.message : String(error)})`);
      }
      try {
        const ripgrep = await resolveBundledRipgrep();
        await execFileAsync(ripgrep, ["--no-config", "--version"], { timeout: 5_000, windowsHide: true });
        lines.push("ripgrep: bundled probe passed");
      } catch (error) {
        lines.push(`ripgrep: unavailable (${error instanceof Error ? error.message : String(error)})`);
      }
      try {
        const navigation = createCodeNavigationFromEnvironment(process.cwd());
        if (!navigation) {
          lines.push("TypeScript navigation: unavailable (set EVERPEACE_TYPESCRIPT_LSP)");
        } else {
          const command = process.env.EVERPEACE_TYPESCRIPT_LSP!.trim();
          if (path.isAbsolute(command)) await fs.access(command);
          else await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [command], { timeout: 5_000, windowsHide: true });
          await navigation.probeIsolation(signal);
          const evidence = navigation.getIsolationEvidence();
          lines.push(`TypeScript navigation: configured (${navigation.describe()}); native isolation probe ${evidence?.outcome ?? "inconclusive"}`);
          if (evidence) lines.push(`TypeScript navigation probe: control=${evidence.positiveControl}; transport=${evidence.transport}; target=${evidence.target}; reason=${evidence.reason}`);
          lines.push("TypeScript navigation boundary: native read-only policy; networking evidence applies only to the tested TCP/IPv4 target; native platform ambient reads and temp grants still apply");
        }
      } catch (error) {
        lines.push(`TypeScript navigation: unavailable (${error instanceof Error ? error.message : String(error)})`);
        if (error instanceof LanguageServerIsolationError) {
          const evidence = error.evidence;
          lines.push(`TypeScript navigation probe: outcome=${evidence.outcome}; control=${evidence.positiveControl}; transport=${evidence.transport}; target=${evidence.target}; reason=${evidence.reason}`);
          lines.push("TypeScript navigation: fixed native backend; probe evidence covers only the tested TCP/IPv4 target");
        }
      }
      try {
        const probe = await runBash(process.platform === "win32" ? "Write-Output everpeace-doctor" : "printf everpeace-doctor", {
          cwd: process.cwd(),
          streamOutput: false,
          timeoutMs: 10_000,
          sandbox: { policy: sandbox },
          ...(signal ? { signal } : {}),
        });
        lines.push(probe.exitCode === 0 && probe.stdout.includes("everpeace-doctor")
          ? "Sandbox execution: probe passed"
          : `Sandbox execution: probe failed (${probe.error ?? (probe.stderr.trim() || `exit ${probe.exitCode}`)})`);
      } catch (error) {
        lines.push(`Sandbox execution: probe failed (${error instanceof Error ? error.message : String(error)})`);
      }
      const snapshot = activeTeam?.snapshot();
      lines.push(`Collaboration: ${(await teamConfig.load()).enabled ? "configured" : "off"}`);
      if (snapshot) {
        lines.push(`Team accounting: ${snapshot.usage.complete ? "complete" : snapshot.openRequests ? "in flight" : "usage incomplete"}`);
        lines.push(`Team verification: ${snapshot.state === "finished" ? "root checks passed" : "not settled"}`);
      }
      if (!live) {
        lines.push("Model request: not run (use /doctor --live)");
        if (model) {
          const reports = await new DiagnosticStore().read();
          const report = [...reports.reports].reverse().find((entry) => entry.model === model.model_name && entry.endpoint === new URL(model.base_url).origin + new URL(model.base_url).pathname);
          if (report) lines.push(`Previous capability evidence: ${diagnosticFreshness(report, model)} (${report.testedAt})`, ...Object.entries(report.stages).map(([stage, result]) => `${stage}: ${result.state} · ${result.detail}`));
        }
        return lines.join("\n");
      }
      if (!model) {
        lines.push("Model request: unavailable (select a model first)");
        return lines.join("\n");
      }
      const runtime = createProviderRuntime(model.base_url, model.api_key, model.request_settings, model.model_name, model.responses_profile);
      try {
        const result = await runLiveDiagnostics(model, runtime, { ...(signal ? { signal } : {}), observe: (run, requestSignal) => runAuxiliary("doctor", run, undefined, requestSignal, model) });
        await new DiagnosticStore().save(result);
        lines.push(`Diagnostic requests: ${result.requests}/8; request token budget: 20000; known usage: ${result.inputTokens + result.outputTokens}; metering: ${result.usageComplete ? "complete" : "incomplete"}`);
        lines.push(...Object.entries(result.stages).map(([stage, evidence]) => `${stage}: ${evidence.state} · ${evidence.detail}`));
      } catch (error) {
        lines.push(`Model request: failed\n${modelErrorGuidance(error)}`);
      } finally { await runtime.dispose?.(); }
      return lines.join("\n");
    },
    async changeWorkspace(workspacePath) {
      const stats = await fs.stat(workspacePath);
      if (!stats.isDirectory()) throw new Error(`Session workspace is not a directory: ${workspacePath}`);
      process.chdir(workspacePath);
      skills.setWorkspace(process.cwd());
      skillManager.setWorkspace(process.cwd());
      await mcp.setWorkspace(process.cwd());
      return process.cwd();
    },
    loadPermissions(workspacePath) {
      return loadPermissionPolicy(workspacePath);
    },
    savePermissions(workspacePath, policy, scope = "user") {
      return savePermissionPolicy(policy, workspacePath, { scope });
    },
    runBash(command, policy: PermissionPolicy, signal, onOutput, timeoutMs) {
      const cwd = process.cwd();
      return createProductionCommandExecutor({
        workspacePath: cwd,
        policy,
        readableRoots: () => skills.readableRoots(),
      })(command, signal, timeoutMs, onOutput);
    },
    async getTeamConfig() { const config = await teamConfig.load(); teamModels = (await registry.resolveAll()).available; return config; },
    async configureTeam(config) { teamModels = (await registry.resolveAll()).available; for (const id of Object.values(config.models ?? {})) if (!teamModels.some((model) => model.id === id)) throw new Error("Team model registration/credential is unavailable"); await teamConfig.save(config); },
    getTeamSnapshot: () => activeTeam?.snapshot(),
    async inspectTeam(sessionId, teamId) { const loaded = await sessionStore.load(sessionId); const id = teamId ?? loaded.summary.team?.teamId; return id ? teamStore.load(id, loaded.summary.workspace_path, sessionId) : undefined; },
    async manageTeam(action, id, sessionId, teamId) {
      const live = activeTeam?.snapshot();
      if (live && live.rootSessionId === sessionId && (!teamId || live.teamId === teamId)) { if (action === "cleanup") await activeTeam!.cleanupMember(id); else await activeTeam!.cancelMember(id); return; }
      if (!sessionId) throw new Error("No Session owns this team artifact");
      const loaded = await sessionStore.load(sessionId);
      const selectedTeam = teamId ?? loaded.summary.team?.teamId;
      if (!selectedTeam) throw new Error("No team is recorded in this Session");
      const snapshot = await teamStore.load(selectedTeam, loaded.summary.workspace_path, sessionId);
      const member = snapshot.members.find((record) => record.agentId === id);
      if (!member) throw new Error("Unknown team member");
      const release = await teamStore.claim(snapshot.teamId);
      try {
        if (action === "cleanup" && member.workspacePath) { await removeTeamWorkspace(await loadTeamWorkspace(member.workspacePath, snapshot.workspacePath, true)); delete member.workspacePath; }
        if (action === "cancel" || member.state === "interrupted") member.state = "cancelled";
        await teamStore.save(snapshot);
      } finally { await release(); }
    },
    async reconnectMcp() { await mcp.refresh(); },
    previewMcpTrust: (name, signal) => mcp.previewTrust(name, signal),
    approveMcpTrust: (preview, signal) => mcp.approveTrust(preview, signal),
    revokeMcpTrust: (name) => mcp.revokeTrust(name),
    async getMcpStatus() {
      return formatMcpStatus(await mcp.ensureReady()) + "\n\n/mcp trust <server> · Review startup approval\n/mcp revoke <server> · Revoke startup approval\n/mcp reconnect · Reload configuration";
    },
    async getSkillsStatus() {
      return formatSkillsStatus(await skills.refresh());
    },
    generateSkillDraft(model, description, signal) {
      return requestSkillDraft(
        model,
        "Create one concise Codex SKILL.md for the requested workflow. Return only the complete SKILL.md, without a Markdown code fence or commentary. It must begin with YAML frontmatter containing a lowercase hyphenated name (maximum 64 characters) and a discriminating description that states what the skill does and when it applies. The body should contain only task-specific workflow, non-obvious constraints, and useful decision criteria. Do not create or refer to extra files, scripts, assets, or placeholders.",
        description,
        (run) => runAuxiliary("skill", run, undefined, signal, model),
      );
    },
    reviseSkillDraft(model, skillMarkdown, signal) {
      return requestSkillDraft(
        model,
        "Validate and improve the supplied Codex SKILL.md. Correct invalid frontmatter, vague routing, generic advice, contradictions, and unnecessary verbosity while preserving the intended workflow. Return only the complete revised SKILL.md, without a Markdown code fence or commentary. Keep it self-contained and do not add references to files, scripts, or assets.",
        skillMarkdown,
        (run) => runAuxiliary("skill", run, undefined, signal, model),
      );
    },
    runTerminalCommand(command, onOutput, signal, onInputReady) {
      return runTerminalCommand(command, {
        streamOutput: false,
        ...(signal ? { signal } : {}),
        ...(onInputReady ? { onInputReady } : {}),
        ...(onOutput === undefined ? {} : { onOutput }),
      });
    },
    dispose() {
      return disposal ??= (async () => {
        disposed = true;
        await Promise.resolve();
        cancelManualMemory(new Error("TUI services have been disposed"));
        const results = await Promise.allSettled([
          auxiliaryExecutor.dispose(),
          activeLearnedMemory?.dispose() ?? Promise.resolve(),
          mcp.close(),
          skillManager.close(),
          ...memoryOperations,
        ]);
        const failures = new Set(results.slice(0, 4)
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason));
        for (const failure of memoryFailures) failures.add(failure);
        if (failures.size > 0) {
          throw new AggregateError(failures, "Failed to dispose TUI services");
        }
      })();
    },
  };
}
