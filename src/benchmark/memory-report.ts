import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { MEMORY_ARMS, QUESTION_TYPES, digest, type MemoryReference, type MemoryQuestion } from "./memory-data.js";
import { jsonFiles, optionalJson, readJson, writeJson, type MemoryRequestRecord } from "./memory-evidence.js";
import type { MemoryCampaignManifest, MemorySampleResult } from "./memory-campaign.js";
import type { MemoryPublicContinuation } from "./memory-public-continuation.js";
import type { MemoryContinuation } from "./memory-continuation.js";

export function memoryBootstrap(rows: MemorySampleResult[], baseline: string, complete: boolean) {
  const clusters = new Map<string, number[]>();
  const index = new Map(rows.map(row => [`${row.questionId}:${row.repetition}:${row.arm}`, row]));
  for (const row of rows.filter(row => row.arm === "learned-memory")) {
    const other = index.get(`${row.questionId}:${row.repetition}:${baseline}`);
    if (row.correct === null || !other || other.correct === null) return { pairedDifference: null, interval95: null, clusters: clusters.size };
    const cluster = clusters.get(row.historyHash) ?? []; cluster.push(Number(row.correct) - Number(other.correct)); clusters.set(row.historyHash, cluster);
  }
  if (!complete || clusters.size < 2) return { pairedDifference: null, interval95: null, clusters: clusters.size };
  const values = [...clusters.values()], means: number[] = []; let seed = 16716;
  for (let i = 0; i < 2000; i++) {
    let total = 0, count = 0;
    for (let j = 0; j < values.length; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const sample = values[Math.floor(seed / 4294967296 * values.length)]!; total += sample.reduce((a, b) => a + b, 0); count += sample.length; }
    means.push(total / count);
  }
  means.sort((a, b) => a - b); const all = values.flat();
  return { pairedDifference: all.reduce((a, b) => a + b, 0) / all.length, interval95: [means[49]!, means[1949]!] as [number, number], clusters: clusters.size };
}

export async function memoryReport(root: string): Promise<void> {
  const manifest = await readJson<MemoryCampaignManifest>(path.join(root, "manifest.json"));
  const continuation = await optionalJson<MemoryContinuation>(path.join(root, "continuation.json"));
  const publicContinuation = await optionalJson<MemoryPublicContinuation>(path.join(root, "public-continuation.json"));
  const continueUnrun = manifest.executionPolicy === "continue-unrun";
  const plannedKeys = new Set(manifest.planned.map(item => item.key));
  const rows: MemorySampleResult[] = [], skipped = [];
  for (const item of manifest.planned) {
    const row = await optionalJson<MemorySampleResult>(path.join(root, "samples", item.key, "result.json"));
    if (row) rows.push(row); else skipped.push({ ...item, status: "skipped", reason: "not_settled" });
  }
  const requests: MemoryRequestRecord[] = [];
  for (const file of await jsonFiles(path.join(root, "requests"))) requests.push(await readJson<MemoryRequestRecord>(file));
  const rollup = (input: MemoryRequestRecord[]) => ({ records: input.length, requests: input.flatMap(r => r.usage.attempts).filter(a => a.status !== "rejected").length, rejectedRequests: input.flatMap(r => r.usage.attempts).filter(a => a.status === "rejected").length, inputTokens: input.reduce((s, r) => s + r.usage.inputTokens, 0), outputTokens: input.reduce((s, r) => s + r.usage.outputTokens, 0), reasoningTokens: input.reduce((s, r) => s + r.usage.reasoningTokens, 0), complete: input.every(r => r.state === "settled" && r.usage.complete && r.openRequests === 0),
    cachedInputTokens: input.flatMap(r => r.usage.attempts).some(a => a.usage?.cached_input_tokens !== undefined) ? input.flatMap(r => r.usage.attempts).reduce((s, a) => s + (a.usage?.cached_input_tokens ?? 0), 0) : null,
    unknownRequests: input.filter(r => !r.usage.complete || r.state !== "settled").map(r => ({ key: r.key, state: r.state, attempts: r.usage.attempts })) });
  const publicRequests = [...(publicContinuation?.requests ?? []), ...requests.filter(r => plannedKeys.has(r.key.split(":")[0]!))];
  const publicUsage = rollup(publicRequests);
  const usage = rollup(requests), state = await optionalJson<{ stopReason: string | null; storageFailure?: { stage: string; code: string } }>(path.join(root, "run-state.json"));
  const coding = await optionalJson<{ records: unknown[]; skipped: unknown[]; knownTokens: number; stopReason: string | null }>(path.join(root, "coding/live-result.json"));
  const codingPlan = await optionalJson<{ planned: Array<Record<string, unknown>> }>(path.join(root, "coding/plan.json"));
  const codingRecords = (coding?.records ?? []) as Array<Record<string, unknown> & { result: { status: string; usage?: { complete: boolean } } }>;
  const codingStatuses = (codingPlan?.planned ?? []).map(item => {
    const record = codingRecords.find(row => ["sequence", "arm", "repetition", "stage"].every(key => row[key] === item[key]));
    return { ...item, status: record ? record.result.status === "passed" ? "completed" : "failed" : "skipped", ...(record ? { result: record.result } : { reason: coding?.stopReason ?? "not_settled" }) };
  });
  const executionComplete = rows.length === manifest.planned.length && codingStatuses.length === 72 && codingStatuses.every(row => row.status !== "skipped") && !state?.stopReason;
  const complete = !continueUnrun && rows.length === manifest.planned.length && rows.every(r => r.status === "completed") && usage.complete && !state?.stopReason;
  const summary = (arm: string, filter: (r: MemorySampleResult) => boolean = () => true) => {
    const selected = rows.filter(r => r.arm === arm && filter(r)), correct = selected.filter(r => r.correct === true).length;
    return { settled: selected.length, completed: selected.filter(r => r.status === "completed").length, failed: selected.filter(r => r.status === "failed").length, correct, accuracy: selected.length ? correct / selected.length : null };
  };
  const plannedByKey = new Map(manifest.planned.map(item => [item.key, item]));
  const groups = MEMORY_ARMS.map(arm => {
    const selected = rows.filter(r => r.arm === arm), planned = manifest.planned.filter(r => r.arm === arm).length;
    const armRequests = publicRequests.filter(r => plannedByKey.get(r.key.split(":")[0]!)?.arm === arm);
    const cost = rollup(armRequests), executionCost = rollup(armRequests.filter(r => r.phase !== "judge")), scoringCost = rollup(armRequests.filter(r => r.phase === "judge"));
    const correct = selected.filter(r => r.correct).length, total = executionCost.inputTokens + executionCost.outputTokens;
    return { arm, planned, ...summary(arm), accuracyOverPlanned: correct / planned, cost, executionCost, scoringCost, tokensPerPlannedAnswer: total / planned, tokensPerCorrectAnswer: correct ? total / correct : null,
      emptyRetrievals: selected.filter(r => r.retrieval && !r.retrieval.text).length, clippedChars: selected.reduce((s, r) => s + (r.retrieval?.clippedChars ?? 0), 0),
      memoryCounts: selected.map(r => ({ key: r.key, active: r.retrieval?.active ?? null, review: r.retrieval?.review ?? null, archived: r.retrieval?.archived ?? null })),
      categories: Object.fromEntries(QUESTION_TYPES.map(type => [type, summary(arm, r => r.type === type)])), abstention: summary(arm, r => r.questionId.includes("_abs")), repetitions: [1, 2, 3].map(repetition => ({ repetition, ...summary(arm, r => r.repetition === repetition) })),
      queryLatencyMs: publicRequests.filter(r => r.phase === "answer" && plannedByKey.get(r.key.split(":")[0]!)?.arm === arm).map(r => r.durationMs ?? null) };
  });
  const references = new Map((await readJson<MemoryReference[]>(path.join(root, "references.json"))).map(r => [r.id, r]));
  const questions = new Map((await readJson<MemoryQuestion[]>(path.join(root, "history.json"))).map(q => [q.id, q]));
  const coverage = rows.map(row => { const gold = references.get(row.questionId)!.evidence, found = row.retrieval?.sources ?? []; return { key: row.key, evidenceSessions: gold.length, recalledSessions: gold.filter(id => found.includes(id)).length, recall: gold.length ? gold.filter(id => found.includes(id)).length / gold.length : null }; });
  const blind = QUESTION_TYPES.flatMap(type => rows.filter(r => r.type === type && r.hypothesis !== undefined).sort((a, b) => digest(`16716:${a.key}`).localeCompare(digest(`16716:${b.key}`))).slice(0, 10).map(r => ({ blindId: digest(r.key).slice(0, 20), question: questions.get(r.questionId)!.question, reference: references.get(r.questionId)!.answer, hypothesis: r.hypothesis })));
  await writeJson(path.join(root, "blind-review.json"), { status: "automatic_scores_not_human_reviewed", planned: 60, available: blind.length, samples: blind });
  await writeJson(path.join(root, "blind-review-map.json"), rows.map(r => ({ blindId: digest(r.key).slice(0, 20), key: r.key, arm: r.arm })));
  const main = memoryBootstrap(rows, "bm25-history", complete), secondary = memoryBootstrap(rows, "no-memory", complete);
  const report = { schema: 1, executionPolicy: manifest.executionPolicy ?? "strict", executionComplete, publicUsage, retainedPublicItems: publicContinuation?.results.length ?? 0, storageFailure: state?.storageFailure ?? null, label: "Go/DeepSeek adapted evaluation; snapshot-only reader; automatic DeepSeek judge, not human reviewed; not official GPT-4o scores", continuation: continuation ? { parentRoot: continuation.parentRoot, historical: continuation.historical, codingIdentities: "mixed; completion evidence only" } : null, complete, planned: manifest.planned.length, settled: rows.length, skipped, results: rows, groups, coverage, requests: usage, phases: Object.fromEntries(["extract", "merge", "answer", "judge"].map(phase => [phase, rollup(publicRequests.filter(r => r.phase === phase))])),
    mainComparison: main, secondaryComparison: secondary, clearQualityGain: main.interval95 !== null && main.interval95[0] > 0, coding: { planned: 72, ...(coding ?? { records: [], skipped: [], stopReason: "not_started" }), scope: "Three synthetic sequences; zero capture idle delay; no real-issue productivity claim" }, stopReason: state?.stopReason ?? null, pricing: "No verified price supplied; report tokens, not currency" };
  await writeJson(path.join(root, "report.json"), report);
  const phaseKnownTokens = usage.inputTokens + usage.outputTokens + (coding?.knownTokens ?? 0);
  const phaseComplete = usage.complete && coding !== undefined && codingRecords.every(row => row.result.usage?.complete === true);
  let ownCodingUnknown: number | null = 0;
  try {
    const journal = (await readFile(path.join(root, "coding/results.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { result: { usage?: { complete: boolean }; requestAccounting?: { unknownRequests: number } } });
    ownCodingUnknown = journal.some(row => !row.result.requestAccounting && row.result.usage?.complete !== true) ? null : journal.reduce((sum, row) => sum + (row.result.requestAccounting?.unknownRequests ?? 0), 0);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ownCodingUnknown = coding !== undefined && codingRecords.length === (continuation?.retained.length ?? 0) ? 0 : null; }
  const priorUnknown = continuation ? continuation.historical.unknownRequestCount ?? null : 0;
  const unknownRequestCount = ownCodingUnknown === null || priorUnknown === null ? null : usage.unknownRequests.length + ownCodingUnknown + priorUnknown;
  await writeJson(path.join(root, "campaign-usage.json"), { unknownRequestCount, publicAndSmoke: usage, codingKnownTokens: coding?.knownTokens ?? 0, phaseKnownTokens, phaseComplete,
    historical: continuation ? { parentRoot: continuation.parentRoot, ...continuation.historical } : null,
    knownInputOutputTokens: phaseKnownTokens + (continuation?.historical.knownInputOutputTokens ?? 0), complete: !continueUnrun && phaseComplete && (continuation?.historical.complete ?? true), currency: null });
  await writeJson(path.join(root, "coding-statuses.json"), { planned: 72, availablePlanItems: codingStatuses.length, items: codingStatuses });
  await writeFile(path.join(root, "report.md"), `# Go / DeepSeek Memory evaluation\n\n${report.label}\n\nPublic: ${rows.length}/${manifest.planned.length} settled; execution complete: ${executionComplete}; formal evaluation complete: ${complete}. Retained public results: ${publicContinuation?.results.length ?? 0}. Coding: ${coding?.records.length ?? 0}/72 settled.\n\n| Arm | Correct | Planned | Accuracy over planned | Known input + output tokens |\n| --- | ---: | ---: | ---: | ---: |\n${groups.map(g => `| ${g.arm} | ${g.correct} | ${g.planned} | ${g.accuracyOverPlanned} | ${g.cost.inputTokens + g.cost.outputTokens} |`).join("\n")}\n\n${continueUnrun ? "Approved exploratory continuation: service failures and unknown usage are retained without retry; accounting remains incomplete and formal confidence intervals are disabled. Mixed source identities are recorded per retained result." : "Strict execution policy."}\n\nMain paired difference: ${JSON.stringify(main)}.\n\nStop reason: ${state?.stopReason ?? "none"}. Unknown usage remains visible in report.json.\n`);
  if (continuation) await writeFile(path.join(root, "continuation-report.json"), JSON.stringify({ parentRoot: continuation.parentRoot, retainedCells: continuation.retained.length, historical: continuation.historical, codingInterpretation: "Composite completion evidence with mixed source identities; historical failed attempts and unknown usage retained. Do not infer a clean paired coding effect.", publicInterpretation: publicContinuation ? "Retained terminal public items keep their original source identity; only unrun items belong to this candidate. Exploratory continuation, no formal confidence intervals." : "All 4500 public items belong to the new frozen candidate." }, null, 2));
}
