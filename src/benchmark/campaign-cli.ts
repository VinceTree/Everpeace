import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SystemAuthStorage } from "../storage/auth-storage.js";
import { ModelRegistry } from "../storage/model-registry.js";
import { createFileBenchmarkArtifactSink } from "./artifacts.js";
import { createProcessHarnessAdapter } from "./adapters.js";
import { createBenchmarkCampaignPlan, runBenchmarkCampaign } from "./campaign.js";
import { parseReproducibleBenchmarkTaskCatalog } from "./catalog.js";
import { prepareBenchmarkFixture, proveBenchmarkFixture } from "./preparation.js";
import { createProductionBenchmarkAdapter } from "./production.js";
import { createInstrumentedDshAdapter, PINNED_DSH_REVISION } from "./dsh.js";
import { createCheckoutBenchmarkAdapter, preflightBenchmarkCheckout } from "./checkout.js";
import type { BenchmarkHarnessAdapter, BenchmarkHarnessResult, BenchmarkTask } from "./types.js";
import { isResponsesProfile, type ResponsesProfile } from "../providers/capabilities.js";
import { normalizeBaseUrl } from "../providers/openai-compatible.js";
import { compareAgentStrategies } from "./strategy-comparison.js";
import { normalizeTeamOptions, type TeamOptions } from "../team/types.js";
import { captureBenchmarkEvaluationDigest } from "./evaluation-identity.js";

interface ExternalHarnessConfig {
  kind: "instrumented-process";
  name: string;
  command: string;
  prefixArgs?: string[];
  argsTemplate: string[];
  revision: string;
  expected: { model: string; reasoning: "high"; maxOutputTokens: number };
}

interface ProductionHarnessConfig { kind: "everpeace"; name?: "everpeace"; team?: TeamOptions }

interface CheckoutHarnessConfig {
  kind: "everpeace-checkout";
  name: string;
  sourceRoot: string;
  entryPath: string;
  revision: string;
  sourceDigest: string;
  buildDigest: string;
  expected: { model: string; reasoning: "high"; maxOutputTokens: 32_768 };
  loopStrategy?: "baseline" | "candidate";
  team?: TeamOptions;
}

interface DshHarnessConfig {
  kind: "dsh";
  name: string;
  sourceRoot: string;
  entryPath: string;
  dshHome: string;
  profile: string;
  revision: string;
  expected: { model: string; reasoning: "high"; maxOutputTokens: number };
}

export interface CampaignConfig {
  campaignId: string;
  catalogPath: string;
  fixtureRoot: string;
  runsRoot: string;
  artifactsRoot: string;
  sessionsRoot: string;
  modelId: string;
  responsesProfile?: ResponsesProfile;
  modelBaseUrl?: string;
  evaluationDigest?: string;
  seed: number;
  repetitions: number;
  taskTokenBudget: number;
  campaignTokenBudget: number;
  taskIds?: string[];
  harnesses: Array<ProductionHarnessConfig | CheckoutHarnessConfig | ExternalHarnessConfig | DshHarnessConfig>;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
  return [...value] as string[];
}

function sha256(value: unknown, field: string): string {
  const digest = string(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

export function parseCampaignConfig(value: unknown, configPath: string): CampaignConfig {
  const input = record(value, "config");
  const root = dirname(resolve(configPath));
  if (!Array.isArray(input.harnesses) || input.harnesses.length === 0) throw new Error("harnesses must be a non-empty array");
  const harnesses = input.harnesses.map((item, index): ProductionHarnessConfig | CheckoutHarnessConfig | ExternalHarnessConfig | DshHarnessConfig => {
    const harness = record(item, `harnesses[${index}]`);
    if (harness.kind === "everpeace") return { kind: "everpeace", name: "everpeace", ...(harness.team === undefined ? {} : { team: normalizeTeamOptions(record(harness.team, `harnesses[${index}].team`) as TeamOptions) }) };
    if (harness.kind !== "instrumented-process" && harness.kind !== "dsh" && harness.kind !== "everpeace-checkout") throw new Error(`harnesses[${index}].kind is unsupported`);
    const expected = record(harness.expected, `harnesses[${index}].expected`);
    if (expected.reasoning !== "high") throw new Error(`harnesses[${index}].expected.reasoning must be high`);
    const maxOutputTokens = integer(expected.maxOutputTokens, `harnesses[${index}].expected.maxOutputTokens`);
    if (maxOutputTokens !== 32_768) throw new Error(`harnesses[${index}].expected.maxOutputTokens must be 32768`);
    const shared = {
      name: string(harness.name, `harnesses[${index}].name`),
      revision: string(harness.revision, `harnesses[${index}].revision`),
      expected: {
        model: string(expected.model, `harnesses[${index}].expected.model`),
        reasoning: "high" as const,
        maxOutputTokens: 32_768 as const,
      },
    };
    if (harness.kind === "dsh") {
      if (shared.revision !== PINNED_DSH_REVISION) throw new Error(`harnesses[${index}].revision must be ${PINNED_DSH_REVISION}`);
      return {
        kind: "dsh",
        ...shared,
        sourceRoot: resolve(root, string(harness.sourceRoot, `harnesses[${index}].sourceRoot`)),
        entryPath: resolve(root, string(harness.entryPath, `harnesses[${index}].entryPath`)),
        dshHome: resolve(root, string(harness.dshHome, `harnesses[${index}].dshHome`)),
        profile: string(harness.profile, `harnesses[${index}].profile`),
      };
    }
    if (harness.kind === "everpeace-checkout") {
      if (harness.loopStrategy !== undefined && harness.loopStrategy !== "baseline" && harness.loopStrategy !== "candidate") throw new Error("loopStrategy must be baseline or candidate");
      return {
        kind: "everpeace-checkout",
        ...shared,
        ...(harness.team ? { team: normalizeTeamOptions(record(harness.team, `harnesses[${index}].team`) as TeamOptions) } : {}),
        ...(harness.loopStrategy === undefined ? {} : { loopStrategy: harness.loopStrategy as "baseline" | "candidate" }),
        sourceRoot: resolve(root, string(harness.sourceRoot, `harnesses[${index}].sourceRoot`)),
        entryPath: resolve(root, string(harness.entryPath, `harnesses[${index}].entryPath`)),
        sourceDigest: sha256(harness.sourceDigest, `harnesses[${index}].sourceDigest`),
        buildDigest: sha256(harness.buildDigest, `harnesses[${index}].buildDigest`),
      };
    }
    return {
      kind: "instrumented-process",
      ...shared,
      command: string(harness.command, `harnesses[${index}].command`),
      ...(harness.prefixArgs === undefined ? {} : { prefixArgs: stringArray(harness.prefixArgs, `harnesses[${index}].prefixArgs`) }),
      argsTemplate: stringArray(harness.argsTemplate, `harnesses[${index}].argsTemplate`),
    };
  });
  const harnessNames = harnesses.map((harness) => harness.kind === "everpeace" ? "everpeace" : harness.name);
  if (new Set(harnessNames).size !== harnessNames.length) throw new Error("Harness names must be unique");
  const path = (field: string) => resolve(root, string(input[field], field));
  const taskIds = input.taskIds === undefined ? undefined : stringArray(input.taskIds, "taskIds");
  if (input.responsesProfile !== undefined && !isResponsesProfile(input.responsesProfile)) throw new Error("Invalid responsesProfile");
  if (taskIds?.length === 0) throw new Error("taskIds must contain at least one task when provided");
  if (taskIds && new Set(taskIds).size !== taskIds.length) throw new Error("taskIds must not contain duplicates");
  return {
    campaignId: string(input.campaignId, "campaignId"),
    catalogPath: path("catalogPath"),
    fixtureRoot: path("fixtureRoot"),
    runsRoot: path("runsRoot"),
    artifactsRoot: path("artifactsRoot"),
    sessionsRoot: path("sessionsRoot"),
    modelId: string(input.modelId, "modelId"),
    ...(input.responsesProfile === undefined ? {} : { responsesProfile: input.responsesProfile as ResponsesProfile }),
    ...(input.modelBaseUrl === undefined ? {} : { modelBaseUrl: normalizeBaseUrl(string(input.modelBaseUrl, "modelBaseUrl")) }),
    ...(input.evaluationDigest === undefined ? {} : { evaluationDigest: sha256(input.evaluationDigest, "evaluationDigest") }),
    seed: integer(input.seed, "seed"),
    repetitions: integer(input.repetitions, "repetitions"),
    taskTokenBudget: integer(input.taskTokenBudget, "taskTokenBudget"),
    campaignTokenBudget: integer(input.campaignTokenBudget, "campaignTokenBudget"),
    ...(taskIds ? { taskIds } : {}),
    harnesses,
  };
}

function instrumentedResult(stdout: string): BenchmarkHarnessResult {
  const marker = "EVERPEACE_BENCHMARK_RESULT ";
  const line = stdout.split(/\r?\n/u).reverse().find((value: string) => value.startsWith(marker));
  if (!line) throw new Error("Instrumented harness did not emit EVERPEACE_BENCHMARK_RESULT JSON");
  const parsed: unknown = JSON.parse(line.slice(marker.length));
  const value = record(parsed, "instrumented result");
  const usage = record(value.usage, "instrumented result usage");
  return {
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    usage: {
      inputTokens: count(usage.inputTokens, "usage.inputTokens"),
      outputTokens: count(usage.outputTokens, "usage.outputTokens"),
      ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: count(usage.reasoningTokens, "usage.reasoningTokens") }),
      ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: count(usage.cachedInputTokens, "usage.cachedInputTokens") }),
      ...(usage.cacheObservedInputTokens === undefined ? {} : { cacheObservedInputTokens: count(usage.cacheObservedInputTokens, "usage.cacheObservedInputTokens") }),
      complete: usage.complete === true,
    },
    ...(typeof value.manualInterventions === "number" ? { manualInterventions: count(value.manualInterventions, "manualInterventions") } : {}),
    ...(typeof value.unsafeActions === "number" ? { unsafeActions: count(value.unsafeActions, "unsafeActions") } : {}),
    ...(value.terminalOutcome === "completed" || value.terminalOutcome === "stopped" || value.terminalOutcome === "plan_approved" || value.terminalOutcome === "plan_cancelled"
      ? { terminalOutcome: value.terminalOutcome }
      : {}),
    ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
    ...(value.workflowOutcome === "verified" || value.workflowOutcome === "unverified" || value.workflowOutcome === "failed" || value.workflowOutcome === "no_changes"
      ? { workflowOutcome: value.workflowOutcome }
      : {}),
    ...(typeof value.diagnosticRounds === "number" ? { diagnosticRounds: count(value.diagnosticRounds, "diagnosticRounds") } : {}),
  };
}

function externalAdapter(config: ExternalHarnessConfig): BenchmarkHarnessAdapter {
  return createProcessHarnessAdapter({
    name: config.name,
    command: config.command,
    ...(config.prefixArgs ? { prefixArgs: config.prefixArgs } : {}),
    env: {
      EVERPEACE_BENCHMARK_REVISION: config.revision,
      EVERPEACE_BENCHMARK_MODEL: config.expected.model,
      EVERPEACE_BENCHMARK_REASONING: config.expected.reasoning,
      EVERPEACE_BENCHMARK_MAX_OUTPUT_TOKENS: String(config.expected.maxOutputTokens),
    },
    argumentsForTask(task, context) {
      return config.argsTemplate.map((value) => value
        .replaceAll("${PROMPT}", task.prompt)
        .replaceAll("${WORKSPACE}", task.workspacePath)
        .replaceAll("${TOKEN_BUDGET}", String(context.tokenBudgetRemaining ?? "")));
    },
    parseResult(stdout) { return instrumentedResult(stdout); },
  });
}

async function loadTasks(config: CampaignConfig): Promise<BenchmarkTask[]> {
  const tasks = parseReproducibleBenchmarkTaskCatalog(await readFile(config.catalogPath, "utf8"));
  if (!config.taskIds) return tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const unknown = config.taskIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown taskIds: ${unknown.join(", ")}`);
  return config.taskIds.map((id) => byId.get(id)!);
}

async function prove(config: CampaignConfig): Promise<void> {
  const tasks = await loadTasks(config);
  for (const task of tasks) {
    const proof = await proveBenchmarkFixture(task, {
      fixtureRoot: config.fixtureRoot,
      destination: resolve(config.runsRoot, config.campaignId, "proof", task.id),
    });
    process.stdout.write(`${task.id}: seed=${proof.seeded.exitCode} reference=${proof.repaired.exitCode}\n`);
  }
}

interface PreflightHarnessResult {
  name: string;
  kind: string;
  status: "passed" | "failed";
  evidence?: Record<string, unknown>;
  error?: string;
}

const DSH_PREFLIGHT_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 30_000;

export async function preflight(config: CampaignConfig): Promise<void> {
  const results: PreflightHarnessResult[] = [];
  for (const harness of config.harnesses) {
    const name = harness.kind === "everpeace" ? "everpeace" : harness.name;
    try {
      if (harness.kind === "everpeace") {
        throw new Error("Credential-free preflight requires a named everpeace-checkout with revision and source/build digests");
      }
      if (harness.kind === "everpeace-checkout") {
        const identity = await preflightBenchmarkCheckout({ ...harness, modelName: harness.expected.model, ...(config.responsesProfile === undefined ? {} : { responsesProfile: config.responsesProfile }), ...(config.modelBaseUrl === undefined ? {} : { modelBaseUrl: config.modelBaseUrl }) });
        results.push({ name, kind: harness.kind, status: "passed", evidence: { ...identity, loaded: true, reasoning: "high", maxOutputTokens: 32_768 } });
        continue;
      }
      if (harness.kind === "instrumented-process") throw new Error("instrumented-process harnesses require their own credential-free preflight contract");
      const root = await mkdtemp(join(tmpdir(), "everpeace-dsh-preflight-"));
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`dsh preflight exceeded ${DSH_PREFLIGHT_TIMEOUT_MS}ms`)), DSH_PREFLIGHT_TIMEOUT_MS);
        timer.unref?.();
        const artifacts: Record<string, string> = {};
        try {
          const adapter = createInstrumentedDshAdapter({
            name,
            sourceRoot: harness.sourceRoot,
            entryPath: harness.entryPath,
            dshHome: join(root, "dsh-home"),
            profile: harness.profile,
            revision: harness.revision,
            model: harness.expected.model,
            baseUrl: "http://127.0.0.1:9",
            apiKey: "preflight-dummy",
            reasoning: "high",
            maxOutputTokens: 32_768,
            preflight: true,
          });
          const task: BenchmarkTask = { id: "dsh-preflight", prompt: "Return a short preflight acknowledgement.", workspacePath: root };
          const result = await adapter.run(task, {
            task,
            signal: controller.signal,
            attempt: 1,
            phase: "implement",
            tokenBudgetRemaining: 100,
            onPhase() {},
            onEvent() {},
            async writeArtifact(artifactName, content) { artifacts[artifactName] = content; return artifactName; },
          });
          if (result?.terminalOutcome !== "completed" || result.usage?.complete !== true) throw new Error(result?.stopReason ?? "dsh preflight did not complete at the instrumented provider boundary");
          results.push({
            name,
            kind: harness.kind,
            status: "passed",
            evidence: {
              revision: harness.revision,
              profile: harness.profile,
              providerBoundaryObserved: true,
              networkCalls: 0,
              processCleanup: "awaited",
              usage: result.usage,
              ledgerCaptured: typeof artifacts["dsh-request-ledger.json"] === "string",
            },
          });
        } finally {
          clearTimeout(timer);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    } catch (error) {
      results.push({ name, kind: harness.kind, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  await mkdir(config.artifactsRoot, { recursive: true });
  const outputPath = resolve(config.artifactsRoot, "preflight-result.json");
  await writeFile(outputPath, JSON.stringify({
    campaignId: config.campaignId,
    createdAt: new Date().toISOString(),
    model: config.modelId,
    providerCredentialsLoaded: false,
    results,
  }, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ preflight: outputPath, results }, null, 2)}\n`);
  if (results.some((result) => result.status === "failed")) throw new Error("Benchmark preflight failed");
}

async function live(config: CampaignConfig): Promise<void> {
  const registry = new ModelRegistry({ authStorage: new SystemAuthStorage() });
  const models = await registry.resolveAll();
  const matches = models.available.filter((model) => model.id === config.modelId || model.model_name === config.modelId);
  if (matches.length !== 1) throw new Error(`modelId must resolve to exactly one registered model; found ${matches.length}`);
  const model = { ...matches[0]!, ...(config.responsesProfile === undefined ? {} : { responses_profile: config.responsesProfile }) };
  if (config.modelBaseUrl !== undefined && normalizeBaseUrl(model.base_url) !== config.modelBaseUrl) throw new Error("The registered model endpoint does not match the frozen campaign modelBaseUrl");
  for (const harness of config.harnesses) {
    if (harness.kind !== "everpeace" && harness.expected.model !== model.model_name) {
      throw new Error(`${harness.name} expected model ${harness.expected.model}, but the selected raw model ID is ${model.model_name}`);
    }
  }
  const harnesses = config.harnesses.map((harness) => {
    if (harness.kind === "everpeace") return createProductionBenchmarkAdapter({ model, sessionsRoot: config.sessionsRoot, ...(harness.team ? { team: harness.team } : {}) });
    if (harness.kind === "everpeace-checkout") {
      return createCheckoutBenchmarkAdapter({
        name: harness.name,
        ...(harness.team ? { team: harness.team } : {}),
        ...(harness.loopStrategy === undefined ? {} : { loopStrategy: harness.loopStrategy }),
        sourceRoot: harness.sourceRoot,
        entryPath: harness.entryPath,
        revision: harness.revision,
        sourceDigest: harness.sourceDigest,
        buildDigest: harness.buildDigest,
        model: { ...model, request_settings: { reasoningEffort: "high", maxOutputTokens: 32_768 } },
        sessionsRoot: resolve(config.sessionsRoot, harness.name),
      });
    }
    if (harness.kind === "dsh") {
      return createInstrumentedDshAdapter({
        name: harness.name,
        sourceRoot: harness.sourceRoot,
        entryPath: harness.entryPath,
        dshHome: harness.dshHome,
        profile: harness.profile,
        revision: harness.revision,
        model: harness.expected.model,
        baseUrl: model.base_url,
        apiKey: model.api_key,
        reasoning: harness.expected.reasoning,
        maxOutputTokens: 32_768,
      });
    }
    return externalAdapter(harness);
  });
  const tasks = await loadTasks(config);
  const plan = createBenchmarkCampaignPlan(tasks, harnesses, config.repetitions, config.seed);
  await mkdir(config.artifactsRoot, { recursive: true });
  await writeFile(resolve(config.artifactsRoot, "campaign-plan.json"), JSON.stringify({
    campaignId: config.campaignId,
    seed: config.seed,
    model: model.model_name,
    taskTokenBudget: config.taskTokenBudget,
    campaignTokenBudget: config.campaignTokenBudget,
    harnesses: config.harnesses,
    plan,
  }, null, 2), "utf8");
  const result = await runBenchmarkCampaign(tasks, harnesses, {
    campaignId: config.campaignId,
    seed: config.seed,
    repetitions: config.repetitions,
    taskTokenBudget: config.taskTokenBudget,
    campaignTokenBudget: config.campaignTokenBudget,
    liveApi: true,
    artifactSink: createFileBenchmarkArtifactSink(resolve(config.artifactsRoot, "runs")),
    prepareRun(task, harness, repetition) {
      return prepareBenchmarkFixture(task, {
        fixtureRoot: config.fixtureRoot,
        destination: resolve(config.runsRoot, config.campaignId, harness, task.id, String(repetition)),
      });
    },
  });
  await writeFile(resolve(config.artifactsRoot, "campaign-result.json"), JSON.stringify(result, null, 2), "utf8");
  const baseline = config.harnesses.find((harness) => harness.kind === "everpeace-checkout" && harness.loopStrategy === "baseline");
  const candidate = config.harnesses.find((harness) => harness.kind === "everpeace-checkout" && harness.loopStrategy === "candidate");
  if (baseline && candidate && baseline.kind === "everpeace-checkout" && candidate.kind === "everpeace-checkout") {
    await writeFile(resolve(config.artifactsRoot, "strategy-comparison.json"), JSON.stringify(compareAgentStrategies(result, baseline.name, candidate.name), null, 2), "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const configIndex = args.indexOf("--config");
  if (configIndex < 0 || !args[configIndex + 1]) throw new Error("Use --config <campaign.json>");
  const liveEnabled = args.includes("--live");
  const proveEnabled = args.includes("--prove-fixtures");
  const preflightEnabled = args.includes("--preflight");
  if ([liveEnabled, proveEnabled, preflightEnabled].filter(Boolean).length !== 1) throw new Error("Choose exactly one of --preflight, --prove-fixtures, or --live");
  const configPath = resolve(args[configIndex + 1]!);
  const config = parseCampaignConfig(JSON.parse(await readFile(configPath, "utf8")), configPath);
  if (config.evaluationDigest !== undefined && await captureBenchmarkEvaluationDigest(config.catalogPath, config.fixtureRoot) !== config.evaluationDigest) throw new Error("Evaluation inputs changed; prepare a new frozen campaign before continuing");
  if (preflightEnabled) await preflight(config);
  else if (proveEnabled) await prove(config);
  else await live(config);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Benchmark campaign failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
