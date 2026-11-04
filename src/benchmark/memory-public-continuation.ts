import path from "node:path";
import { readFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { digest, type MemoryPlanItem } from "./memory-data.js";
import { jsonFiles, optionalJson, readJson, type MemoryRequestRecord } from "./memory-evidence.js";
import type { MemoryCampaignConfig, MemoryCampaignManifest, MemorySampleResult } from "./memory-campaign.js";

export interface MemoryPublicContinuation {
  schema: 1; parentRoot: string; identity: MemoryCampaignManifest["identity"];
  files: Record<string, string>; results: MemorySampleResult[]; requests: MemoryRequestRecord[];
}

export async function freezePublicContinuation(parentRoot: string, config: MemoryCampaignConfig, planned: MemoryPlanItem[]): Promise<MemoryPublicContinuation> {
  parentRoot = path.resolve(parentRoot);
  if (await lockfile.check(parentRoot)) throw Error("Parent campaign is still active");
  const manifest = await readJson<MemoryCampaignManifest>(path.join(parentRoot, "manifest.json"));
  if (JSON.stringify(manifest.config) !== JSON.stringify(config) || JSON.stringify(manifest.planned) !== JSON.stringify(planned)) throw Error("Public continuation model/data/schedule differs");
  const preflight = await readJson<{ manifest: string; identity: MemoryCampaignManifest["identity"] }>(path.join(parentRoot, "preflight.json"));
  if (preflight.manifest !== digest(JSON.stringify(manifest)) || (await readFile(path.join(parentRoot, "preflight.sha256"), "utf8")).trim() !== digest(JSON.stringify(preflight))) throw Error("Parent public validation receipt changed");
  await readJson(path.join(parentRoot, "run-state.json"));
  const files: Record<string, string> = {}, results: MemorySampleResult[] = [];
  for (const item of planned) {
    const name = `samples/${item.key}/result.json`, row = await optionalJson<MemorySampleResult>(path.join(parentRoot, name));
    if (!row) continue;
    if (!["key", "questionId", "repetition", "arm", "historyHash"].every(key => row[key as keyof MemorySampleResult] === item[key as keyof MemoryPlanItem])
      || !["completed", "failed"].includes(row.status)
      || (row.status === "completed" ? typeof row.correct !== "boolean" || typeof row.hypothesis !== "string" || !row.retrieval : row.correct !== null)) throw Error("Invalid parent public result");
    files[name] = digest(await readFile(path.join(parentRoot, name)));
    results.push({ ...row, retainedFrom: row.retainedFrom ?? parentRoot, retainedSourceDigest: row.retainedSourceDigest ?? preflight.identity.sourceDigest });
  }
  const keys = new Set(planned.map(item => item.key)), settled = new Map(results.map(row => [row.key, row]));
  const previous = await optionalJson<MemoryPublicContinuation>(path.join(parentRoot, "public-continuation.json"));
  if (previous) { await verifyPublicContinuation(previous); files["public-continuation.json"] = digest(await readFile(path.join(parentRoot, "public-continuation.json"))); }
  const requests = new Map<string, MemoryRequestRecord>();
  const add = (record: MemoryRequestRecord, origin: string) => {
    const key = record.key.split(":")[0]!; if (!keys.has(key)) return;
    const row = settled.get(key);
    if (!row || record.state !== "settled" || record.openRequests !== 0 || (!record.usage.complete && row.status !== "failed")) throw Error("Parent public sample lacks a terminal checkpoint or has unresolved usage");
    const entry = { ...record, originRoot: record.originRoot ?? origin }, identity = `${entry.originRoot}:${record.key}`;
    const existing = requests.get(identity);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw Error("Conflicting retained request identity");
    requests.set(identity, entry);
  };
  for (const record of previous?.requests ?? []) add(record, previous!.parentRoot);
  for (const file of await jsonFiles(path.join(parentRoot, "requests"))) {
    const record = await readJson<MemoryRequestRecord>(file); if (!keys.has(record.key.split(":")[0]!)) continue;
    add(record, parentRoot); files[path.relative(parentRoot, file).split(path.sep).join("/")] = digest(await readFile(file));
  }
  return { schema: 1, parentRoot, identity: preflight.identity, files, results, requests: [...requests.values()] };
}

export async function verifyPublicContinuation(continuation: MemoryPublicContinuation): Promise<void> {
  for (const [name, hash] of Object.entries(continuation.files)) if (digest(await readFile(path.join(continuation.parentRoot, name))) !== hash) throw Error("Parent public evidence identity changed");
}

/** Unknown billing is retained only for a closed failed sample, never an interrupted request. */
export async function allowFailedPublicUnknown(root: string, planned: MemoryPlanItem[], record: MemoryRequestRecord): Promise<boolean> {
  const item = planned.find(row => row.key === record.key.split(":")[0]);
  if (!item || record.state !== "settled" || record.openRequests !== 0) return false;
  const row = await optionalJson<MemorySampleResult>(path.join(root, "samples", item.key, "result.json"));
  return row?.status === "failed" && row.correct === null && ["key", "questionId", "repetition", "arm", "historyHash"].every(key => row[key as keyof MemorySampleResult] === item[key as keyof MemoryPlanItem]);
}
