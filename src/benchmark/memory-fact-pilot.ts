/** Reviewed 12-question pilot. This entry cannot start the 120-question holdout or full batch. */
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createProviderRuntime } from "../providers/openai-compatible.js";
import type { ResponsesClientLike } from "../agent/model-protocol.js";
import { memoryIdentity, MEMORY_REPOSITORY } from "./memory-campaign.js";
import { createFactMemoryAdapter, READER_INSTRUCTIONS, answerMemoryQuestion } from "./memory-adapters.js";
import { FACT_EXTRACTION_INSTRUCTIONS } from "../memory/facts.js";
import { bm25History, digest, judgePrompt, parseJudgeLabel, QUESTION_TYPES, type MemoryQuestion, type MemoryReference } from "./memory-data.js";
import { MemoryRequestGate, optionalJson, readJson, writeJson, type MemoryRequestRecord } from "./memory-evidence.js";
import { assertCompletedModelResponse } from "../providers/capabilities.js";

const budget = 2_000_000;
interface PilotManifest {
  identity: Awaited<ReturnType<typeof memoryIdentity>>;
  files: Record<string, string>;
  model: { modelId: string; rawModelId: string; endpoint: string; responsesProfile: "deepseek" };
  planned: Array<{ key: string; questionId: string; arm: "fact-memory" | "bm25-history" }>;
  smokeIds: string[]; createdAt: string; budget: number;
  continuation?: { parentRoot: string; files: Record<string, string>; executionKeys: string[]; retainedRows: Row[]; smoke: Row[]; parentKnownTokens: number; parentUnknown: number };
}
interface Row { key: string; questionId: string; arm: string; status: "completed" | "failed" | "skipped"; correct: boolean | null; failure?: string; hypothesis?: string; retrieval?: unknown; retainedFrom?: string }

export function skippedPilotKeys(planned: PilotManifest["planned"], rows: Row[]): string[] {
  if (new Set(rows.map(r => r.key)).size !== planned.length || rows.length !== planned.length) throw Error("Parent plan coverage differs");
  return planned.flatMap(item => {
    const row = rows.find(r => r.key === item.key);
    if (!row || row.questionId !== item.questionId || row.arm !== item.arm || !["completed", "failed", "skipped"].includes(row.status)) throw Error("Parent result identity differs");
    return row.status === "skipped" ? [item.key] : [];
  });
}

async function prepareSkipped(root: string, parentRoot: string): Promise<void> {
  const files: Record<string, string> = {};
  const frozen = async <T>(name: string): Promise<T> => { const bytes = await readFile(path.join(parentRoot, name)); files[name] = digest(bytes); return JSON.parse(bytes.toString("utf8")) as T; };
  const parent = await frozen<PilotManifest>("manifest.json");
  if (parent.continuation) throw Error("Nested pilot continuation requires separate review");
  const report = await frozen<{ rows: Row[]; smoke: Row[]; knownTokens: number }>("report.json");
  await frozen("run-state.json");
  if (parent.planned.length !== 24 || parent.smokeIds.length !== 6 || report.smoke.length !== 6 || report.smoke.some(r => r.status !== "completed" || r.correct !== true)) throw Error("Parent smoke incomplete");
  let known = 0, unknown = 0;
  for (const name of await readdir(path.join(parentRoot, "requests"))) if (name.endsWith(".json")) {
    const record = await frozen<MemoryRequestRecord>(`requests/${name}`);
    if (record.state !== "settled" || record.openRequests !== 0) throw Error("Parent has unresolved requests");
    known += record.usage.inputTokens + record.usage.outputTokens;
    if (!record.usage.complete) {
      if (!report.rows.some(r => r.status === "failed" && record.key.startsWith(r.key + ":"))) throw Error("Unknown usage is not bound to a closed failed item");
      unknown++;
    }
  }
  if (known !== report.knownTokens) throw Error("Parent accounting differs");
  const executionKeys = skippedPilotKeys(parent.planned, report.rows);
  if (!executionKeys.length) throw Error("No skipped items");
  for (const [name, hash] of Object.entries(parent.files)) {
    const bytes = await readFile(path.join(parentRoot, name)); if (digest(bytes) !== hash) throw Error("Parent inputs changed");
    files[name] = hash; await writeJson(path.join(root, name), JSON.parse(bytes.toString("utf8")), true);
  }
  const m: PilotManifest = { ...parent, identity: await memoryIdentity(), createdAt: new Date().toISOString(), budget,
    continuation: { parentRoot, files, executionKeys, retainedRows: report.rows.filter(r => r.status !== "skipped").map(r => ({ ...r, retainedFrom: parentRoot })), smoke: report.smoke, parentKnownTokens: known, parentUnknown: unknown } };
  await writeJson(path.join(root, "manifest.json"), m, true);
  await writeJson(path.join(root, "manifest-hash.json"), { sha256: digest(JSON.stringify(m)) }, true);
}

export function selectFactPilot(questions: MemoryQuestion[]): MemoryQuestion[] {
  const anchors = ["0862e8bf", "16c90bf4", "18dcd5a5"];
  return QUESTION_TYPES.flatMap(type => {
    const group = questions.filter(q => q.type === type).sort((a, b) => digest(`16716:${a.id}`).localeCompare(digest(`16716:${b.id}`)));
    const selected = anchors.flatMap(id => group.find(q => q.id === id) ?? []);
    if (selected.length > 2) throw Error("Anchor/category quota differs");
    selected.push(...group.filter(q => !selected.includes(q)).slice(0, 2 - selected.length));
    if (selected.length !== 2) throw Error("Pilot requires two questions per type");
    return selected;
  });
}

async function prepare(root: string, preparation: string, baseline: string): Promise<void> {
  const stop = await readJson<{ reason: string; processExited: boolean }>(path.join(path.dirname(path.dirname(preparation)), "memory-analysis/go-flash-native-015/user-stop-receipt.json"));
  if (stop.reason !== "explicit_user_stop" || !stop.processExited) throw Error("Original batch is not sealed as stopped");
  const receipt = await readJson<{ files: Record<string, string> }>(path.join(preparation, "receipt.json"));
  const frozen = async <T>(name: string) => {
    const bytes = await readFile(path.join(preparation, name));
    if (digest(bytes) !== receipt.files[name]) throw Error("Preparation hash mismatch");
    return JSON.parse(bytes.toString("utf8")) as T;
  };
  const metadata = await frozen<Array<Omit<MemoryQuestion, "history">>>("development/questions.json");
  const builds = await frozen<Array<Pick<MemoryQuestion, "historyHash" | "history">>>("development/build-inputs.json");
  const refs = await frozen<MemoryReference[]>("grader/development-references.json");
  const questions = selectFactPilot(metadata.map((q, i) => ({ ...q, history: builds[i]!.history })));
  const fixturePath = path.join(MEMORY_REPOSITORY, "tests/fixtures/memory-fact-preservation.json");
  const fixture = await readJson<{ tasks: Array<{ id: string; question: string; questionDate: string; history: MemoryQuestion["history"]; expected: { answer: string | null; evidenceEventIds: string[] } }> }>(fixturePath);
  const smokeIds = ["detail-cat-en", "detail-beer", "detail-count", "update-current", "cross-two-counts", "insufficient-no-name"];
  const smokeQuestions: MemoryQuestion[] = smokeIds.map(id => {
    const t = fixture.tasks.find(v => v.id === id)!;
    const history = t.history.map(s => ({ id: s.id, date: s.date, messages: s.messages.map(m => ({ role: m.role, content: m.content })) }));
    return { id: `smoke-${id}${t.expected.answer === null ? "_abs" : ""}`, type: "single-session-user", question: t.question, date: t.questionDate, history, historyHash: digest(JSON.stringify(history)) };
  });
  const smokeReferences = smokeIds.map((id, i) => ({ id: smokeQuestions[i]!.id, answer: fixture.tasks.find(t => t.id === id)!.expected.answer ?? "Not enough information is available to answer.", evidence: [] }));
  const config = await readJson<{ config: PilotManifest["model"] }>(path.join(baseline, "manifest.json"));
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries({ "history.json": [...smokeQuestions, ...questions], "references.json": [...smokeReferences, ...refs.filter(r => questions.some(q => q.id === r.id))],
    "judge-templates.json": await readJson(path.join(baseline, "judge-templates.json")), "prompts.json": { extraction: FACT_EXTRACTION_INSTRUCTIONS, reader: READER_INSTRUCTIONS, extractionOutput: 4096, reasoning: "none", windowChars: 24000, readerBodyChars: 8000 } })) {
    await writeJson(path.join(root, name), value, true); files[name] = digest(await readFile(path.join(root, name)));
  }
  const m: PilotManifest = { identity: await memoryIdentity(), files, model: { modelId: config.config.modelId, rawModelId: config.config.rawModelId, endpoint: config.config.endpoint, responsesProfile: "deepseek" },
    planned: questions.flatMap((q, i) => (i % 2 ? ["bm25-history", "fact-memory"] as const : ["fact-memory", "bm25-history"] as const).map(arm => ({ key: `${q.id}:1:${arm}`, questionId: q.id, arm }))),
    smokeIds: smokeQuestions.map(q => q.id), budget, createdAt: new Date().toISOString() };
  await writeJson(path.join(root, "manifest.json"), m, true);
  await writeJson(path.join(root, "manifest-hash.json"), { sha256: digest(JSON.stringify(m)) }, true);
  await writeJson(path.join(root, "source-provenance.json"), { preparation, baseline, baselineResultsNotReused: true, candidateDefaultPromoted: false }, true);
}

async function run(root: string): Promise<void> {
  const m = await readJson<PilotManifest>(path.join(root, "manifest.json"));
  if (m.budget !== budget || m.planned.length !== 24 || m.smokeIds.length !== 6) throw Error("Unreviewed pilot configuration");
  if (digest(JSON.stringify(m)) !== (await readJson<{ sha256: string }>(path.join(root, "manifest-hash.json"))).sha256) throw Error("Manifest changed");
  if (JSON.stringify(m.identity) !== JSON.stringify(await memoryIdentity())) throw Error("Candidate identity changed");
  for (const [name, hash] of Object.entries(m.files)) if (digest(await readFile(path.join(root, name))) !== hash) throw Error("Pilot inputs changed");
  if (m.continuation) {
    for (const [name, hash] of Object.entries(m.continuation.files)) if (digest(await readFile(path.join(m.continuation.parentRoot, name))) !== hash) throw Error("Parent evidence changed");
    const parentReport = await readJson<{ rows: Row[] }>(path.join(m.continuation.parentRoot, "report.json"));
    if (JSON.stringify(skippedPilotKeys(m.planned, parentReport.rows)) !== JSON.stringify(m.continuation.executionKeys)) throw Error("Skipped execution membership changed");
  }
  await writeJson(path.join(root, "started.json"), { at: new Date().toISOString(), tokenBudget: budget }, true);
  const { ModelRegistry } = await import("../storage/model-registry.js"), { SystemAuthStorage } = await import("../storage/auth-storage.js");
  const model = (await new ModelRegistry({ authStorage: new SystemAuthStorage() }).resolveAll()).available.find(v => v.id === m.model.modelId && v.model_name === m.model.rawModelId && v.base_url.replace(/\/+$/u, "") === m.model.endpoint);
  if (!model) throw Error("Frozen Go model registration unavailable");
  const provider = createProviderRuntime(model.base_url, model.api_key, { reasoningEffort: "high", maxOutputTokens: 32768 }, model.model_name, "deepseek");
  const gate = new MemoryRequestGate(path.join(root, "requests"), 2);
  const cancel = () => gate.stop("cancelled"); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const accounted: MemoryRequestRecord[] = [];
  let spent = 0, reserved = 0; const rows: Row[] = [...m.continuation?.retainedRows ?? []], smoke: Row[] = [...m.continuation?.smoke ?? []];
  const client = (prefix: string, phase: string): ResponsesClientLike => {
    let index = 0;
    return { responses: { async create(params, options) {
      const key = `${prefix}:${phase}:${index++}`;
      // UTF-8 bytes bound text tokenization conservatively; reserve output and protocol overhead.
      const reservation = Buffer.byteLength(JSON.stringify(params), "utf8") + Number(params.max_output_tokens ?? 32768) + 4096;
      if (spent + reserved + reservation > budget) { gate.stop("budget_exhausted"); throw Error("Pilot budget exhausted before request admission"); }
      reserved += reservation;
      try { const response = await gate.request(provider, key, phase, params, options); if (gate.stopReason) throw Error(gate.stopReason); return response; }
      finally {
        const record = await optionalJson<MemoryRequestRecord>(path.join(root, "requests", `${digest(key)}.json`));
        if (record) accounted.push(record);
        spent += record ? record.usage.inputTokens + record.usage.outputTokens : 0; reserved -= reservation;
      }
    } } };
  };
  const questions = new Map((await readJson<MemoryQuestion[]>(path.join(root, "history.json"))).map(q => [q.id, q]));
  const refs = new Map((await readJson<MemoryReference[]>(path.join(root, "references.json"))).map(r => [r.id, r]));
  const templates = await readJson<string[]>(path.join(root, "judge-templates.json"));
  const sample = async (item: PilotManifest["planned"][number], smokeRun = false): Promise<Row> => {
    const row: Row = { ...item, status: "skipped", correct: null };
    if (gate.stopReason) return row;
    const q = questions.get(item.questionId)!, directory = path.join(root, "samples", digest(item.key));
    const signal = AbortSignal.any([gate.controller.signal, AbortSignal.timeout(7200000)]);
    const adapter = createFactMemoryAdapter(directory, model.model_name, client(item.key, "extract"), item.key);
    try {
      row.status = "failed";
      let retrieval;
      if (item.arm === "fact-memory") { await adapter.build(q.history, signal); retrieval = await adapter.retrieve(q.question); }
      else retrieval = { ...bm25History(q.history, q.question), entryIds: [], active: 0, review: 0, archived: 0, clippedChars: 0 };
      if (gate.stopReason) throw Error(gate.stopReason);
      row.retrieval = retrieval;
      row.hypothesis = await answerMemoryQuestion(client(item.key, "answer"), model.model_name, q.question, q.date, retrieval.text, signal);
      await writeJson(path.join(directory, "answer.json"), { hypothesis: row.hypothesis, retrieval }, true);
      const r = await client(item.key, "judge").responses.create({ model: model.model_name, store: false,
        input: judgePrompt(templates, q, refs.get(q.id)!.answer, row.hypothesis), reasoning: { effort: "none" }, max_output_tokens: 16 },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), timeout: 30000 });
      assertCompletedModelResponse(r, "doctor"); row.correct = parseJudgeLabel(r.output_text); row.status = "completed";
      if (smokeRun && !row.correct) gate.stop("smoke_failed");
    } catch (error) { row.failure = error instanceof Error ? error.name : "unknown"; if (smokeRun) gate.stop("smoke_failed"); }
    finally { await adapter.dispose(); await writeJson(path.join(directory, "result.json"), row, true); }
    console.log(JSON.stringify({ ...item, status: row.status, correct: row.correct, knownTokens: spent, stopReason: gate.stopReason ?? null }));
    return row;
  };
  try {
    if (!m.continuation) for (const id of m.smokeIds) smoke.push(await sample({ key: `smoke:${id}`, questionId: id, arm: "fact-memory" }, true));
    const execution = m.continuation ? m.planned.filter(item => m.continuation!.executionKeys.includes(item.key)) : m.planned;
    let cursor = 0;
    const worker = async () => { while (cursor < execution.length) { const item = execution[cursor++]!; rows.push(await sample(item)); } };
    await Promise.all([worker(), worker()]);
  } finally {
    try { await provider.dispose?.(); } catch { gate.stop("cleanup_failed"); }
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    const phases = Object.fromEntries(["extract", "answer", "judge"].map(phase => {
      const records = accounted.filter(r => r.phase === phase);
      return [phase, { requests: records.length, knownTokens: records.reduce((n, r) => n + r.usage.inputTokens + r.usage.outputTokens, 0),
        unknown: records.filter(r => !r.usage.complete).length, pending: records.filter(r => r.state !== "settled" || r.openRequests !== 0).length }];
    }));
    const paired = m.planned.filter(i => i.arm === "fact-memory").map(i => [rows.find(r => r.questionId === i.questionId && r.arm === "fact-memory"), rows.find(r => r.questionId === i.questionId && r.arm === "bm25-history")]);
    const common = paired.filter(pair => pair.every(r => r?.status === "completed"));
    const summary = { phaseUsage: phases, bothCompleted: { pairs: common.length, factCorrect: common.filter(p => p[0]?.correct === true).length, bm25Correct: common.filter(p => p[1]?.correct === true).length }, plannedPublic: 24, plannedSmoke: 6, rows, smoke, knownTokens: spent, tokenBudget: budget,
      ...(m.continuation ? { continuation: { parentRoot: m.continuation.parentRoot, executedPlanItems: m.continuation.executionKeys.length, parentKnownTokens: m.continuation.parentKnownTokens, parentUnknown: m.continuation.parentUnknown, cumulativeKnownTokens: m.continuation.parentKnownTokens + spent, mixedSourceIdentities: true } } : {}),
      stopReason: gate.stopReason ?? null, peakConcurrentRequests: gate.peak, formalIntervals: null, humanReviewed: false,
      groups: Object.fromEntries(["fact-memory", "bm25-history"].map(arm => { const values = rows.filter(r => r.arm === arm); return [arm, { planned: 12, completed: values.filter(r => r.status === "completed").length, failed: values.filter(r => r.status === "failed").length, skipped: values.filter(r => r.status === "skipped").length, correct: values.filter(r => r.correct === true).length }]; })) };
    await writeJson(path.join(root, "report.json"), summary, true);
    await writeJson(path.join(root, "run-state.json"), { stoppedAt: new Date().toISOString(), stopReason: gate.stopReason ?? null, knownTokens: spent }, true);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, rootArg, prepArg, baselineArg] = process.argv.slice(2);
  if (!rootArg || !path.isAbsolute(rootArg)) throw Error("Supply a new absolute evidence root");
  if (command === "prepare" && prepArg && baselineArg) await prepare(rootArg, path.resolve(prepArg), path.resolve(baselineArg));
  else if (command === "prepare-skipped" && prepArg) await prepareSkipped(rootArg, path.resolve(prepArg));
  else if (command === "run" && process.argv.includes("--live")) await run(rootArg);
  else throw Error("Use prepare <new-root> <preparation-root> <baseline-root> or run <root> --live");
}
