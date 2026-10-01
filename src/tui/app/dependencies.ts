import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  ReactAgent,
  type AgentIO,
  type ResponseStreamLike,
  type ResponsesClientLike,
} from "../../agent/react-agent.js";
import {
  createProviderClient,
  createProviderRuntime,
  createSessionPromptCacheKey,
  isOfficialOpenAiBaseUrl,
  listOfficialModelIds,
  supportsPromptCacheOptions,
} from "../../providers/openai-compatible.js";
import type { RegisteredModel } from "../../storage/model-registry.js";
import { SessionStore } from "../../storage/session-store.js";
import { InputHistory } from "../../storage/input-history.js";
import { DEFAULT_MODEL_BASH_TIMEOUT_MS, runBash } from "../../tools/bash.js";
import { createEffectiveSandboxPolicy } from "../../tools/sandbox-policy.js";
import { runTerminalCommand } from "../../tools/terminal.js";
import type { TuiDependencies, TuiModelRegistry } from "./types.js";
import { truncateEnd } from "../rendering/text-width.js";
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
import { GoalRuntime } from "../../goal/runtime.js";
import { resolveCodexCliPath } from "../../codex/cli.js";
import { modelErrorGuidance } from "../../agent/response-errors.js";
import { RequestAttemptLedger } from "../../agent/request-attempt-ledger.js";
import { RequestExecutor } from "../../agent/request-executor.js";
import { createCodeNavigationFromEnvironment } from "../../tools/code-navigation.js";
import { applyUsageSample, createEmptySessionUsage, type TokenUsageSample } from "../../status/model-status.js";
import {
  assertCompletedModelResponse,
  defaultModelRequestSettings,
  requestReasoningEffort,
  requestSettingsForPurpose,
  resolveProviderCapabilities,
  type ModelRequestPurpose,
} from "../../providers/capabilities.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const packageJson = require("../../../package.json") as { version?: unknown };

function packageVersion(): string {
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

function purposeRequest(model: RegisteredModel, purpose: ModelRequestPurpose): { max_output_tokens: number; reasoning?: { effort: string }; timeoutMs: number } {
  const capabilities = resolveProviderCapabilities(model.base_url, model.model_name);
  const coding = defaultModelRequestSettings(capabilities, model.request_settings);
  const settings = requestSettingsForPurpose(purpose, coding);
  const effort = requestReasoningEffort(capabilities, settings.reasoningEffort);
  return { max_output_tokens: settings.maxOutputTokens, ...(effort ? { reasoning: { effort } } : {}), timeoutMs: settings.timeoutMs };
}

async function requestSkillDraft(
  model: RegisteredModel,
  instructions: string,
  input: string,
  execute: <T extends { usage?: unknown; status?: unknown }>(run: () => Promise<T>) => Promise<T>,
  signal?: AbortSignal,
): Promise<string> {
  const runtime = createProviderRuntime(model.base_url, model.api_key, model.request_settings, model.model_name);
  const request = purposeRequest(model, "skill");
  const response = await execute(() => runtime.responses.create(
    {
      model: model.model_name,
      instructions,
      input,
      store: false,
      max_output_tokens: request.max_output_tokens,
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    },
    { ...(signal ? { signal } : {}), timeout: request.timeoutMs, maxRetries: 0 },
  ));
  assertCompletedModelResponse(response, "skill");
  const draft = normalizeGeneratedSkillMarkdown(response.output_text);
  validateManagedSkillMarkdown(draft);
  return draft;
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
  const version = packageVersion();
  const skills = new SkillCatalog(process.cwd());
  const skillManager = new SkillManager({ workspacePath: process.cwd(), catalog: skills });
  const mcp = new McpRuntime({ workspacePath: process.cwd(), version });
  const learnedMemoryStore = new LearnedMemoryStore();
  let auxiliaryUsage = createEmptySessionUsage();
  const auxiliaryLedger = new RequestAttemptLedger();
  const auxiliaryExecutor = new RequestExecutor(auxiliaryLedger);
  let recordedAuxiliaryAttempts = 0;
  let recordedUnknownAuxiliaryUsage = false;
  let activeLearnedMemory: LearnedMemoryRuntime | undefined;
  const runAuxiliary = async <T extends { usage?: unknown; status?: unknown }>(
    purpose: "title" | "skill" | "memory" | "doctor",
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await auxiliaryExecutor.execute(purpose, run);
    } finally {
      const snapshot = auxiliaryLedger.snapshot();
      const attempts = snapshot.attempts.slice(recordedAuxiliaryAttempts);
      recordedAuxiliaryAttempts = snapshot.attempts.length;
      for (const attempt of attempts) {
        if (attempt.status === "rejected") continue;
        if (attempt.usage === null) {
          if (!recordedUnknownAuxiliaryUsage) {
            auxiliaryUsage = applyUsageSample(auxiliaryUsage, null);
            recordedUnknownAuxiliaryUsage = true;
          }
        } else {
          auxiliaryUsage = applyUsageSample(auxiliaryUsage, attempt.usage as TokenUsageSample);
        }
      }
    }
  };
  return {
    registry,
    version,
    workspacePath: process.cwd(),
    sessionStore,
    inputHistory: new InputHistory(),
    getAuxiliaryUsage: () => ({ ...auxiliaryUsage }),
    skillManager,
    async listModels(baseUrl, apiKey, signal) {
      return listOfficialModelIds(createProviderClient(baseUrl, apiKey), signal);
    },
    createAgent(model: RegisteredModel, io: AgentIO, restore) {
      const providerRuntime = createProviderRuntime(
        model.base_url,
        model.api_key,
        model.request_settings,
        model.model_name,
      );
      const client: ResponsesClientLike = {
        responses: {
          create(params, options) {
            return providerRuntime.responses.create(params, options as never);
          },
          async stream(params, options) {
            return await providerRuntime.responses.stream(params, options as never) as ResponseStreamLike;
          },
        },
      };
      if (providerRuntime.responses.compact) {
        client.responses.compact = (params, options) =>
          providerRuntime.responses.compact!(params, options as never);
      }
      const learnedMemory = new LearnedMemoryRuntime({
        store: learnedMemoryStore,
        client: {
          responses: {
            create(params, options) {
              return runAuxiliary("memory", () => providerRuntime.responses.create(params, options as never));
            },
          },
        },
        model: model.model_name,
        idleDelayMs: 5 * 60 * 1000,
        minTranscriptChars: 200,
        sessionId: () => io.getSessionId?.(),
      });
      void activeLearnedMemory?.dispose();
      activeLearnedMemory = learnedMemory;
      const goalRuntime = io.getGoal && io.setGoal
        ? new GoalRuntime({ getGoal: io.getGoal, setGoal: io.setGoal })
        : undefined;
      const questionInteraction = io.requestUserInput
        ? { requestInput: io.requestUserInput }
        : undefined;
      const planInteraction = io.requestUserInput && io.reviewPlan
        ? { requestInput: io.requestUserInput, reviewPlan: io.reviewPlan }
        : undefined;
      let codeNavigation;
      try {
        codeNavigation = createCodeNavigationFromEnvironment(process.cwd(), {
          permissionRevision: () => permissionPolicyRevision(io.getPermissions?.() ?? defaultPermissions()),
        });
      }
      catch { codeNavigation = undefined; }
      return new ReactAgent({
        workspacePath: process.cwd(),
        client,
        model: model.model_name,
        parallelReadTools: true,
        io,
        providerCapabilities: providerRuntime.capabilities,
        requestSettings: providerRuntime.settings,
        requestAttemptLedger: new RequestAttemptLedger(),
        ...(codeNavigation ? { codeNavigation } : {}),
        ...(isOfficialOpenAiBaseUrl(model.base_url)
          ? {
              promptCacheKey: () => {
                const sessionId = io.getSessionId?.();
                return sessionId === undefined ? undefined : createSessionPromptCacheKey(sessionId);
              },
              ...(supportsPromptCacheOptions(model.model_name)
                ? { promptCacheOptions: { mode: "implicit" as const, ttl: "30m" as const } }
                : {}),
            }
          : {}),
        mcp,
        skills,
        learnedMemory,
        ...(goalRuntime ? { goalRuntime } : {}),
        ...(questionInteraction ? { questionInteraction } : {}),
        ...(planInteraction ? { planInteraction } : {}),
        ...(restore?.initialTaskProgress === undefined
          ? {}
          : { initialTaskProgress: restore.initialTaskProgress }),
        ...(restore?.initialContext === undefined
          ? {}
          : { initialHistory: restore.initialContext }),
        ...(restore?.onContextAppend === undefined
          ? {}
          : { onHistoryAppend: restore.onContextAppend }),
        ...(restore?.onContextCompacted === undefined
          ? {}
          : { onContextCompacted: restore.onContextCompacted }),
        ...(restore?.contextWindow === undefined
          ? {}
          : { contextWindow: restore.contextWindow }),
        ...(restore?.initialContextTokens === undefined
          ? {}
          : { initialContextTokens: restore.initialContextTokens }),
        ...(restore?.onUsage === undefined
          ? {}
          : { onUsage: restore.onUsage }),
        ...(restore?.onPhase === undefined
          ? {}
          : { onPhase: restore.onPhase }),
        ...(restore?.onEvent === undefined
          ? {}
          : { onEvent: restore.onEvent }),
      });
    },
    async getMemoryStatus(workspacePath) {
      return activeLearnedMemory?.status(workspacePath) ?? learnedMemoryStore.status(workspacePath);
    },
    async getMemoryPrompt(workspacePath) {
      const snapshot = activeLearnedMemory?.getSnapshot();
      return snapshot
        ? `Snapshot ${snapshot.revision} loaded ${snapshot.loadedAt}\n\n${snapshot.text || "No learned experience was injected."}`
        : "No memory snapshot has been injected in this agent session yet.";
    },
    async setMemoryEnabled(enabled) {
      await (activeLearnedMemory?.setEnabled(enabled) ?? learnedMemoryStore.setEnabled(enabled));
    },
    async clearMemory(scope, workspacePath) {
      await (activeLearnedMemory?.clear(scope, workspacePath) ?? learnedMemoryStore.clear(scope, workspacePath));
    },
    async archiveMemory(scope, workspacePath, id) {
      await (activeLearnedMemory?.archive(scope, workspacePath, id) ?? learnedMemoryStore.updateEntry(scope, workspacePath, id, { status: "archived" }));
    },
    async deleteMemoryEntry(scope, workspacePath, id) {
      await (activeLearnedMemory?.deleteEntry(scope, workspacePath, id) ?? learnedMemoryStore.deleteEntry(scope, workspacePath, id));
    },
    async rememberMemory(model, workspacePath, text, signal) {
      const providerRuntime = createProviderRuntime(model.base_url, model.api_key, model.request_settings, model.model_name);
      const memoryRuntime = new LearnedMemoryRuntime({
        store: learnedMemoryStore,
        client: {
          responses: {
            create(params, options) {
              return runAuxiliary("memory", () => providerRuntime.responses.create(params, options as never));
            },
          },
        },
        model: model.model_name,
      });
      try {
        await memoryRuntime.remember(workspacePath, text, signal);
      } finally {
        await memoryRuntime.dispose();
      }
    },
    async generateSessionTitle(model, firstQuestion, signal) {
      const runtime = createProviderRuntime(model.base_url, model.api_key, model.request_settings, model.model_name);
      const request = purposeRequest(model, "title");
      const response = await runAuxiliary("title", () => runtime.responses.create(
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
        { ...(signal ? { signal } : {}), timeout: request.timeoutMs, maxRetries: 0 },
      ));
      assertCompletedModelResponse(response, "title");
      const title = sanitizeSessionTitle(response.output_text);
      if (!title) throw new Error("The model returned an empty session title");
      return title;
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
      for (const executable of ["git", "rg"] as const) {
        try {
          await execFileAsync(executable, ["--version"], { timeout: 5_000, windowsHide: true });
          lines.push(`${executable}: probe passed`);
        } catch (error) {
          lines.push(`${executable}: unavailable (${error instanceof Error ? error.message : String(error)})`);
        }
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
          lines.push(`TypeScript navigation: configured (${navigation.describe()}); native network isolation probe passed`);
          lines.push("TypeScript navigation boundary: writes and application state are denied; direct networking was denied by probe; native platform ambient reads and temp grants still apply");
        }
      } catch (error) {
        lines.push(`TypeScript navigation: unavailable (${error instanceof Error ? error.message : String(error)})`);
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
      if (!live) {
        lines.push("Model request: not run (use /doctor --live)");
        return lines.join("\n");
      }
      if (!model) {
        lines.push("Model request: unavailable (select a model first)");
        return lines.join("\n");
      }
      const runtime = createProviderRuntime(model.base_url, model.api_key, model.request_settings, model.model_name);
      try {
        const request = purposeRequest(model, "doctor");
        const response = await runAuxiliary("doctor", () => runtime.responses.create({
          model: model.model_name,
          instructions: "This is a bounded connectivity check. Reply with OK only.",
          input: "OK",
          max_output_tokens: request.max_output_tokens,
          ...(request.reasoning ? { reasoning: request.reasoning } : {}),
        }, { maxRetries: 0, timeout: request.timeoutMs, ...(signal ? { signal } : {}) }));
        assertCompletedModelResponse(response, "doctor");
        lines.push("Model request: completed with text");
      } catch (error) {
        lines.push(`Model request: failed\n${modelErrorGuidance(error)}`);
      }
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
      const sandboxPolicy = createEffectiveSandboxPolicy(policy, cwd, skills.readableRoots());
      return runBash(command, {
        cwd,
        streamOutput: false,
        timeoutMs: timeoutMs ?? DEFAULT_MODEL_BASH_TIMEOUT_MS,
        sandbox: {
          policy: sandboxPolicy,
        },
        ...(signal ? { signal } : {}),
        ...(onOutput ? { onOutput } : {}),
      });
    },
    async getMcpStatus() {
      return formatMcpStatus(await mcp.refresh());
    },
    async getSkillsStatus() {
      return formatSkillsStatus(await skills.refresh());
    },
    generateSkillDraft(model, description, signal) {
      return requestSkillDraft(
        model,
        "Create one concise Codex SKILL.md for the requested workflow. Return only the complete SKILL.md, without a Markdown code fence or commentary. It must begin with YAML frontmatter containing a lowercase hyphenated name (maximum 64 characters) and a discriminating description that states what the skill does and when it applies. The body should contain only task-specific workflow, non-obvious constraints, and useful decision criteria. Do not create or refer to extra files, scripts, assets, or placeholders.",
        description,
        (run) => runAuxiliary("skill", run),
        signal,
      );
    },
    reviseSkillDraft(model, skillMarkdown, signal) {
      return requestSkillDraft(
        model,
        "Validate and improve the supplied Codex SKILL.md. Correct invalid frontmatter, vague routing, generic advice, contradictions, and unnecessary verbosity while preserving the intended workflow. Return only the complete revised SKILL.md, without a Markdown code fence or commentary. Keep it self-contained and do not add references to files, scripts, or assets.",
        skillMarkdown,
        (run) => runAuxiliary("skill", run),
        signal,
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
  };
}
