import { selectMemoryEntriesAsync, type SemanticStrategy, type SemanticEncoder, type SemanticTrace } from "../memory/semantic-retrieval.js";
import { loadLocalEncoder, prepareSemanticAssets, verifySemanticAssets, semanticRuntimeFiles, BGE_BASE_MODEL, E5_MODEL } from "../memory/local-encoder.js";
/** Sealed-store retrieval ablation and explicitly authorized reader-only pilot. Never builds memory. */
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { memoryIdentity, MEMORY_REPOSITORY } from "./memory-campaign.js";
import { digest, judgePrompt, parseJudgeLabel, type MemoryQuestion, type MemoryReference } from "./memory-data.js";
import { readJson, writeJson, jsonFiles, optionalJson, MemoryRequestGate, type MemoryRequestRecord } from "./memory-evidence.js";
import { memoryEntryExpired, memoryEntryHasProvenance, projectMemoryKey } from "../memory/learned-memory.js";
import { normalizeFact, type MemoryFact } from "../memory/facts.js";
import { selectMemoryEntries, memorySelectionText, memoryEntryLine, type MemoryRetrievalStrategy } from "../memory/retrieval.js";
import { READER_INSTRUCTIONS, answerMemoryQuestion } from "./memory-adapters.js";
import type { ResponsesClientLike, ResponsesRequestOptions } from "../agent/model-protocol.js";
import { assertCompletedModelResponse } from "../providers/capabilities.js";

const BUDGET = 500_000;
const legacyStrategies = ["current", "terms", "aggregate", "protected"] as const;
const semanticStrategies = ["semantic-protected-075", "semantic-protected-080"] as const;
const modelStrategies = ["semantic-protected-bge-terms", "semantic-protected-bge-mmr"] as const;
const strategies = [...legacyStrategies, ...semanticStrategies, ...modelStrategies];
interface Context { text: string; ids: string[]; bodyChars: number; sources: string[]; semantic?: SemanticTrace }
interface Case { question: Omit<MemoryQuestion, "history">; facts: MemoryFact[]; contexts: Record<typeof legacyStrategies[number], Context> & Partial<Record<SemanticStrategy, Context>> }
interface EvidenceAudit { questionId: string; necessary: string[]; anchor?: string; rationale: string; semanticRequired?: string[] }
export type RecallSelectionPolicy = "evidence-gain" | "preservation-repair" | "semantic-gain" | "semantic-model-gain";
interface Manifest {
  identity: Awaited<ReturnType<typeof memoryIdentity>>; files: Record<string, string>; inputHashes: Record<string, string>;
  model: { modelId: string; rawModelId: string; endpoint: string }; budget: number; seed: number;
  selected: MemoryRetrievalStrategy | null; createdAt: string; partial: string[];
  parentKnownTokens: number; parentUnknown: number;
  selectionPolicy?: RecallSelectionPolicy;
  encoder?: { directory: string; identity: string };
}
interface PlanItem { key: string; questionId: string; arm: MemoryRetrievalStrategy; smoke: boolean }
interface Result extends PlanItem { status: "completed" | "failed" | "skipped"; correct: boolean | null; hypothesis?: string; failure?: string; durationMs?: number }

export function completeFactStore(next: number | undefined, total: number): boolean {
  return total > 0 && Number.isSafeInteger(next) && next === total;
}
export function recallFactsFile(sample: string): string {
  return path.join(sample, "store", "projects", projectMemoryKey(path.join(sample, "workspace")), "facts.json");
}
export function recallContext(facts: readonly MemoryFact[], query: string, now: Date, strategy: MemoryRetrievalStrategy): Context {
  const eligible = facts.filter(e => e.status === "active" && !memoryEntryExpired(e, now) && memoryEntryHasProvenance(e));
  const selected = selectMemoryEntries(eligible, query, now, 8000, strategy);
  return { text: memorySelectionText(selected), ids: selected.map(e => e.id), bodyChars: selected.map(memoryEntryLine).join("\n").length,
    sources: [...new Set(selected.flatMap(e => e.fact?.sessionId ? [e.fact.sessionId] : []))] };
}
export async function semanticRecallContext(facts: readonly MemoryFact[], query: string, now: Date, strategy: SemanticStrategy, encoder: SemanticEncoder): Promise<Context> {
  const eligible = facts.filter(e => e.status === "active" && !memoryEntryExpired(e, now) && memoryEntryHasProvenance(e));
  let trace: SemanticTrace | undefined;
  const selected = await selectMemoryEntriesAsync(eligible, query, now, 8000, strategy, { encoder, trace: value => { trace = value; } });
  return { text: memorySelectionText(selected), ids: selected.map(e => e.id), bodyChars: selected.map(memoryEntryLine).join("\n").length,
    sources: [...new Set(selected.flatMap(e => e.fact?.source?.sessionId ?? e.fact?.sessionId ?? []))], ...(trace ? { semantic: trace } : {}) };
}
export function chooseRecallCandidate(cases: Case[], audit: EvidenceAudit[], policy: RecallSelectionPolicy = "evidence-gain"): { selected: MemoryRetrievalStrategy | null; counts: unknown; policy: RecallSelectionPolicy } {
  if (new Set(cases.map(c => c.question.id)).size !== cases.length || new Set(audit.map(a => a.questionId)).size !== cases.length || audit.length !== cases.length
    || audit.filter(a => a.anchor).length !== 4) throw Error("Audit coverage differs");
  const available = strategies.filter(s => cases.every(c => c.contexts[s]));
  if (policy === "preservation-repair" && !available.includes("protected")) throw Error("Protected strategy missing");
  const semanticPolicy = policy === "semantic-gain" || policy === "semantic-model-gain";
  const candidates = policy === "semantic-model-gain" ? modelStrategies : semanticStrategies;
  if (semanticPolicy && (!candidates.every(s => available.includes(s)) || !audit.some(a => (a.semanticRequired?.length ?? 0) >= 2))) throw Error("Semantic audit or strategies missing");
  const counts = available.map(strategy => {
    let gain = 0, lost = 0, anchors = 0, repairRequired = 0, repaired = 0, baselinePreserved = true, semanticComplete = true;
    for (const c of cases) {
      const a = audit.find(v => v.questionId === c.question.id);
      if (!a || !a.necessary.length || new Set(a.necessary).size !== a.necessary.length || a.necessary.some(id => !c.facts.some(f => f.id === id))
        || a.anchor && !a.necessary.includes(a.anchor)) throw Error("Audit fact missing");
      const before = a.necessary.filter(id => c.contexts.current.ids.includes(id)).length;
      const after = a.necessary.filter(id => c.contexts[strategy]!.ids.includes(id)).length;
      gain += Math.max(0, after - before);
      lost += a.necessary.filter(id => c.contexts.current.ids.includes(id) && !c.contexts[strategy]!.ids.includes(id)).length;
      if (a.anchor && c.contexts[strategy]!.ids.includes(a.anchor)) anchors++;
      const oldLosses = a.necessary.filter(id => c.contexts.current.ids.includes(id) && !c.contexts.aggregate.ids.includes(id));
      repairRequired += oldLosses.length;
      repaired += oldLosses.filter(id => c.contexts[strategy]!.ids.includes(id)).length;
      baselinePreserved &&= c.contexts.current.ids.every((id, i) => c.contexts[strategy]!.ids[i] === id) && c.contexts[strategy]!.bodyChars <= 8000;
      if (semanticPolicy) {
        const entries = c.contexts[strategy]!.ids.map(id => {
          const fact = c.facts.find(f => f.id === id); if (!fact) throw Error("Unknown context fact"); return fact;
        });
        baselinePreserved &&= c.contexts[strategy]!.text === memorySelectionText(entries)
          && c.contexts[strategy]!.bodyChars === entries.map(memoryEntryLine).join("\n").length;
      }
      if (a.semanticRequired) {
        if (new Set(a.semanticRequired).size !== a.semanticRequired.length || a.semanticRequired.some(id => !a.necessary.includes(id) || c.contexts.current.ids.includes(id))) throw Error("Invalid semantic audit requirement");
        semanticComplete &&= a.semanticRequired.every(id => c.contexts[strategy]!.ids.includes(id));
      }
    }
    const eligible = policy === "preservation-repair" ? strategy === "protected" && baselinePreserved && repairRequired > 0 && repaired === repairRequired && lost === 0 && anchors === 4
      : semanticPolicy ? candidates.some(s => s === strategy) && baselinePreserved && semanticComplete && gain > 0 && lost === 0 && anchors === 4
      : strategy !== "current" && gain > 0 && lost === 0 && anchors === 4;
    return { strategy, gain, lost, anchors, repairRequired, repaired, baselinePreserved, semanticComplete, eligible };
  });
  const winner = counts.filter(c => c.eligible).sort((a, b) => b.gain - a.gain || (semanticPolicy ? strategies.indexOf(b.strategy) - strategies.indexOf(a.strategy) : strategies.indexOf(a.strategy) - strategies.indexOf(b.strategy)))[0];
  return { selected: winner?.strategy ?? null, counts, policy };
}

export async function verifyRecallInputs(root: string, checkIdentity = true): Promise<Manifest> {
  const bytes = await readFile(path.join(root, "manifest.json"));
  if (digest(bytes) !== (await readJson<{ sha256: string }>(path.join(root, "manifest-hash.json"))).sha256) throw Error("Manifest changed");
  const m = JSON.parse(bytes.toString("utf8")) as Manifest;
  if (m.budget !== BUDGET || m.seed !== 16716 || m.model.rawModelId !== "deepseek-v4.1-flash"
    || m.model.endpoint !== "https://opencode.ai/inference/go/openai/v1"
    || m.selectionPolicy !== undefined && !["evidence-gain", "preservation-repair", "semantic-gain", "semantic-model-gain"].includes(m.selectionPolicy)) throw Error("Unreviewed authorization or model");
  if (checkIdentity && JSON.stringify(m.identity) !== JSON.stringify(await memoryIdentity())) throw Error("Candidate identity changed");
  if (m.selectionPolicy === "semantic-gain" || m.selectionPolicy === "semantic-model-gain") {
    if (!m.encoder) throw Error("Encoder identity missing");
    const assets = await verifySemanticAssets(m.encoder.directory);
    if (assets.identity !== m.encoder.identity || assets.model !== (m.selectionPolicy === "semantic-model-gain" ? BGE_BASE_MODEL : E5_MODEL)) throw Error("Encoder identity changed");
  }
  for (const [file, hash] of Object.entries({ ...m.inputHashes, ...Object.fromEntries(Object.entries(m.files).map(([f, h]) => [path.join(root, f), h])) })) {
    if (digest(await readFile(file)) !== hash) throw Error("Frozen input changed");
  }
  return m;
}

async function prepare(root: string, parent: string, child: string, auditFile: string, policy: RecallSelectionPolicy = "evidence-gain", encoderDirectory?: string): Promise<void> {
  // Atomic directory claim makes all subsequent writes owned and refuses all prior output.
  if ([parent, child].some(p => root === p || root.startsWith(p + path.sep))) throw Error("Output must be outside old experiments");
  await mkdir(root);
  const identity = await memoryIdentity();
  const inputHashes: Record<string, string> = {};
  const frozen = async <T>(file: string): Promise<T> => { const bytes = await readFile(file); inputHashes[file] = digest(bytes); return JSON.parse(bytes.toString("utf8")) as T; };
  const cm = await frozen<{ continuation: { parentRoot: string }; planned: Array<{ key: string; questionId: string; arm: string }>; model: Manifest["model"] }>(path.join(child, "manifest.json"));
  if (path.resolve(cm.continuation.parentRoot) !== parent) throw Error("Parent differs");
  const rows = (await frozen<{ rows: Array<{ key: string; retainedFrom?: string }> }>(path.join(child, "report.json"))).rows;
  let parentKnownTokens = 0, parentUnknown = 0;
  const stops = new Map<string, string>();
  for (const owner of [parent, child]) {
    stops.set(owner, (await frozen<{ stoppedAt: string }>(path.join(owner, "run-state.json"))).stoppedAt);
    for (const file of await jsonFiles(path.join(owner, "requests"))) {
      const r = await frozen<MemoryRequestRecord>(file);
      if (r.state !== "settled" || r.openRequests !== 0) throw Error("Parent has unresolved requests");
      parentKnownTokens += r.usage.inputTokens + r.usage.outputTokens; if (!r.usage.complete) parentUnknown++;
    }
  }
  const questions = await frozen<MemoryQuestion[]>(path.join(child, "history.json"));
  const cases: Case[] = [], partial: string[] = [];
  const caseTimes = new Map<string, Date>();
  for (const item of cm.planned.filter(p => p.arm === "fact-memory")) {
    const row = rows.find(r => r.key === item.key); if (!row) throw Error("Missing source row");
    const owner = row.retainedFrom ? path.resolve(row.retainedFrom) : child;
    if (![parent, child].includes(owner)) throw Error("Unexpected source owner");
    const sample = path.join(owner, "samples", digest(item.key));
    const checkpoint = await frozen<{ next: number }>(path.join(sample, "fact-build.json"));
    const q = questions.find(q => q.id === item.questionId); if (!q) throw Error("Question missing");
    if (!completeFactStore(checkpoint.next, q.history.length)) { partial.push(q.id); continue; }
    const facts = (await frozen<unknown[]>(recallFactsFile(sample))).map(normalizeFact);
    const question = { id: q.id, type: q.type, question: q.question, date: q.date, historyHash: q.historyHash };
    const contexts = Object.fromEntries(legacyStrategies.map(s => [s, recallContext(facts, q.question, new Date(stops.get(owner)!), s)])) as Case["contexts"];
    cases.push({ question, facts, contexts });
    caseTimes.set(q.id, new Date(stops.get(owner)!));
  }
  if (cases.length !== 11 || partial.length !== 1) throw Error("Expected eleven complete stores and one partial");
  let encoder: Manifest["encoder"];
  const candidates = policy === "semantic-model-gain" ? modelStrategies : semanticStrategies;
  if (policy === "semantic-gain" || policy === "semantic-model-gain") {
    if (!encoderDirectory) throw Error("Encoder directory required");
    const assets = await verifySemanticAssets(encoderDirectory);
    if (policy === "semantic-model-gain" && assets.model !== BGE_BASE_MODEL) throw Error("BGE base assets required");
    if (policy === "semantic-gain" && assets.model !== E5_MODEL) throw Error("E5 assets required");
    Object.assign(inputHashes, assets.files, await semanticRuntimeFiles());
    encoder = { directory: encoderDirectory, identity: assets.identity };
    const local = await loadLocalEncoder(encoderDirectory);
    try {
      for (const c of cases) for (const strategy of candidates) {
        c.contexts[strategy] = await semanticRecallContext(c.facts, c.question.question, caseTimes.get(c.question.id)!, strategy, local);
        console.log(JSON.stringify({ prepared: c.question.id, strategy, bodyChars: c.contexts[strategy]!.bodyChars }));
      }
    } finally { await local.dispose(); }
  }
  // Retrieval finishes before any audit labels or references are loaded.
  const audit = await frozen<EvidenceAudit[]>(auditFile);
  const selection = chooseRecallCandidate(cases, audit, policy);
  const refs = await frozen<MemoryReference[]>(path.join(child, "references.json"));
  const templates = await frozen<string[]>(path.join(child, "judge-templates.json"));
  const smokes = await smokeCases();
  inputHashes[path.join(MEMORY_REPOSITORY, "tests/fixtures/memory-fact-preservation.json")] = digest(await readFile(path.join(MEMORY_REPOSITORY, "tests/fixtures/memory-fact-preservation.json")));
  if (encoder) {
    const local = await loadLocalEncoder(encoder.directory);
    try { for (const c of smokes.cases) for (const strategy of candidates)
      c.contexts[strategy] = await semanticRecallContext(c.facts, c.question.question, new Date(c.question.date), strategy, local);
    } finally { await local.dispose(); }
  }
  const planned = pairedPlan(cases, smokes.cases, selection.selected);
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries({ "cases.json": cases, "audit.json": audit, "references.json": [...refs.filter(r => cases.some(c => c.question.id === r.id)), ...smokes.references],
    "smoke.json": smokes.cases, "judge-templates.json": templates, "selection.json": selection, "plan.json": planned,
    "prompts.json": { reader: READER_INSTRUCTIONS, reasoning: "high", output: 32768, judgeOutput: 16, bodyChars: 8000 } })) {
    await writeJson(path.join(root, name), value, true); files[name] = digest(await readFile(path.join(root, name)));
  }
  if (JSON.stringify(identity) !== JSON.stringify(await memoryIdentity())) throw Error("Candidate changed during preparation");
  const manifest: Manifest = { identity, files, inputHashes, model: cm.model, selected: selection.selected,
    budget: BUDGET, seed: 16716, createdAt: new Date().toISOString(), partial, parentKnownTokens, parentUnknown, selectionPolicy: policy, ...(encoder ? { encoder } : {}) };
  await writeJson(path.join(root, "manifest.json"), manifest, true);
  await writeJson(path.join(root, "manifest-hash.json"), { sha256: digest(await readFile(path.join(root, "manifest.json"))) }, true);
  await writeJson(path.join(root, "authorization.json"), { liveAuthorized: true, executableCampaign: selection.selected !== null, selectionPolicy: policy, totalInputOutputTokens: BUDGET, source: policy === "semantic-gain" || policy === "semantic-model-gain" ? "User authorized the local semantic recall pilot with a new 500000-token budget after offline acceptance, without asking again" : "User explicitly authorized the local chat to repair aggregation and run the 500000-token pilot after offline acceptance without asking again", extractionRequests: 0 }, true);
  await verifyRecallInputs(root);
  console.log(JSON.stringify({ ...selection, completeStores: cases.length, partial, modelRequests: 0 }));
}

function pairedPlan(cases: Case[], smoke: Case[], selected: MemoryRetrievalStrategy | null): PlanItem[] {
  if (!selected) return [];
  return [smoke, [...cases].sort((a, b) => digest(`16716:${a.question.id}`).localeCompare(digest(`16716:${b.question.id}`)))].flatMap((group, section) => group.flatMap((c, i) =>
    (i % 2 ? [selected, "current"] as const : ["current", selected] as const).map(arm => ({ key: `${section ? "qa" : "smoke"}:${c.question.id}:${arm}`, questionId: c.question.id, arm, smoke: section === 0 }))));
}

async function smokeCases(): Promise<{ cases: Case[]; references: MemoryReference[] }> {
  const fixture = await readJson<{ tasks: Array<{ id: string; question: string; questionDate: string; history: MemoryQuestion["history"]; expected: { answer: string | null } }> }>(path.join(MEMORY_REPOSITORY, "tests/fixtures/memory-fact-preservation.json"));
  const ids = ["detail-cat-en", "detail-beer", "detail-count", "update-current", "cross-two-counts", "insufficient-no-name"];
  const cases: Case[] = [], references: MemoryReference[] = [];
  for (const id of ids) {
    const t = fixture.tasks.find(t => t.id === id)!;
    // Every fixed fact is exactly one attributed fixture message. No extraction model or answer label is used.
    const facts = t.history.flatMap(s => s.messages.map((m, i) => normalizeFact({ id: `fact-${digest(`${id}:${s.id}:${i}`).slice(0, 24)}`, scope: "project", lesson: m.content,
      createdAt: s.date, fact: { speaker: m.role, quote: m.content, messageTime: s.date, sourceId: `${s.id}:${i}`, sessionId: s.id, sourceMessageHash: digest(m.content) } })));
    const question: Case["question"] = { id: `smoke-${id}${t.expected.answer === null ? "_abs" : ""}`, question: t.question, date: t.questionDate, historyHash: digest(JSON.stringify(t.history)), type: id === "update-current" ? "knowledge-update" : "single-session-user" };
    cases.push({ question, facts, contexts: Object.fromEntries(legacyStrategies.map(s => [s, recallContext(facts, t.question, new Date(t.questionDate), s)])) as Case["contexts"] });
    references.push({ id: question.id, answer: t.expected.answer ?? "Not enough information is available to answer.", evidence: [] });
  }
  return { cases, references };
}

export class RecallBudget {
  spent = 0; reserved = 0;
  readonly attempted = new Set<string>();
  constructor(readonly limit = BUDGET) {}
  reserve(params: Record<string, unknown>): () => void {
    const output = Number(params.max_output_tokens ?? 32768);
    if (!Number.isSafeInteger(output) || output <= 0) throw Error("invalid_output_budget");
    const size = Buffer.byteLength(JSON.stringify(params), "utf8") + output + 4096;
    if (this.spent + this.reserved + size > this.limit) throw Error("budget_exhausted");
    this.reserved += size;
    let released = false;
    return () => { if (!released) { this.reserved -= size; released = true; } };
  }
}

/** One durable, non-retrying request path shared by live code and fixed-response lifecycle tests. */
export async function recallRequest(gate: MemoryRequestGate, provider: ResponsesClientLike, budget: RecallBudget, key: string, phase: "answer" | "judge",
  params: Record<string, unknown>, options: ResponsesRequestOptions = {}, verify: () => Promise<unknown> = async () => {}) {
  try { await verify(); } catch (error) { gate.stop("identity_changed"); throw error; }
  if (!["answer", "judge"].includes(phase) || budget.attempted.has(`${key}:${phase}`)) { gate.stop("request_identity_changed"); throw Error("Repeated or unsupported request"); }
  budget.attempted.add(`${key}:${phase}`);
  let release: () => void;
  try { release = budget.reserve(params); } catch (error) { gate.stop("budget_exhausted"); throw error; }
  try {
    const response = await gate.request(provider, `${key}:${phase}`, phase, params, options);
    if (gate.stopReason) throw Error(gate.stopReason);
    return response;
  }
  finally {
    try {
      let record: MemoryRequestRecord | undefined;
      try { record = await readJson(path.join(gate.directory, `${digest(`${key}:${phase}`)}.json`)); }
      catch (error) {
        // oxlint-disable-next-line no-unsafe-finally -- Lost billing evidence must override a provider result.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (record) budget.spent += record.usage.inputTokens + record.usage.outputTokens;
    } catch (error) {
      gate.failStorage(error);
      // oxlint-disable-next-line no-unsafe-finally -- Durable accounting failure closes admission even after provider success.
      throw error;
    } finally { release(); }
  }
}

async function preflight(root: string): Promise<void> {
  const m = await verifyRecallInputs(root);
  const cases = [...await readJson<Case[]>(path.join(root, "cases.json")), ...await readJson<Case[]>(path.join(root, "smoke.json"))];
  for (const c of cases) for (const s of strategies.filter(s => c.contexts[s])) {
    const context = c.contexts[s]!;
    if (context.bodyChars > 8000 || context.ids.some(id => !c.facts.some(f => f.id === id))) throw Error("Invalid context");
    const entries = context.ids.map(id => c.facts.find(f => f.id === id)!);
    if (context.text !== memorySelectionText(entries) || context.bodyChars !== entries.map(memoryEntryLine).join("\n").length) throw Error("Context differs from frozen facts");
  }
  const selection = chooseRecallCandidate(cases.filter(c => !c.question.id.startsWith("smoke-")), await readJson(path.join(root, "audit.json")), m.selectionPolicy);
  if (selection.selected !== m.selected) throw Error("Selection differs");
  await writeJson(path.join(root, "preflight.json"), { manifestHash: digest(await readFile(path.join(root, "manifest.json"))), at: new Date().toISOString(), modelRequests: 0, selected: m.selected }, true);
  console.log(JSON.stringify({ preflight: "passed", selected: m.selected, modelRequests: 0 }));
}

async function run(root: string): Promise<void> {
  const m = await verifyRecallInputs(root);
  if (!m.selected) throw Error("No candidate passed offline selection; no live requests authorized for this package");
  const pf = await readJson<{ manifestHash: string }>(path.join(root, "preflight.json"));
  if (pf.manifestHash !== digest(await readFile(path.join(root, "manifest.json")))) throw Error("Preflight differs");
  await writeJson(path.join(root, "started.json"), { at: new Date().toISOString(), budget: BUDGET }, true);
  const { ModelRegistry } = await import("../storage/model-registry.js"), { SystemAuthStorage } = await import("../storage/auth-storage.js");
  const model = (await new ModelRegistry({ authStorage: new SystemAuthStorage() }).resolveAll()).available.find(v => v.id === m.model.modelId && v.model_name === m.model.rawModelId && v.base_url.replace(/\/+$/u, "") === m.model.endpoint);
  if (!model) throw Error("Frozen model registration unavailable");
  const { createProviderRuntime } = await import("../providers/openai-compatible.js");
  const provider = createProviderRuntime(model.base_url, model.api_key, { reasoningEffort: "high", maxOutputTokens: 32768 }, model.model_name, "deepseek");
  const gate = new MemoryRequestGate(path.join(root, "requests"), 2), budget = new RecallBudget();
  const cancel = () => gate.stop("cancelled"); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const cases = new Map([...await readJson<Case[]>(path.join(root, "cases.json")), ...await readJson<Case[]>(path.join(root, "smoke.json"))].map(c => [c.question.id, c]));
  const refs = new Map((await readJson<MemoryReference[]>(path.join(root, "references.json"))).map(r => [r.id, r]));
  const templates = await readJson<string[]>(path.join(root, "judge-templates.json"));
  const planned = await readJson<PlanItem[]>(path.join(root, "plan.json"));
  const rows: Result[] = [];
  const client = (key: string, phase: "answer" | "judge"): ResponsesClientLike => ({ responses: {
    create: (params, options) => recallRequest(gate, provider, budget, key, phase, params, options, () => verifyRecallInputs(root)),
  } });
  const sample = async (item: PlanItem): Promise<void> => {
    const row: Result = { ...item, status: "skipped", correct: null }; rows.push(row);
    if (gate.stopReason) return;
    row.status = "failed"; const started = performance.now();
    try {
      const c = cases.get(item.questionId)!;
      row.hypothesis = await answerMemoryQuestion(client(item.key, "answer"), model.model_name, c.question.question, c.question.date, c.contexts[item.arm]!.text, gate.controller.signal);
      const response = await client(item.key, "judge").responses.create({ model: model.model_name, store: false, input: judgePrompt(templates, c.question as MemoryQuestion, refs.get(item.questionId)!.answer, row.hypothesis), reasoning: { effort: "none" }, max_output_tokens: 16 }, { signal: gate.controller.signal, maxRetries: 0, timeout: 30000 });
      assertCompletedModelResponse(response, "doctor"); row.correct = parseJudgeLabel(response.output_text); row.status = "completed";
      if (item.smoke && !row.correct) gate.stop("smoke_failed");
    } catch (error) {
      row.failure = error instanceof Error ? error.name : "unknown";
      gate.stop(item.smoke ? "smoke_failed" : "sample_failed");
    } finally {
      row.durationMs = performance.now() - started;
      try { await writeJson(path.join(root, "results", `${digest(item.key)}.json`), row, true); } catch (error) {
        gate.failStorage(error);
        // oxlint-disable-next-line no-unsafe-finally -- A result that cannot be persisted cannot complete successfully.
        throw error;
      }
      console.log(JSON.stringify({ ...item, status: row.status, correct: row.correct, knownTokens: budget.spent, stopReason: gate.stopReason ?? null }));
    }
  };
  try {
    for (const item of planned.filter(p => p.smoke)) await sample(item);
    const publicPlan = planned.filter(p => !p.smoke); let cursor = 0;
    const worker = async () => { while (cursor < publicPlan.length) await sample(publicPlan[cursor++]!); };
    await Promise.allSettled([worker(), worker()]);
  } finally {
    try { await provider.dispose?.(); } catch { gate.stop("cleanup_failed"); }
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    try { await verifyRecallInputs(root); } catch { gate.stop("identity_changed"); }
    await writeJson(path.join(root, "run-state.json"), { stoppedAt: new Date().toISOString(), stopReason: gate.stopReason ?? null, knownTokens: budget.spent, peak: gate.peak }, true);
    await report(root);
  }
}

async function report(root: string): Promise<void> {
  const m = await verifyRecallInputs(root, false), plan = await readJson<PlanItem[]>(path.join(root, "plan.json"));
  const cases = await readJson<Case[]>(path.join(root, "cases.json")), audit = await readJson<EvidenceAudit[]>(path.join(root, "audit.json"));
  const offline = cases.map(c => {
    const a = audit.find(a => a.questionId === c.question.id)!;
    return { questionId: c.question.id, query: c.question.question, strategies: strategies.filter(s => c.contexts[s]).map(strategy => {
      const context = c.contexts[strategy]!, baseline = c.contexts.current;
      const necessary = a.necessary.filter(id => context.ids.includes(id));
      return { strategy, bodyChars: context.bodyChars, facts: context.ids.length, sources: context.sources.length,
        evidence: a.necessary.map(id => {
          const f = c.facts.find(f => f.id === id)!;
          const ranked = context.semantic?.ranked.find(r => r.id === id);
          return { id, statement: f.lesson, quote: f.fact.quote, speaker: f.fact.speaker, messageTime: f.fact.messageTime, eventTime: f.fact.eventTime,
            source: f.fact.source?.sessionId ?? f.fact.sessionId, present: context.ids.includes(id), baseline: baseline.ids.includes(id),
            score: ranked?.score, rank: ranked ? context.semantic!.ranked.indexOf(ranked) + 1 : null };
        }),
        necessary, gainedNecessary: necessary.filter(id => !baseline.ids.includes(id)), lostNecessary: a.necessary.filter(id => baseline.ids.includes(id) && !context.ids.includes(id)),
        semantic: context.semantic,
        gainedSources: context.sources.filter(id => !baseline.sources.includes(id)), lostSources: baseline.sources.filter(id => !context.sources.includes(id)),
        anchorVisible: a.anchor ? context.ids.includes(a.anchor) && context.text.includes(c.facts.find(f => f.id === a.anchor)!.fact.quote) : null,
        exactDuplicateChars: context.ids.reduce((result, id, i) => { const f = c.facts.find(f => f.id === id)!;
          return result + (context.ids.slice(0, i).some(previous => { const p = c.facts.find(f => f.id === previous)!;
            return p.fact.sessionId === f.fact.sessionId && p.fact.sourceId === f.fact.sourceId && p.fact.sourceMessageHash === f.fact.sourceMessageHash && p.fact.speaker === f.fact.speaker && p.fact.messageTime === f.fact.messageTime && p.fact.eventTime === f.fact.eventTime && p.lesson === f.lesson && p.fact.quote === f.fact.quote;
          }) ? memoryEntryLine(f).length + 1 : 0); }, 0) };
    }) };
  });
  const reportRoot = path.join(root, `report-${randomUUID()}`); await mkdir(reportRoot);
  await writeJson(path.join(reportRoot, "offline.json"), { selection: chooseRecallCandidate(cases, audit, m.selectionPolicy), offline, fullStores: cases.length, partial: m.partial, extractionRequests: 0 }, true);
  let state: { stopReason: string | null; peak: number };
  try { state = await readJson(path.join(root, "run-state.json")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (await optionalJson(path.join(root, "started.json")) || (await jsonFiles(path.join(root, "requests"))).length) throw Error("Started experiment lacks settlement; cannot report zero model calls");
    await import("node:fs/promises").then(fs => fs.writeFile(path.join(reportRoot, "report.md"), `# Memory 本地召回消融\n\n完整事实库 ${cases.length}，部分库 ${m.partial.join(", ")} 单列。按冻结策略 ${m.selectionPolicy ?? "evidence-gain"} 及证据表评估。\n\n${JSON.stringify(chooseRecallCandidate(cases, audit, m.selectionPolicy), null, 2)}\n\n未运行真实模型问答，模型及提取请求均零。修复验收不代表相对 BM25 的必要证据增益。来源数量不是必要证据覆盖。逐题得失、锚点、字符及重复占用见 offline.json。\n`, { flag: "wx" }));
    console.log(JSON.stringify({ reportRoot, liveRun: false, modelRequests: 0 })); return;
  }
  const results = await jsonFiles(path.join(root, "results"));
  const saved = await Promise.all(results.map(f => readJson<Result>(f)));
  const rows = plan.map(p => saved.find(r => r.key === p.key) ?? { ...p, status: "skipped" as const, correct: null });
  const records = await Promise.all((await jsonFiles(path.join(root, "requests"))).map(f => readJson<MemoryRequestRecord>(f)));
  const usage = (values: MemoryRequestRecord[]) => ({ requests: values.length, input: values.reduce((n, r) => n + r.usage.inputTokens, 0), output: values.reduce((n, r) => n + r.usage.outputTokens, 0), unknown: values.filter(r => !r.usage.complete).length, pending: values.filter(r => r.state !== "settled" || r.openRequests !== 0).length });
  const allUsage = usage(records), publicRows = rows.filter(r => !r.smoke);
  const arms = ["current", m.selected!] as const;
  const groups = arms.map(arm => { const values = publicRows.filter(r => r.arm === arm); return { arm, planned: values.length, completed: values.filter(r => r.status === "completed").length, correct: values.filter(r => r.correct).length, failed: values.filter(r => r.status === "failed").length, skipped: values.filter(r => r.status === "skipped").length }; });
  const pairs = publicRows.filter(r => r.arm === "current").map(a => [a, publicRows.find(b => b.questionId === a.questionId && b.arm === m.selected)!]);
  const regressions = pairs.filter(([a, b]) => a!.correct === true && b!.correct !== true).map(([a]) => a!.questionId);
  const both = pairs.filter(p => p.every(r => r?.status === "completed"));
  const answerUsage = arms.map(arm => usage(records.filter(r => r.phase === "answer" && both.some(p => p.some(v => v!.arm === arm && r.key === `${v!.key}:answer`)))));
  const cost = answerUsage.map(u => u.input + u.output), ratio = cost[0]! > 0 ? cost[1]! / cost[0]! : null;
  const complete = rows.every(r => r.status === "completed") && allUsage.unknown === 0 && allUsage.pending === 0 && !state.stopReason;
  const adopt = complete && groups[1]!.correct > groups[0]!.correct && regressions.length === 0 && ratio !== null && ratio <= 1.5;
  const summary = { groups, rows, usage: allUsage, phases: { answer: usage(records.filter(r => r.phase === "answer")), judge: usage(records.filter(r => r.phase === "judge")) },
    extractionRequests: records.filter(r => r.phase === "extract").length, stopReason: state.stopReason, peak: state.peak, complete, selected: m.selected,
    bothCompletedPairs: both.length, regressions, pairedAnswerTokens: cost, pairedAnswerTokenRatio: ratio, adoptionEligible: adopt,
    parentKnownTokens: m.parentKnownTokens, parentUnknown: m.parentUnknown, selectionPolicy: m.selectionPolicy ?? "evidence-gain", formalIntervals: null, humanReviewed: false };
  // Reports are append-only snapshots, including repeated read-only report commands.
  await writeJson(path.join(reportRoot, "report.json"), summary, true);
  await import("node:fs/promises").then(fs => fs.writeFile(path.join(reportRoot, "report.md"), `# Memory 召回配对实验\n\n${groups.map(g => `${g.arm}: ${g.correct}/${g.planned} 正确，${g.completed} 完成，${g.failed} 失败，${g.skipped} 跳过。`).join("\n\n")}\n\n本批已知 input/output: ${allUsage.input}/${allUsage.output}；unknown ${allUsage.unknown}，pending ${allUsage.pending}。回答 token 比 ${ratio}；回退题 ${regressions.join(", ") || "无"}。采用条件满足：${adopt}。\n\n固定开发题、单次重复、自动评分；不报告正式区间。历史建库成本与旧 unknown 单列，零重新提取。\n`, { flag: "wx" }));
  console.log(JSON.stringify({ reportRoot, ...summary, rows: undefined }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, arg, parent, child, audit, encoderDirectory] = process.argv.slice(2);
  if (!arg || !path.isAbsolute(arg)) throw Error("Supply an absolute new evidence root");
  if (command === "prepare-bge-model") await prepareSemanticAssets(path.resolve(arg), BGE_BASE_MODEL);
  else if (command === "prepare-bge" && parent && child && audit && encoderDirectory) await prepare(arg, path.resolve(parent), path.resolve(child), path.resolve(audit), "semantic-model-gain", path.resolve(encoderDirectory));
  else if (command === "prepare-model") await prepareSemanticAssets(path.resolve(arg));
  else if (command === "prepare-semantic" && parent && child && audit && encoderDirectory) await prepare(arg, path.resolve(parent), path.resolve(child), path.resolve(audit), "semantic-gain", path.resolve(encoderDirectory));
  else if (command === "prepare" && parent && child && audit) await prepare(arg, path.resolve(parent), path.resolve(child), path.resolve(audit));
  else if (command === "prepare-protected" && parent && child && audit) await prepare(arg, path.resolve(parent), path.resolve(child), path.resolve(audit), "preservation-repair");
  else if (command === "preflight") await preflight(arg);
  else if (command === "run" && parent === "--live") await run(arg);
  else if (command === "report") await report(arg);
  else throw Error("Use prepare-bge-model <new-model-root>, prepare-bge <new-root> <parent> <child> <audit> <model-root>, prepare-model <new-model-root>, prepare-semantic <new-root> <parent> <child> <audit> <model-root>, prepare <new-root> <parent> <child> <audit>, preflight <root>, run <root> --live, or report <root>");
}
