import { createHmac, randomBytes } from "node:crypto";
import type { LoopEvent } from "../agent/agent-loop.js";
import type { RequestPurpose, RequestAttemptStatus } from "../agent/request-attempt-ledger.js";
import type { TokenUsageSample } from "../status/model-status.js";
import { PerformanceTrace, type PerformanceTiming } from "./trace.js";

const OPERATIONS = ["model_request", "prepare_context", "request_snapshot", "retry_delay", "tool_wait", "tool_execution", "compaction", "persistence", "workspace_snapshot", "verification", "artifact_persistence", "sandbox_startup", "rendering", "repair", "team_integration"] as const;
const PURPOSES = ["coding", "summary", "title", "skill", "memory", "doctor", "benchmark"] as const;
const COUNTERS = ["compactions", "retries", "repeatedReads", "repeatedCalls", "repairRounds"] as const;
export interface PurposeUsage { requests: number; unknown: number; inputTokens: number; outputTokens: number }
export interface TaskPerformanceReport {
  version: 1;
  wallMs: number;
  timings: Partial<Record<(typeof OPERATIONS)[number], PerformanceTiming>>;
  counters: Partial<Record<(typeof COUNTERS)[number], number>>;
  usage: Partial<Record<RequestPurpose, PurposeUsage>>;
  firstModelEventMs?: number;
  firstModelTextMs?: number;
  meteringComplete: boolean;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function isTaskPerformanceReport(value: unknown): value is TaskPerformanceReport {
  if (!record(value) || value.version !== 1 || !finite(value.wallMs) || typeof value.meteringComplete !== "boolean") return false;
  if (Object.keys(value).some((key) => !["version", "wallMs", "timings", "counters", "usage", "firstModelEventMs", "firstModelTextMs", "meteringComplete"].includes(key))) return false;
  if (!record(value.timings) || !record(value.counters) || !record(value.usage)) return false;
  return Object.entries(value.timings).every(([key, v]) => OPERATIONS.includes(key as (typeof OPERATIONS)[number]) && record(v) && Object.keys(v).every((k) => ["count", "totalMs", "maxMs"].includes(k)) && count(v.count) && finite(v.totalMs) && finite(v.maxMs))
    && Object.entries(value.counters).every(([key, v]) => COUNTERS.includes(key as (typeof COUNTERS)[number]) && count(v))
    && Object.entries(value.usage).every(([key, v]) => PURPOSES.includes(key as RequestPurpose) && record(v) && Object.keys(v).every((k) => ["requests", "unknown", "inputTokens", "outputTokens"].includes(k)) && count(v.requests) && count(v.unknown) && v.unknown <= v.requests && count(v.inputTokens) && count(v.outputTokens))
    && (value.firstModelEventMs === undefined || finite(value.firstModelEventMs)) && (value.firstModelTextMs === undefined || finite(value.firstModelTextMs));
}

/** Task-local keys and bounded signatures never leave the observer. */
export class TaskPerformance {
  #trace = new PerformanceTrace();
  #key = randomBytes(32);
  #calls = new Set<string>();
  #requests = new Set<string>();
  #usage: TaskPerformanceReport["usage"] = {};
  #started: number | undefined;
  #generation = 0;
  #firstEvent: number | undefined;
  #firstText: number | undefined;
  constructor(readonly now: () => number = () => performance.now()) {}
  begin(): void { this.#generation++; this.#trace = new PerformanceTrace(); this.#key = randomBytes(32); this.#calls.clear(); this.#requests.clear(); this.#usage = {}; this.#firstEvent = undefined; this.#firstText = undefined; this.#started = this.now(); }
  get active(): boolean { return this.#started !== undefined; }
  get generation(): number { return this.#generation; }
  observe(event: LoopEvent, readRevision?: string): void {
    if (!this.active) return;
    if (event.type === "timing_recorded" && event.operation !== "sampling") this.timing(event.operation, event.durationMs);
    if (event.type === "model_progress") {
      const elapsed = Math.max(0, this.now() - this.#started!);
      if (event.milestone === "first_event") this.#firstEvent ??= elapsed;
      if (event.milestone === "first_text") this.#firstText ??= elapsed;
    }
    if (event.type === "compaction_completed") this.#trace.increment("compactions");
    if (event.type === "retrying") this.#trace.increment("retries");
    if (event.type === "tool_finished") {
      const read = ["read_file", "search_files", "glob_files", "project_map"].includes(event.call.name);
      const signature = createHmac("sha256", this.#key).update(event.call.name).update("\0").update(event.call.arguments).update("\0").update(readRevision ?? "unknown").digest("hex");
      if (this.#calls.has(signature)) { this.#trace.increment("repeatedCalls"); if (read && readRevision !== undefined) this.#trace.increment("repeatedReads"); }
      this.#calls.add(signature);
      if (this.#calls.size > 1024) this.#calls.delete(this.#calls.values().next().value!);
    }
  }
  timing(operation: string, ms: number): void { if (this.active && OPERATIONS.includes(operation as (typeof OPERATIONS)[number])) this.#trace.record(operation, ms); }
  repaired(): void { if (this.active) this.#trace.increment("repairRounds"); }
  settle(id: string, purpose: RequestPurpose, status: RequestAttemptStatus, usage: TokenUsageSample | null, durationMs: number): void {
    if (!this.active || status === "rejected" || this.#requests.has(id) || !PURPOSES.includes(purpose)) return;
    this.#requests.add(id);
    const total = this.#usage[purpose] ?? { requests: 0, unknown: 0, inputTokens: 0, outputTokens: 0 };
    total.requests++; if (!usage) total.unknown++; else { total.inputTokens += usage.input_tokens; total.outputTokens += usage.output_tokens; }
    this.#usage[purpose] = total; this.timing("model_request", durationMs);
  }
  snapshot(): TaskPerformanceReport | undefined {
    if (this.#started === undefined) return;
    const trace = this.#trace.snapshot();
    return { version: 1, wallMs: Math.max(0, this.now() - this.#started), timings: trace.timings, counters: trace.counters, usage: structuredClone(this.#usage), ...(this.#firstEvent === undefined ? {} : { firstModelEventMs: this.#firstEvent }), ...(this.#firstText === undefined ? {} : { firstModelTextMs: this.#firstText }), meteringComplete: Object.values(this.#usage).length > 0 && Object.values(this.#usage).every((v) => v!.unknown === 0) };
  }
  finish(): TaskPerformanceReport | undefined { const report = this.snapshot(); this.#started = undefined; this.#calls.clear(); this.#requests.clear(); this.#key.fill(0); return report; }
}

export function formatTaskPerformance(report?: TaskPerformanceReport): string {
  if (!report) return "Performance report unavailable. Older sessions and unmeasured stages are unknown.";
  const slow = Object.entries(report.timings).sort((a, b) => b[1]!.totalMs - a[1]!.totalMs).slice(0, 3);
  const tokens = Object.entries(report.usage).sort((a, b) => b[1]!.inputTokens + b[1]!.outputTokens - a[1]!.inputTokens - a[1]!.outputTokens).slice(0, 3);
  return [
    `Task wall time: ${(report.wallMs / 1000).toFixed(2)} s; metering: ${report.meteringComplete ? "complete" : "incomplete"}.`,
    `First model event / text since task start: ${report.firstModelEventMs === undefined ? "unavailable" : (report.firstModelEventMs / 1000).toFixed(2) + " s"} / ${report.firstModelTextMs === undefined ? "unavailable" : (report.firstModelTextMs / 1000).toFixed(2) + " s"}.`,
    "Phase durations are cumulative and may overlap; sandbox startup is included in tool/check time. Do not sum phases as wall time.",
    ...slow.map(([name, timing]) => `${name}: ${(timing!.totalMs / 1000).toFixed(2)} s across ${timing!.count} observations`),
    'All measured phases (overlapping cumulative time):',
    ...OPERATIONS.map(name => { const timing = report.timings[name]; return `${name}: ${timing ? (timing.totalMs/1000).toFixed(2)+' s; '+timing.count+' observations; max '+(timing.maxMs/1000).toFixed(2)+' s' : 'unavailable'}`; }),
    ...tokens.map(([purpose, usage]) => `${purpose}: ${usage!.inputTokens + usage!.outputTokens} known tokens; ${usage!.requests} requests; ${usage!.unknown} unknown`),
    `Compactions: ${report.counters.compactions ?? 0}; retries: ${report.counters.retries ?? 0}; repeated calls: ${report.counters.repeatedCalls ?? 0}; repeated reads of unchanged observed files: ${report.counters.repeatedReads ?? 0}.`,
    "Missing phases are unavailable. Repeated-call counts are observations, not proof that the calls were unnecessary.",
  ].join("\n");
}
