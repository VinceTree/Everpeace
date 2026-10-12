import { randomUUID } from "node:crypto";
import type { TokenUsageSample } from "./model-status.js";
import { UserSettingsStore } from "../storage/user-settings.js";
import type { RequestPurpose, RequestAttemptStatus } from "../agent/request-attempt-ledger.js";

export interface ModelPrice { currency: string; input: number; cachedInput: number; output: number; warningThreshold?: number }
export interface CostEstimate {
  requestId: string; modelId: string; attemptId: number; purpose: RequestPurpose; status: RequestAttemptStatus; at: string;
  kind: "estimate"; state: "known" | "partial" | "unknown"; amount?: number; pricing?: ModelPrice; warning?: boolean;
}
export function isModelPrice(value: unknown): value is ModelPrice {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.currency === "string" && /^[A-Z]{3}$/u.test(record.currency) && [record.input, record.cachedInput, record.output].every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0) && (record.warningThreshold === undefined || typeof record.warningThreshold === "number" && Number.isFinite(record.warningThreshold) && record.warningThreshold > 0) && Object.keys(record).every((key) => ["currency", "input", "cachedInput", "output", "warningThreshold"].includes(key));
}
export function estimateRequestCost(usage: TokenUsageSample | null, pricing: ModelPrice | null): Pick<CostEstimate, "state" | "amount" | "pricing"> {
  if (!pricing) return { state: "unknown" };
  const snapshot = { ...pricing };
  if (!usage) return { state: "unknown", pricing: snapshot };
  const cached = usage.cached_input_tokens;
  // Output already includes reasoning tokens. Never bill reasoning a second time.
  if (cached !== undefined && cached > usage.input_tokens) return { state: "unknown", pricing: snapshot };
  if (cached === undefined && pricing.input !== pricing.cachedInput) return { state: "partial", amount: usage.output_tokens * pricing.output / 1_000_000, pricing: snapshot };
  const amount = ((usage.input_tokens - (cached ?? 0)) * pricing.input + (cached ?? 0) * pricing.cachedInput + usage.output_tokens * pricing.output) / 1_000_000;
  return Number.isFinite(amount) ? { state: "known", amount, pricing: snapshot } : { state: "unknown", pricing: snapshot };
}
export function isCostEstimate(value: unknown): value is CostEstimate {
  if (!value || typeof value !== "object") return false;
  const record = value as CostEstimate;
  if (Object.keys(record).some((key) => !["requestId", "modelId", "attemptId", "purpose", "status", "at", "kind", "state", "amount", "pricing", "warning"].includes(key))) return false;
  return record.kind === "estimate" && ["known", "partial", "unknown"].includes(record.state) && typeof record.requestId === "string" && /^[a-f0-9-]{36}$/u.test(record.requestId) && typeof record.modelId === "string" && record.modelId.length <= 256 && Number.isSafeInteger(record.attemptId) && record.attemptId > 0 && ["coding", "summary", "title", "skill", "memory", "doctor", "benchmark"].includes(record.purpose) && ["completed", "failed", "cancelled", "rejected"].includes(record.status) && Number.isFinite(Date.parse(record.at)) && (record.amount === undefined || Number.isFinite(record.amount) && record.amount >= 0) && (record.pricing === undefined || isModelPrice(record.pricing)) && (record.warning === undefined || typeof record.warning === "boolean");
}
export function summarizeCosts(records: readonly CostEstimate[]): { currencies: Array<{ currency: string; knownAmount: number; partial: boolean }>; unknownRequests: number; requests: number } {
  const unique = new Map<string, CostEstimate>();
  for (const record of records) {
    const previous = unique.get(record.requestId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Conflicting request cost records");
    unique.set(record.requestId, record);
  }
  const totals = new Map<string, { currency: string; knownAmount: number; partial: boolean }>(); let unknownRequests = 0;
  for (const record of unique.values()) {
    if (record.state !== "known") unknownRequests++;
    if (!record.pricing) continue;
    const total = totals.get(record.pricing.currency) ?? { currency: record.pricing.currency, knownAmount: 0, partial: false };
    if (record.amount !== undefined) total.knownAmount += record.amount;
    if (record.state !== "known") total.partial = true;
    totals.set(total.currency, total);
  }
  return { currencies: [...totals.values()], unknownRequests, requests: unique.size };
}
function isPrices(value: unknown): value is { version: 1; models: Record<string, ModelPrice> } {
  if (!value || typeof value !== "object") return false;
  const record = value as { version?: unknown; models?: unknown };
  return record.version === 1 && Boolean(record.models) && typeof record.models === "object" && !Array.isArray(record.models) && Object.entries(record.models!).every(([id, price]) => id.length <= 256 && !["__proto__", "constructor", "prototype"].includes(id) && isModelPrice(price));
}
export class CostSettingsStore extends UserSettingsStore<{ version: 1; models: Record<string, ModelPrice> }> {
  constructor(filePath?: string) { super("cost.json", isPrices, () => ({ version: 1, models: {} }), filePath); }
  async price(modelId: string): Promise<ModelPrice | null> { return (await this.read()).models[modelId] ?? null; }
  async configure(modelId: string, price: ModelPrice): Promise<void> { await this.update((current) => ({ version: 1, models: { ...current.models, [modelId]: { ...price } } })); }
}
export interface RequestCostContext { modelId: string; price(): Promise<ModelPrice | null>; settled(estimate: CostEstimate): Promise<void>; tracker?: CostWarningTracker; resetOnTask?: boolean; forRequest?(): RequestCostContext }
export class CostWarningTracker {
  #totals = new Map<string, number>(); #warned = new Set<string>();
  reset(): void { this.#totals.clear(); this.#warned.clear(); }
  add(estimate: CostEstimate): boolean {
    if (!estimate.pricing || estimate.amount === undefined) return false;
    const { currency, warningThreshold } = estimate.pricing;
    const amount = (this.#totals.get(currency) ?? 0) + estimate.amount; this.#totals.set(currency, amount);
    if (warningThreshold !== undefined && amount >= warningThreshold && !this.#warned.has(currency)) { this.#warned.add(currency); return true; }
    return false;
  }
}
export async function recordRequestCost(context: RequestCostContext, attemptId: number, purpose: RequestPurpose, status: RequestAttemptStatus, usage: TokenUsageSample | null, pricing: ModelPrice | null): Promise<void> {
  const estimate: CostEstimate = { requestId: randomUUID(), modelId: context.modelId, attemptId, purpose, status, at: new Date().toISOString(), kind: "estimate", ...estimateRequestCost(usage, pricing) };
  if (context.tracker?.add(estimate)) estimate.warning = true;
  await context.settled(estimate);
}
