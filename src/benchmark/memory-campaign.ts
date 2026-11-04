import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { spawnOwned as spawn } from "../tools/owned-process.js";
import { spawn as spawnHostCheck } from "node:child_process";
import { observeProcessCompletion } from "../tools/process-completion.js";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { withPublicResponse } from "../network/public-http.js";
import { captureBenchmarkCheckoutIdentity } from "./checkout.js";
import { DATA_REVISION, SCORER_REVISION, digest, parseMemoryDataset, memoryPlan, parseJudgeTemplates, judgePrompt, parseJudgeLabel, type MemoryQuestion, type MemoryReference, type MemoryPlanItem } from "./memory-data.js";
import { optionalJson, readJson, writeJson, MemoryRequestGate, EvidenceFailure, EvidenceStorageError } from "./memory-evidence.js";
import { createMemoryAdapter, answerMemoryQuestion } from "./memory-adapters.js";
import { createProviderRuntime } from "../providers/openai-compatible.js";
import { assertCompletedModelResponse } from "../providers/capabilities.js";
import { memoryReport } from "./memory-report.js";
import { LearnedMemoryStore, stageMemoryLessons } from "../memory/learned-memory.js";
import { historyTurn } from "./memory-data.js";
import { InvalidMemoryJudgeLabelError } from "./memory-data.js";
import { ModelResponseError } from "../agent/response-errors.js";
import { freezeMemoryContinuation, verifyMemoryContinuation, type MemoryContinuation } from "./memory-continuation.js";
import { freezePublicContinuation, verifyPublicContinuation, allowFailedPublicUnknown, type MemoryPublicContinuation } from "./memory-public-continuation.js";
import { memoryServiceAdmission, memorySampleGate, type MemoryServiceAdmission } from "./memory-service.js";
import type { MemoryServiceFailure } from "./memory-service-errors.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";

export const MEMORY_REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export interface MemoryCampaignConfig {
  schema: 1; modelId: string; rawModelId: string; endpoint: string; responsesProfile: "deepseek";
  seed: 16716; repetitions: 3; concurrency: 2; taskTokenBudget: null; campaignTokenBudget: null;
  datasetRevision: string; scorerRevision: string;
}
export const DEFAULT_MEMORY_CONFIG: MemoryCampaignConfig = { schema: 1, modelId: "9e850e73-381d-42ef-b89f-193f931c4442", rawModelId: "deepseek-v4.1-flash", endpoint: "https://opencode.ai/inference/go/openai/v1", responsesProfile: "deepseek", seed: 16716, repetitions: 3, concurrency: 2, taskTokenBudget: null, campaignTokenBudget: null, datasetRevision: DATA_REVISION, scorerRevision: SCORER_REVISION };
export interface MemoryCampaignManifest { schema: 1; config: MemoryCampaignConfig; executionPolicy?: "strict" | "continue-unrun"; identity: Awaited<ReturnType<typeof captureBenchmarkCheckoutIdentity>>; files: Record<string, string>; planned: MemoryPlanItem[]; categories: Record<string, number>; createdAt: string }
export interface MemorySampleResult { key: string; questionId: string; type: string; historyHash: string; repetition: number; arm: string; status: "completed" | "failed"; correct: boolean | null; durationMs: number; failure?: string; failureDetails?: { stage: string; code: string }; serviceFailure?: MemoryServiceFailure; retainedFrom?: string; retainedSourceDigest?: string; retrieval?: { text: string; sources: string[]; entryIds: string[]; active: number; archived: number; review: number; clippedChars: number }; hypothesis?: string }
export function parseMemoryConfig(input: unknown): MemoryCampaignConfig {
  if (!input || typeof input !== "object" || JSON.stringify(Object.entries(input).sort()) !== JSON.stringify(Object.entries(DEFAULT_MEMORY_CONFIG).sort())) throw Error("This campaign requires the reviewed fixed Go/DeepSeek configuration");
  return { ...DEFAULT_MEMORY_CONFIG };
}
async function download(url: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(600000); let current = new URL(url);
  for (let i = 0; i < 8; i++) {
    const result = await withPublicResponse(current, { signal }, {}, async response => {
      if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get("location"); if (!location) throw Error("Download redirect without location"); await response.body?.cancel(); return new URL(location, current); }
      if (!response.ok) throw Error(`Public download failed: ${response.status}`);
      const reader = response.body?.getReader(); if (!reader) throw Error("Missing download body");
      const parts: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 512 * 1024 * 1024) throw Error("Dataset download exceeds 512 MiB"); parts.push(next.value); } }
      finally { await reader.cancel(); reader.releaseLock(); }
      return Buffer.concat(parts);
    });
    if (result instanceof URL) current = result; else return result;
  }
  throw Error("Too many download redirects");
}
export async function memoryIdentity() { return captureBenchmarkCheckoutIdentity(MEMORY_REPOSITORY, path.join(MEMORY_REPOSITORY, "dist/benchmark/production.js")); }
export function freezeValidatedMemoryIdentity(prepared: MemoryCampaignManifest["identity"], validated: MemoryCampaignManifest["identity"]) {
  for (const key of ["revision", "sourceDigest", "node", "entryPath"] as const) if (prepared[key] !== validated[key]) throw new EvidenceFailure("source_identity_changed_during_checks");
  return validated;
}
export async function verifyMemoryIdentity(root: string, manifest: MemoryCampaignManifest, identity = manifest.identity): Promise<void> {
  if (JSON.stringify(await memoryIdentity()) !== JSON.stringify(identity)) throw new EvidenceFailure("identity_changed");
  for (const [name, hash] of Object.entries(manifest.files)) if (digest(await readFile(path.join(root, name))) !== hash) throw new EvidenceFailure("evaluation_identity_changed");
  for (const name of ["tests/fixtures/memory-coding-pilot.ts", "docs/benchmark/memory-pilot/tasks.json", "docs/benchmark/memory-pilot/verify.mjs"]) {
    if (digest(await readFile(path.join(MEMORY_REPOSITORY, name))) !== manifest.files[`inputs/${path.basename(name)}`]) throw new EvidenceFailure("coding_evaluator_identity_changed");
  }
  if (digest(JSON.stringify(manifest)) !== (await readFile(path.join(root, "manifest.sha256"), "utf8")).trim()) throw new EvidenceFailure("manifest_changed");
  const continuation = await optionalJson<MemoryContinuation>(path.join(root, "continuation.json"));
  if (continuation) await verifyMemoryContinuation(continuation);
  const publicContinuation = await optionalJson<MemoryPublicContinuation>(path.join(root, "public-continuation.json"));
  if (publicContinuation) await verifyPublicContinuation(publicContinuation);
}

export async function prepareMemoryCampaign(root: string, config: MemoryCampaignConfig, dataCache?: string, parentRoot?: string, continueUnrun = false): Promise<void> {
  if (continueUnrun && !parentRoot) throw Error("--continue-unrun requires --continue-from");
  const continuation = parentRoot ? await freezeMemoryContinuation(parentRoot, config) : undefined;
  await mkdir(path.dirname(root), { recursive: true }); await mkdir(root);
  const url = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${DATA_REVISION}/longmemeval_s_cleaned.json`;
  let raw: Buffer;
  if (dataCache) {
    const receipt = await readJson<{ url: string; sha256: string }>(path.join(dataCache, "download.json"));
    raw = await readFile(path.join(dataCache, "dataset.raw.json"));
    if (receipt.url !== url || digest(raw) !== receipt.sha256) throw Error("Dataset cache identity mismatch");
  } else raw = await download(url);
  await writeFile(path.join(root, "dataset.raw.json"), raw, { flag: "wx" });
  await writeJson(path.join(root, "download.json"), { url, sha256: digest(raw), sourceCache: dataCache ?? null }, true);
  const { questions, references } = parseMemoryDataset(JSON.parse(raw.toString("utf8")));
  const planned = memoryPlan(questions);
  const publicContinuation = continueUnrun ? await freezePublicContinuation(parentRoot!, config, planned) : undefined;
  const scorer = await download(`https://raw.githubusercontent.com/xiaowu0162/LongMemEval/${SCORER_REVISION}/src/evaluation/evaluate_qa.py`);
  const license = await download(`https://raw.githubusercontent.com/xiaowu0162/LongMemEval/${SCORER_REVISION}/LICENSE`);
  const datasetCard = await download(`https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${DATA_REVISION}/README.md`);
  if (!/license:\s*mit/iu.test(datasetCard.toString("utf8"))) throw Error("Dataset license changed");
  const templates = parseJudgeTemplates(scorer.toString("utf8"));
  await writeJson(path.join(root, "history.json"), questions, true); await writeJson(path.join(root, "references.json"), references, true);
  await writeJson(path.join(root, "judge-templates.json"), templates, true);
  await writeFile(path.join(root, "evaluate_qa.py"), scorer, { flag: "wx" }); await writeFile(path.join(root, "LICENSE.upstream"), license, { flag: "wx" });
  await writeFile(path.join(root, "dataset-card.md"), datasetCard, { flag: "wx" });
  const files: Record<string, string> = {};
  if (publicContinuation) {
    await writeJson(path.join(root, "public-continuation.json"), publicContinuation, true);
    files["public-continuation.json"] = digest(await readFile(path.join(root, "public-continuation.json")));
    for (const row of publicContinuation.results) {
      const name = `samples/${row.key}/result.json`; await writeJson(path.join(root, name), row, true);
      files[name] = digest(await readFile(path.join(root, name)));
    }
  }
  if (continuation) { await writeJson(path.join(root, "continuation.json"), continuation, true); files["continuation.json"] = digest(await readFile(path.join(root, "continuation.json"))); }
  for (const name of ["dataset.raw.json", "history.json", "references.json", "judge-templates.json", "evaluate_qa.py", "LICENSE.upstream", "dataset-card.md"]) files[name] = digest(await readFile(path.join(root, name)));
  for (const name of ["tests/fixtures/memory-coding-pilot.ts", "docs/benchmark/memory-pilot/tasks.json", "docs/benchmark/memory-pilot/verify.mjs"]) files[`inputs/${path.basename(name)}`] = digest(await readFile(path.join(MEMORY_REPOSITORY, name)));
  await mkdir(path.join(root, "inputs"));
  for (const name of ["tests/fixtures/memory-coding-pilot.ts", "docs/benchmark/memory-pilot/tasks.json", "docs/benchmark/memory-pilot/verify.mjs"]) await writeFile(path.join(root, "inputs", path.basename(name)), await readFile(path.join(MEMORY_REPOSITORY, name)), { flag: "wx" });
  const manifest: MemoryCampaignManifest = { schema: 1, config, ...(continueUnrun ? { executionPolicy: "continue-unrun" as const } : {}), identity: await memoryIdentity(), files, planned, categories: Object.fromEntries([...new Set(questions.map(q => q.type))].map(type => [type, questions.filter(q => q.type === type).length])), createdAt: new Date().toISOString() };
  await writeJson(path.join(root, "manifest.json"), manifest, true); await writeFile(path.join(root, "manifest.sha256"), digest(JSON.stringify(manifest)), { flag: "wx" });
}

/** Child stdout/stderr go to an evidence file; no key-bearing argv or shell interpolation. */
export async function memoryChild(root: string, name: string, args: string[], signal?: AbortSignal, owned = true): Promise<void> {
  const log = await open(path.join(root, `${name}.log`), "a");
  try {
    const child = (owned ? spawn : spawnHostCheck)(process.execPath, args, { cwd: MEMORY_REPOSITORY, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
    const result = await observeProcessCompletion(child, signal ? { signal } : {}).completion;
    if (result.cleanupError) throw new EvidenceFailure("cleanup_failed");
    if (result.exitCode !== 0 || result.error || result.cancelled) throw new Error(`${name} failed (${result.exitCode ?? "unknown"})`);
  } finally { await log.close(); }
}
export async function preflightMemoryCampaign(root: string): Promise<void> {
  const manifest = await readJson<MemoryCampaignManifest>(path.join(root, "manifest.json"));
  await verifyMemoryIdentity(root, manifest);
  const pnpm = process.env.npm_execpath;
  if (!pnpm || !/pnpm\.(?:c?js)$/u.test(path.basename(pnpm))) throw Error("Run preflight through pnpm benchmark:memory-batch");
  const checks = [];
  for (const script of ["typecheck", "lint", "test", "build"]) {
    // Host development checks rebuild the owner executable in pretest on Windows.
    // Running the compiler beneath that same executable would lock its output file.
    const start = performance.now(); await memoryChild(root, `gate-${script}`, [pnpm, script], undefined, false); checks.push({ script, passed: true, durationMs: performance.now() - start });
  }
  // Build is the final check: bind its actual output after checks, without editing
  // the prepared manifest or accepting any source change during verification.
  const validated = freezeValidatedMemoryIdentity(manifest.identity, await memoryIdentity());
  await verifyMemoryIdentity(root, manifest, validated);
  const fixture = path.join(MEMORY_REPOSITORY, "tests/fixtures/memory-coding-pilot.ts");
  await memoryChild(root, "pilot-prepare", ["--import", "tsx", fixture, "prepare", path.join(root, "coding"), "--model-id", manifest.config.modelId, "--raw-model", manifest.config.rawModelId, "--base-url", manifest.config.endpoint, "--profile", "deepseek", "--token-budget", "null", "--campaign-token-budget", "null", ...(manifest.files["continuation.json"] ? ["--continuation", path.join(root, "continuation.json")] : [])]);
  await memoryChild(root, "pilot-proof", ["--import", "tsx", fixture, "prove", path.join(root, "coding")]);
  const { createProductionCommandExecutor } = await import("../runtime/production.js");
  const probe = await createProductionCommandExecutor({ workspacePath: path.join(root, "coding/initial"), policy: { mode: "workspace-write", web: false, shellNetwork: "deny" } })("node --version", AbortSignal.timeout(30000), 30000);
  if (probe.exitCode !== 0) throw Error("Native sandbox probe failed");
  await writeJson(path.join(root, "native-probe.json"), probe, true);
  await verifyMemoryIdentity(root, manifest, validated);
  const receipt = { manifest: digest(JSON.stringify(manifest)), checks, modelRequests: 0, identity: validated };
  await writeJson(path.join(root, "preflight.json"), receipt, true);
  await writeFile(path.join(root, "preflight.sha256"), digest(JSON.stringify(receipt)), { flag: "wx" });
}

async function smokeMemoryCampaign(root: string, client: import("../agent/model-protocol.js").ResponsesClientLike, gate: MemoryRequestGate, model: string, templates: string[]): Promise<void> {
  if (await optionalJson(path.join(root, "smoke.json"))) return;
  const history = [{ id: "synthetic-session", date: "2026-01-01", messages: [{ role: "user" as const, content: "Remember our project conventions. Always use cobalt as the project marker, and run node --test for verification." }, { role: "assistant" as const, content: "The marker is cobalt and the verification command is node --test." }] }];
  const signal = gate.controller.signal;
  const rows = await Promise.allSettled([0, 1].map(async i => {
    const adapter = createMemoryAdapter("learned-memory", path.join(root, "smoke", String(i)), model, client, gate, `smoke-${i}`);
    try {
      await adapter.build(history, signal); const retrieval = await adapter.retrieve("project marker verification");
      if (retrieval.active === 0) throw Error("Smoke did not produce active learned memory");
      const mergeDirectory = path.join(root, "smoke", `merge-${i}`), store = new LearnedMemoryStore({ directory: path.join(mergeDirectory, "store") });
      const turn = historyTurn(history[0]!, mergeDirectory, `smoke-merge-${i}`);
      await stageMemoryLessons({ source: { id: `smoke-merge-${i}`, turn }, store, model,
        entries: [{ scope: "project", lesson: "Use cobalt marker", applyWhen: "Marker selection" }, { scope: "project", lesson: "Run node --test", applyWhen: "Verification command" }],
        client: gate.client(client, `smoke-merge-${i}`, "merge"), execute: run => run(signal), signal,
        canWriteScope: async () => true, canWriteAny: async () => true, checkCurrent: async () => { signal.throwIfAborted(); } });
      const answer = await answerMemoryQuestion(gate.client(client, `smoke-answer-${i}`, "answer"), model, "What is 2+2?", "2026-01-01", retrieval.text, signal);
      const judged = await gate.request(client, `smoke-judge-${i}`, "judge", { model, store: false, input: judgePrompt(templates, { id: "smoke", type: "single-session-user", question: "What is 2+2?" }, 4, answer), reasoning: { effort: "none" }, max_output_tokens: 16 }, { signal, timeout: 30000 });
      assertCompletedModelResponse(judged, "doctor"); parseJudgeLabel(judged.output_text);
      return { answer, retrieval, checkpoint: await adapter.checkpoint() };
    } finally { await adapter.dispose(); }
  }));
  if (rows.some(row => row.status === "rejected") || gate.stopReason || gate.peak !== 2) throw new EvidenceFailure("Live smoke failed; retain requests and stop");
  await writeJson(path.join(root, "smoke.json"), { rows, peakConcurrentRequests: gate.peak, passed: true }, true);
}

export async function runMemoryCampaign(root: string, resume: boolean): Promise<void> {
  const release = await lockfile.lock(root, { retries: 0, stale: 10000, update: 2000 });
  let admission: MemoryServiceAdmission | undefined;
  const gate = new MemoryRequestGate(path.join(root, "requests"), 2, { onStop: () => admission?.stop() });
  const cancel = () => gate.stop("cancelled"); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  let provider: ReturnType<typeof createProviderRuntime> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inspection: Promise<void> | undefined;
  try {
    const manifest = await readJson<MemoryCampaignManifest>(path.join(root, "manifest.json")); parseMemoryConfig(manifest.config);
    const preflight = await readJson<{ manifest: string; identity: MemoryCampaignManifest["identity"] }>(path.join(root, "preflight.json"));
    if (preflight.manifest !== digest(JSON.stringify(manifest))) throw Error("Preflight identity mismatch");
    if (digest(JSON.stringify(preflight)) !== (await readFile(path.join(root, "preflight.sha256"), "utf8")).trim()) throw Error("Preflight receipt changed");
    freezeValidatedMemoryIdentity(manifest.identity, preflight.identity);
    await verifyMemoryIdentity(root, manifest, preflight.identity);
    const continueUnrun = manifest.executionPolicy === "continue-unrun";
    if (resume) {
      await readJson(path.join(root, "started.json"));
      const old = await optionalJson<{ stopReason: string | null }>(path.join(root, "run-state.json"));
      if (old?.stopReason && /storage|cleanup|identity|unresolved|unknown|smoke/iu.test(old.stopReason)) { gate.stop(old.stopReason); throw new EvidenceFailure("Prior failure blocks recovery"); }
      await gate.validateRecovery(continueUnrun ? record => allowFailedPublicUnknown(root, manifest.planned, record) : undefined);
    } else await writeJson(path.join(root, "started.json"), { at: new Date().toISOString(), manifest: preflight.manifest }, true);
    // Credentials are resolved only after every offline/frozen identity check.
    const { ModelRegistry } = await import("../storage/model-registry.js"), { SystemAuthStorage } = await import("../storage/auth-storage.js");
    const model = (await new ModelRegistry({ authStorage: new SystemAuthStorage() }).resolveAll()).available.find(m => m.id === manifest.config.modelId && m.model_name === manifest.config.rawModelId && m.base_url.replace(/\/+$/u, "") === manifest.config.endpoint);
    if (!model) throw Error("Frozen Go model registration unavailable");
    provider = createProviderRuntime(model.base_url, model.api_key, { reasoningEffort: "high", maxOutputTokens: 32768 }, model.model_name, "deepseek", { sessionId: () => `memory-${preflight.manifest.slice(0, 24)}` });
    const templates = await readJson<string[]>(path.join(root, "judge-templates.json"));
    await smokeMemoryCampaign(root, provider, gate, model.model_name, templates);
    await verifyMemoryIdentity(root, manifest, preflight.identity);
    const codingRoot = path.join(root, "coding");
    if (!(await optionalJson<{ stopReason: string | null }>(path.join(codingRoot, "live-result.json"))) || resume) {
      const already = await optionalJson(path.join(codingRoot, "live-started.json"));
      try { await memoryChild(root, "coding-live", ["--import", "tsx", path.join(MEMORY_REPOSITORY, "tests/fixtures/memory-coding-pilot.ts"), "live", codingRoot, "--live", ...(already ? ["--resume"] : [])], gate.controller.signal); }
      catch (error) {
        const stopped = await optionalJson<{ stopReason: string | null }>(path.join(codingRoot, "live-result.json"));
        if (stopped?.stopReason) throw new EvidenceFailure(`coding_${stopped.stopReason}`);
        throw error;
      }
    }
    const coding = await readJson<{ stopReason: string | null }>(path.join(codingRoot, "live-result.json")); if (coding.stopReason) throw new EvidenceFailure(`coding_${coding.stopReason}`);
    const questions = new Map((await readJson<MemoryQuestion[]>(path.join(root, "history.json"))).map(q => [q.id, q]));
    const references = new Map((await readJson<MemoryReference[]>(path.join(root, "references.json"))).map(q => [q.id, q]));
    let checking = false;
    timer = setInterval(() => { if (checking) return; checking = true; inspection = verifyMemoryIdentity(root, manifest, preflight.identity).catch(() => gate.stop("identity_changed")).finally(() => { checking = false; }); }, 30000);
    if (continueUnrun) admission = memoryServiceAdmission(root, () => gate.stopReason, error => gate.failStorage(error));
    let cursor = 0, newlySettled = 0;
    const retained = await optionalJson<MemoryPublicContinuation>(path.join(root, "public-continuation.json"));
    const worker = async () => {
      while (cursor < manifest.planned.length && !gate.stopReason) {
        const item = manifest.planned[cursor++]!, directory = path.join(root, "samples", item.key), resultFile = path.join(directory, "result.json");
        if (await optionalJson(resultFile)) continue;
        const question = questions.get(item.questionId)!, reference = references.get(item.questionId)!, started = performance.now();
        const signal = AbortSignal.any([gate.controller.signal, AbortSignal.timeout(7200000)]);
        const sampleGate = admission ? memorySampleGate(path.join(root, "requests"), item.key, gate, admission) : gate;
        const adapter = createMemoryAdapter(item.arm, directory, model.model_name, provider!, sampleGate, item.key);
        const result: MemorySampleResult = { ...item, type: question.type, status: "failed", correct: null, durationMs: 0 };
        try {
          const answered = await optionalJson<Pick<MemorySampleResult, "hypothesis" | "retrieval">>(path.join(directory, "answer.json"));
          if (answered) {
            if (typeof answered.hypothesis !== "string" || !answered.retrieval || typeof answered.retrieval.text !== "string") throw new EvidenceFailure("invalid_answer_checkpoint");
            result.hypothesis = answered.hypothesis; result.retrieval = answered.retrieval;
          } else {
            await adapter.build(question.history, signal);
            result.retrieval = await adapter.retrieve(question.question);
            result.hypothesis = await answerMemoryQuestion(sampleGate.client(provider!, `${item.key}:answer`, "answer"), model.model_name, question.question, question.date, result.retrieval.text, signal);
            await writeJson(path.join(directory, "answer.json"), { hypothesis: result.hypothesis, retrieval: result.retrieval }, true);
          }
          const response = await sampleGate.request(provider!, `${item.key}:judge`, "judge", { model: model.model_name, store: false, input: judgePrompt(templates, question, reference.answer, result.hypothesis), reasoning: { effort: "none" }, max_output_tokens: 16 }, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), timeout: 30000 });
          if (sampleGate.stopReason) throw new EvidenceFailure(sampleGate.stopReason);
          assertCompletedModelResponse(response, "doctor"); result.correct = parseJudgeLabel(response.output_text); result.status = "completed";
        } catch (error) {
          result.failure = error instanceof Error ? error.name : "unknown";
          const details = error instanceof EvidenceStorageError ? { stage: error.stage, code: error.code } : error instanceof EvidenceFailure ? error.details : undefined;
          if (details) result.failureDetails = details;
          const capabilityFailure = error instanceof InvalidMemoryJudgeLabelError || error instanceof ModelResponseError && error.response.status === "incomplete";
          if (sampleGate.serviceFailure) result.serviceFailure = sampleGate.serviceFailure;
          if (error instanceof ResourceCleanupError) gate.stop("cleanup_failed");
          else if (error instanceof EvidenceStorageError) gate.failStorage(error);
          else if (!capabilityFailure && !(admission && (sampleGate.serviceStopped || signal.aborted && !gate.controller.signal.aborted))) gate.stop(error instanceof EvidenceFailure ? "evidence_failure" : "sample_runtime_error");
        }
        finally {
          try { await adapter.dispose(); } catch { gate.stop("cleanup_failed"); }
          result.durationMs = performance.now() - started;
          try { await writeJson(resultFile, result, true); } catch (error) { gate.failStorage(error); }
        }
        newlySettled++;
        console.log(JSON.stringify({ planned: manifest.planned.length, cursor, newlySettled, retained: retained?.results.length ?? 0, questionId: item.questionId, arm: item.arm, status: result.status, correct: result.correct, stopReason: gate.stopReason ?? null }));
      }
    };
    await Promise.allSettled([worker(), worker()]).then(results => { if (results.some(r => r.status === "rejected")) gate.stop("storage_or_worker_failed"); });
    await verifyMemoryIdentity(root, manifest, preflight.identity);
  } catch (error) {
    if (error instanceof EvidenceStorageError) gate.failStorage(error);
    else gate.stop(error instanceof EvidenceFailure ? error.message : error instanceof Error ? error.name : "runtime_error");
  } finally {
    if (timer) clearInterval(timer);
    await inspection;
    try { await admission?.close(); } catch { gate.stop("unresolved_requests"); }
    try { await provider?.dispose?.(); } catch { gate.stop("cleanup_failed"); }
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    try { await writeJson(path.join(root, "run-state.json"), { stoppedAt: new Date().toISOString(), stopReason: gate.stopReason ?? null, peakConcurrentRequests: Math.max(gate.peak, admission?.peak ?? 0), ...(gate.storageFailure ? { storageFailure: gate.storageFailure } : {}) }); await memoryReport(root); }
    finally { await release(); }
  }
  if (gate.stopReason) throw new Error(`Memory campaign stopped: ${gate.stopReason}`);
}
