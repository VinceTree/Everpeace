import type { LearnedEntry } from "./learned-memory.js";
import { memoryEntryLine, memoryTerms, selectMemoryEntries, type MemoryRetrievalStrategy } from "./retrieval.js";

export type SemanticStrategy = "semantic-protected-075" | "semantic-protected-080" | "semantic-protected-bge" | "semantic-protected-bge-terms" | "semantic-protected-bge-mmr";
export interface SemanticEncoder {
  readonly identity: string;
  scores(query: string, documents: readonly string[], signal?: AbortSignal): Promise<number[]>;
  similarities?(documents: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}
export interface SemanticTrace {
  encoder: string; elapsedMs: number; rssBytes: number; cpuMicros: { user: number; system: number }; query?: string;
  ranked: Array<{ id: string; score: number; selected: boolean }>;
  selection?: Array<{ id: string; relevance: number; score: number }>;
}

/** Same selection path for snapshots and sealed-store experiments. Callers own eligibility. */
export async function selectMemoryEntriesAsync(entries: readonly LearnedEntry[], query: string, now: Date, budget: number,
  strategy: MemoryRetrievalStrategy = "current", options: {
    encoder?: SemanticEncoder; signal?: AbortSignal; assertCurrent?: () => Promise<void>; trace?: (trace: SemanticTrace) => void;
  } = {}): Promise<LearnedEntry[]> {
  if (!strategy.startsWith("semantic-protected-")) return selectMemoryEntries(entries, query, now, budget, strategy);
  if (!options.encoder) throw Error("Semantic encoder required");
  const check = async () => { options.signal?.throwIfAborted(); await options.assertCurrent?.(); options.signal?.throwIfAborted(); };
  await check();
  // Copy baseline before awaiting: the caller must reject changed eligibility or content.
  const selected = selectMemoryEntries(entries, query, now, budget, "current");
  if (!query.trim()) return selected;
  const ids = new Set(selected.map(e => e.id));
  const remaining = entries.filter(e => e.fact && !ids.has(e.id));
  const identity = JSON.stringify(entries);
  const started = performance.now();
  const cpu = process.cpuUsage();
  const retrievalQuery = ["semantic-protected-bge-terms", "semantic-protected-bge-mmr"].includes(strategy) ? memoryTerms(query, true).join(" ") : query;
  if (!retrievalQuery.trim()) return selected;
  const scores = await options.encoder.scores(retrievalQuery, remaining.map(e => `${e.lesson}\n${e.fact!.quote}`), options.signal);
  await check();
  if (JSON.stringify(entries) !== identity) throw Error("Eligible memory changed during encoding");
  if (scores.length !== remaining.length || scores.some(n => !Number.isFinite(n) || n < -1.00001 || n > 1.00001)) throw Error("Invalid semantic scores");
  const threshold = strategy.startsWith("semantic-protected-bge") ? -1 : strategy === "semantic-protected-080" ? 0.8 : 0.75;
  const ranked = remaining.map((entry, i) => ({ entry, score: scores[i]!, index: i }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const pool = ranked.slice(0, 8), baselineFacts = selected.filter(e => e.fact);
  let matrix: number[][] | undefined;
  if (strategy === "semantic-protected-bge-mmr") {
    if (!options.encoder.similarities) throw Error("MMR requires document similarities");
    matrix = await options.encoder.similarities([...baselineFacts, ...pool.map(r => r.entry)].map(e => `${e.lesson}\n${e.fact!.quote}`), options.signal);
    await check();
    if (JSON.stringify(entries) !== identity) throw Error("Eligible memory changed during encoding");
    const size = baselineFacts.length + pool.length;
    if (matrix.length !== size || matrix.some(row => row.length !== size || row.some(v => !Number.isFinite(v) || v < -1.00001 || v > 1.00001))) throw Error("Invalid document similarities");
    if (matrix.some((row, i) => Math.abs(row[i]! - 1) > 0.001 || row.some((value, j) => Math.abs(value - matrix![j]![i]!) > 0.00001))) throw Error("Invalid document similarity geometry");
  }
  const duplicateKey = (e: LearnedEntry) => e.fact ? JSON.stringify([e.fact.source?.sessionId ?? e.fact.sessionId ?? e.sourceSessionId ?? e.id,
    e.fact.sourceId, e.fact.sourceMessageHash, e.fact.source?.eventId, e.fact.speaker, e.fact.messageTime, e.fact.eventTime, e.lesson, e.fact.quote]) : e.id;
  const seen = new Set(selected.map(duplicateKey));
  let used = selected.map(memoryEntryLine).join("\n").length, added = 0;
  const selectedRows = baselineFacts.map((_, i) => i), choices = pool.map((row, i) => ({ ...row, matrixRow: baselineFacts.length + i }));
  const selection: NonNullable<SemanticTrace["selection"]> = [];
  const marginal = (row: typeof choices[number]) => matrix ? 0.7 * row.score - 0.3 * Math.max(0, ...selectedRows.map(i => matrix![row.matrixRow]![i]!)) : row.score;
  while (choices.length) {
    let best = 0;
    for (let i = 1; i < choices.length; i++) if (marginal(choices[i]!) > marginal(choices[best]!)) best = i;
    const row = choices.splice(best, 1)[0]!, { entry, score } = row;
    if (score < threshold || added === 4 || seen.has(duplicateKey(entry))) continue;
    const size = memoryEntryLine(entry).length + (selected.length ? 1 : 0);
    if (used + size > budget) continue;
    selection.push({ id: entry.id, relevance: score, score: marginal(row) });
    selected.push(entry); ids.add(entry.id); seen.add(duplicateKey(entry)); used += size; added++; selectedRows.push(row.matrixRow);
  }
  options.trace?.({ encoder: options.encoder.identity, elapsedMs: performance.now() - started, rssBytes: process.memoryUsage().rss, cpuMicros: process.cpuUsage(cpu), query: retrievalQuery,
    ranked: ranked.map(r => ({ id: r.entry.id, score: r.score, selected: ids.has(r.entry.id) })), selection });
  return selected;
}
