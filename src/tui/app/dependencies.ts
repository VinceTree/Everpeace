import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import {
  ReactAgent,
  type AgentIO,
  type ResponseStreamLike,
  type ResponsesClientLike,
} from "../../agent/react-agent.js";
import {
  createProviderClient,
  listOfficialModelIds,
} from "../../providers/openai-compatible.js";
import type { RegisteredModel } from "../../storage/model-registry.js";
import { SessionStore } from "../../storage/session-store.js";
import { InputHistory } from "../../storage/input-history.js";
import { runBash } from "../../tools/bash.js";
import { runTerminalCommand } from "../../tools/terminal.js";
import type { TuiDependencies, TuiModelRegistry } from "./types.js";
import { truncateEnd } from "../rendering/text-width.js";
import { codexSandboxProfile, type PermissionPolicy } from "../../permissions/policy.js";
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

const require = createRequire(import.meta.url);
const packageJson = require("../../../package.json") as { version?: unknown };

function packageVersion(): string {
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

async function requestSkillDraft(
  model: RegisteredModel,
  instructions: string,
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  const client = createProviderClient(model.base_url, model.api_key);
  const response = await client.responses.create(
    {
      model: model.model_name,
      instructions,
      input,
      store: false,
    },
    signal ? { signal } : undefined,
  );
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
  return {
    registry,
    version,
    workspacePath: process.cwd(),
    sessionStore,
    inputHistory: new InputHistory(),
    skillManager,
    async listModels(baseUrl, apiKey, signal) {
      return listOfficialModelIds(createProviderClient(baseUrl, apiKey), signal);
    },
    createAgent(model: RegisteredModel, io: AgentIO, restore) {
      const providerClient = createProviderClient(
        model.base_url,
        model.api_key,
      );
      const client: ResponsesClientLike = {
        responses: {
          create(params, options) {
            return providerClient.responses.create(
              params as never,
              options as never,
            ) as never;
          },
          async stream(params, options) {
            return await providerClient.responses.create(
              { ...params, stream: true } as never,
              options as never,
            ) as unknown as ResponseStreamLike;
          },
          compact(params, options) {
            return providerClient.responses.compact(
              params as never,
              options as never,
            ) as never;
          },
        },
      };
      const learnedMemory = new LearnedMemoryRuntime({
        store: learnedMemoryStore,
        client,
        model: model.model_name,
        idleDelayMs: 5 * 60 * 1000,
        minTranscriptChars: 200,
      });
      const goalRuntime = io.getGoal && io.setGoal
        ? new GoalRuntime({ getGoal: io.getGoal, setGoal: io.setGoal })
        : undefined;
      const planInteraction = io.requestPlanInput && io.reviewPlan
        ? { requestInput: io.requestPlanInput, reviewPlan: io.reviewPlan }
        : undefined;
      return new ReactAgent({
        workspacePath: process.cwd(),
        client,
        model: model.model_name,
        io,
        mcp,
        skills,
        learnedMemory,
        ...(goalRuntime ? { goalRuntime } : {}),
        ...(planInteraction ? { planInteraction } : {}),
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
      return learnedMemoryStore.status(workspacePath);
    },
    async getMemoryPrompt(workspacePath) {
      return learnedMemoryStore.prompt(workspacePath);
    },
    async setMemoryEnabled(enabled) {
      await learnedMemoryStore.setEnabled(enabled);
    },
    async clearMemory(scope, workspacePath) {
      await learnedMemoryStore.clear(scope, workspacePath);
    },
    async archiveMemory(scope, workspacePath, id) {
      await learnedMemoryStore.updateEntry(scope, workspacePath, id, { status: "archived" });
    },
    async deleteMemoryEntry(scope, workspacePath, id) {
      await learnedMemoryStore.deleteEntry(scope, workspacePath, id);
    },
    async rememberMemory(model, workspacePath, text, signal) {
      const client = createProviderClient(model.base_url, model.api_key);
      const runtime = new LearnedMemoryRuntime({
        store: learnedMemoryStore,
        client: {
          responses: {
            create(params, options) {
              return client.responses.create(params as never, options as never) as never;
            },
          },
        },
        model: model.model_name,
      });
      await runtime.remember(workspacePath, text, signal);
    },
    async generateSessionTitle(model, firstQuestion, signal) {
      const client = createProviderClient(model.base_url, model.api_key);
      const response = await client.responses.create(
        {
          model: model.model_name,
          instructions:
            "Summarize the user's request as one concise session title. " +
            "Use the same language as the request. Return only the title, " +
            "without Markdown, quotation marks, or ending punctuation.",
          input: firstQuestion,
          store: false,
        },
        signal === undefined ? undefined : { signal },
      );
      const title = sanitizeSessionTitle(response.output_text);
      if (!title) throw new Error("The model returned an empty session title");
      return title;
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
    runBash(command, policy: PermissionPolicy, signal, onOutput) {
      return runBash(command, {
        streamOutput: false,
        sandbox: {
          permissionProfile: codexSandboxProfile(policy),
          readableRoots: skills.readableRoots(),
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
        signal,
      );
    },
    reviseSkillDraft(model, skillMarkdown, signal) {
      return requestSkillDraft(
        model,
        "Validate and improve the supplied Codex SKILL.md. Correct invalid frontmatter, vague routing, generic advice, contradictions, and unnecessary verbosity while preserving the intended workflow. Return only the complete revised SKILL.md, without a Markdown code fence or commentary. Keep it self-contained and do not add references to files, scripts, or assets.",
        skillMarkdown,
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
