import path from "node:path";
import { readFile } from "node:fs/promises";
import { digest } from "./memory-data.js";
import { jsonFiles, optionalJson, readJson } from "./memory-evidence.js";
import type { MemoryCampaignConfig } from "./memory-campaign.js";
import lockfile from "proper-lockfile";

export interface CodingCell { sequence: string; repetition: number; arm: string; stage: number; prompt: string }
export interface CodingRecord extends CodingCell {
  result: { status: string; terminalOutcome?: string; workflowOutcome?: string; verification?: { passed: boolean }; usage?: { complete: boolean; inputTokens: number; outputTokens: number }; requestAccounting?: { unknownRequests: number }; cleanupFailed?: boolean; storageFailed?: boolean; isolationFailed?: boolean };
  retainedFrom?: string;
}
export interface MemoryContinuation {
  schema: 1; parentRoot: string; files: Record<string, string>; config: MemoryCampaignConfig;
  absentFiles?: string[];
  evaluationDigest: string; planned: CodingCell[]; retained: CodingRecord[];
  historical: { knownInputOutputTokens: number; complete: boolean; failedAttempts: number; retainedCells: number; unknownRequestCount?: number | null };
}
const cellKey = (row: CodingCell) => `${row.sequence}:${row.repetition}:${row.arm}:${row.stage}`;
const chainKey = (row: CodingCell) => `${row.sequence}:${row.repetition}:${row.arm}`;

async function codingJournal(root: string): Promise<CodingRecord[]> {
  try { return (await readFile(path.join(root, "coding/results.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function countHistoricalUnknown(root: string, seen = new Set<string>()): Promise<number | null> {
  root = path.resolve(root); if (seen.has(root)) throw Error("Cyclic campaign lineage"); seen.add(root);
  const usage = await readJson<{ unknownRequestCount?: number | null; publicAndSmoke?: { unknownRequests: unknown[] } }>(path.join(root, "campaign-usage.json"));
  if (usage.unknownRequestCount !== undefined) return usage.unknownRequestCount;
  const plan = await readJson<{ continuation?: MemoryContinuation }>(path.join(root, "coding/plan.json"));
  const rows = await codingJournal(root);
  if (!usage.publicAndSmoke || rows.some(row => !row.result.requestAccounting && row.result.usage?.complete !== true)) return null;
  const own = usage.publicAndSmoke.unknownRequests.length + rows.reduce((sum, row) => sum + (row.result.requestAccounting?.unknownRequests ?? 0), 0);
  if (!plan.continuation) return own;
  await verifyMemoryContinuation(plan.continuation);
  const prior = await countHistoricalUnknown(plan.continuation.parentRoot, seen); return prior === null ? null : own + prior;
}

/** Keep whole verified chains only. An unfinished chain always starts from a clean fixture. */
export function retainCompletedCodingChains(planned: CodingCell[], records: CodingRecord[]): CodingRecord[] {
  const expected = new Map(planned.map(row => [cellKey(row), row]));
  const observed = new Map<string, CodingRecord>();
  for (const row of records) {
    const key = cellKey(row);
    if (!expected.has(key) || observed.has(key) || row.prompt !== expected.get(key)!.prompt) throw Error("Invalid or duplicate parent coding cell");
    observed.set(key, row);
  }
  const chains = new Set(planned.map(chainKey));
  const retained: CodingRecord[] = [];
  for (const chain of chains) {
    const cells = planned.filter(row => chainKey(row) === chain);
    if (cells.length !== 4 || new Set(cells.map(row => row.stage)).size !== 4) throw Error("Invalid coding chain plan");
    const complete = cells.map(row => observed.get(cellKey(row)));
    if (complete.every(row => row && row.result.status === "passed" && row.result.terminalOutcome === "completed" && row.result.workflowOutcome === "verified" && row.result.verification?.passed === true && row.result.usage?.complete === true && !row.result.cleanupFailed && !row.result.storageFailed && !row.result.isolationFailed)) retained.push(...complete as CodingRecord[]);
  }
  return retained;
}

export async function freezeMemoryContinuation(parentRoot: string, config: MemoryCampaignConfig): Promise<MemoryContinuation> {
  parentRoot = path.resolve(parentRoot);
  if (await lockfile.check(parentRoot)) throw Error("Parent campaign is still active");
  if (await optionalJson(path.join(parentRoot, "coding/pending-task.json"))) throw Error("Parent has an unresolved coding task");
  const manifest = await readJson<{ config: MemoryCampaignConfig }>(path.join(parentRoot, "manifest.json"));
  if (JSON.stringify(manifest.config) !== JSON.stringify(config)) throw Error("Parent model/data configuration differs");
  const manifestHash = digest(JSON.stringify(manifest));
  const preflight = await readJson<{ manifest: string }>(path.join(parentRoot, "preflight.json"));
  if ((await readFile(path.join(parentRoot, "manifest.sha256"), "utf8")).trim() !== manifestHash || preflight.manifest !== manifestHash || (await readFile(path.join(parentRoot, "preflight.sha256"), "utf8")).trim() !== digest(JSON.stringify(preflight))) throw Error("Parent validation receipt changed");
  await readJson(path.join(parentRoot, "run-state.json")); // Must be a stopped, persisted parent.
  for (const file of await jsonFiles(path.join(parentRoot, "requests"))) {
    const request = await readJson<{ state: string; openRequests: number }>(file);
    if (request.state !== "settled" || request.openRequests !== 0) throw Error("Parent has unresolved model requests");
  }
  for (const file of (await jsonFiles(path.join(parentRoot, "coding/chains"))).filter(file => file.includes(`${path.sep}request-ledgers${path.sep}`))) {
    const ledger = await readJson<{ openRequests: number }>(file);
    if (ledger.openRequests !== 0) throw Error("Parent has unresolved coding requests");
  }
  const plan = await readJson<{ evaluationDigest: string; planned: CodingCell[]; continuation?: MemoryContinuation }>(path.join(parentRoot, "coding/plan.json"));
  const result = await readJson<{ records: CodingRecord[] }>(path.join(parentRoot, "coding/live-result.json"));
  const rawRecords = await codingJournal(parentRoot);
  if (plan.continuation) await verifyMemoryContinuation(plan.continuation);
  if (JSON.stringify([...(plan.continuation?.retained ?? []), ...rawRecords]) !== JSON.stringify(result.records)) throw Error("Parent coding result and journal disagree");
  const usage = await readJson<{ knownInputOutputTokens: number; complete: boolean }>(path.join(parentRoot, "campaign-usage.json"));
  const retained = retainCompletedCodingChains(plan.planned, result.records).map(row => ({ ...row, retainedFrom: parentRoot }));
  const files: Record<string, string> = {};
  const absentFiles: string[] = [];
  for (const name of ["manifest.json", "manifest.sha256", "preflight.json", "preflight.sha256", "coding/plan.json", "coding/live-result.json", "coding/results.jsonl", "campaign-usage.json", "run-state.json"]) {
    try { files[name] = digest(await readFile(path.join(parentRoot, name))); }
    catch (error) { if (name !== "coding/results.jsonl" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; absentFiles.push(name); }
  }
  return { schema: 1, parentRoot, files, absentFiles, config, evaluationDigest: plan.evaluationDigest, planned: plan.planned, retained,
    historical: { ...usage, failedAttempts: result.records.filter(row => row.result.status !== "passed").length, retainedCells: retained.length, unknownRequestCount: await countHistoricalUnknown(parentRoot) } };
}
export async function verifyMemoryContinuation(continuation: Pick<MemoryContinuation, "parentRoot" | "files" | "absentFiles">, seen = new Set<string>()): Promise<void> {
  if (seen.has(continuation.parentRoot)) throw Error("Cyclic campaign lineage"); seen.add(continuation.parentRoot);
  for (const [name, hash] of Object.entries(continuation.files)) if (digest(await readFile(path.join(continuation.parentRoot, name))) !== hash) throw Error("Parent continuation identity changed");
  for (const name of continuation.absentFiles ?? []) {
    try { await readFile(path.join(continuation.parentRoot, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw Error("Parent continuation identity changed");
  }
  if (await optionalJson(path.join(continuation.parentRoot, "coding/pending-task.json"))) throw Error("Parent has an unresolved coding task");
  if (continuation.files["coding/plan.json"]) {
    const plan = await readJson<{ continuation?: MemoryContinuation }>(path.join(continuation.parentRoot, "coding/plan.json"));
    if (plan.continuation) await verifyMemoryContinuation(plan.continuation, seen);
  }
}
