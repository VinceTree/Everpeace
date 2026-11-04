import { createHash } from "node:crypto";
import type { LearnedTurn } from "../memory/learned-memory.js";

export const MEMORY_ARMS = ["no-memory", "learned-memory", "bm25-history"] as const;
export type MemoryArm = typeof MEMORY_ARMS[number];
export const DATA_REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f";
export const SCORER_REVISION = "9e0b455f4ef0e2ab8f2e582289761153549043fc";
export const QUESTION_TYPES = ["single-session-user", "single-session-assistant", "single-session-preference", "temporal-reasoning", "knowledge-update", "multi-session"] as const;
export interface HistorySession { id: string; date: string; messages: Array<{ role: "user" | "assistant"; content: string }> }
export interface MemoryQuestion { id: string; type: string; question: string; date: string; history: HistorySession[]; historyHash: string }
export interface MemoryReference { id: string; answer: string | number; evidence: string[] }
export interface MemoryPlanItem { key: string; questionId: string; arm: MemoryArm; repetition: number; historyHash: string }
export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** Explicit projection prevents reference labels and unknown fields reaching adapters. */
export function parseMemoryDataset(input: unknown, expected = 500): { questions: MemoryQuestion[]; references: MemoryReference[] } {
  if (!Array.isArray(input) || input.length !== expected) throw Error("Unexpected LongMemEval instance count");
  const ids = new Set<string>();
  const questions: MemoryQuestion[] = [], references: MemoryReference[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw Error("Invalid dataset instance");
    const row = raw as Record<string, unknown>;
    if (typeof row.question_id !== "string" || !row.question_id || ids.has(row.question_id) || typeof row.question !== "string" || typeof row.question_date !== "string" || !QUESTION_TYPES.includes(row.question_type as typeof QUESTION_TYPES[number])) throw Error("Invalid question metadata");
    ids.add(row.question_id);
    if (!Array.isArray(row.haystack_sessions) || !row.haystack_sessions.length || !Array.isArray(row.haystack_dates) || !Array.isArray(row.haystack_session_ids) || row.haystack_sessions.length !== row.haystack_dates.length || row.haystack_sessions.length !== row.haystack_session_ids.length) throw Error("Invalid history arrays");
    const history: HistorySession[] = row.haystack_sessions.map((messages: unknown, i: number) => {
      const id = (row.haystack_session_ids as unknown[])[i], date = (row.haystack_dates as unknown[])[i];
      if (typeof id !== "string" || typeof date !== "string" || !Array.isArray(messages) || !messages.length) throw Error("Invalid history session");
      return { id, date, messages: messages.map((message: unknown) => {
        if (!message || typeof message !== "object") throw Error("Invalid history message");
        const m = message as Record<string, unknown>;
        if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") throw Error("Invalid history role/content");
        return { role: m.role, content: m.content };
      }) };
    });
    if (typeof row.answer !== "string" && typeof row.answer !== "number" || !Array.isArray(row.answer_session_ids) || !row.answer_session_ids.every((id: unknown) => typeof id === "string" && history.some(s => s.id === id))) throw Error("Invalid evaluator reference");
    questions.push({ id: row.question_id, type: row.question_type as string, question: row.question, date: row.question_date, history, historyHash: digest(JSON.stringify(history)) });
    references.push({ id: row.question_id, answer: row.answer, evidence: row.answer_session_ids as string[] });
  }
  return { questions, references };
}

export function historyTurn(session: HistorySession, workspacePath: string, namespace: string): LearnedTurn {
  return { workspacePath, sessionId: `bench-${digest(`${namespace}:${session.id}`).slice(0, 24)}`,
    userInput: session.messages.find(m => m.role === "user")?.content ?? "",
    assistantText: session.messages.findLast(m => m.role === "assistant")?.content ?? "",
    transcript: `[Source ${session.id}; date ${session.date}]\n${session.messages.map(m => `${m.role}: ${m.content}`).join("\n")}`,
    toolCallCount: 0 };
}

export function memoryPlan(questions: MemoryQuestion[], seed = 16716): MemoryPlanItem[] {
  const shuffled = [...questions].sort((a, b) => digest(`${seed}:${a.id}`).localeCompare(digest(`${seed}:${b.id}`)));
  return shuffled.flatMap(q => [1, 2, 3].flatMap(repetition => MEMORY_ARMS.map((_, i) => {
    const arm = MEMORY_ARMS[(i + repetition - 1) % 3]!;
    return { key: `${digest(q.id).slice(0, 20)}-${repetition}-${arm}`, questionId: q.id, repetition, arm, historyHash: q.historyHash };
  })));
}

const words = (text: string) => [...text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)].map(m => m[0]);
export function bm25History(history: HistorySession[], query: string): { text: string; sources: string[] } {
  const chunks = history.flatMap(session => {
    const text = `[Source ${session.id}; date ${session.date}]\n${session.messages.map(m => `${m.role}: ${m.content}`).join("\n")}`;
    const tokens = [...text.matchAll(/\S+/gu)];
    const result: Array<{ text: string; source: string; terms: string[] }> = [];
    for (let start = 0; start < tokens.length; start += 448) {
      const end = Math.min(tokens.length, start + 512), last = tokens[end - 1]!;
      const chunk = text.slice(tokens[start]!.index, last.index + last[0].length);
      result.push({ text: chunk, source: session.id, terms: words(chunk) });
      if (end === tokens.length) break;
    }
    return result;
  });
  const terms = [...new Set(words(query))], avg = chunks.reduce((s, c) => s + c.terms.length, 0) / (chunks.length || 1);
  const df = new Map(terms.map(t => [t, chunks.filter(c => c.terms.includes(t)).length]));
  const ranked = chunks.map((chunk, index) => ({ ...chunk, index, score: terms.reduce((s, term) => {
    const tf = chunk.terms.filter(t => t === term).length;
    return s + (tf ? Math.log(1 + (chunks.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * chunk.terms.length / avg)) : 0);
  }, 0) })).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 20);
  const selected: typeof ranked = []; let used = 0;
  for (const chunk of ranked) if (used + chunk.text.length + (selected.length ? 2 : 0) <= 8000) { used += chunk.text.length + (selected.length ? 2 : 0); selected.push(chunk); }
  return { text: selected.map(c => c.text).join("\n\n"), sources: [...new Set(selected.map(c => c.source))] };
}

/** Upstream templates are parsed as data, never executed as downloaded Python. */
export function parseJudgeTemplates(source: string): string[] {
  const templates = [...source.matchAll(/template = "([\s\S]*?)"\s*\n\s*prompt = template\.format/gu)].map(m => m[1]!.replaceAll("\\n", "\n"));
  if (templates.length !== 5 || templates.some(t => t.split("{}").length !== 4)) throw Error("Upstream scoring template format changed");
  return templates;
}
export function judgePrompt(templates: string[], question: Pick<MemoryQuestion, "id" | "type" | "question">, answer: string | number, hypothesis: string): string {
  const index = question.id.includes("_abs") ? 4 : question.type === "temporal-reasoning" ? 1 : question.type === "knowledge-update" ? 2 : question.type === "single-session-preference" ? 3 : 0;
  let i = 0; const values = [question.question, String(answer), hypothesis];
  return templates[index]!.replace(/\{\}/gu, () => values[i++]!);
}
export class InvalidMemoryJudgeLabelError extends Error { constructor() { super("Invalid judge label"); this.name = "InvalidMemoryJudgeLabelError"; } }
export function parseJudgeLabel(text: string): boolean { const normalized = text.trim().toLowerCase(); if (normalized !== "yes" && normalized !== "no") throw new InvalidMemoryJudgeLabelError(); return normalized === "yes"; }
