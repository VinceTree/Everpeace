import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reports = [];
for (const directory of process.argv.slice(3)) {
  const planBytes = await readFile(path.join(directory, "plan.json"));
  const candidateBytes = await readFile(path.join(directory, "candidate.json"));
  const plan = JSON.parse(planBytes), candidate = JSON.parse(candidateBytes);
  const planned = plan.cases.map((entry) => entry.id);
  assert.equal(new Set(planned).size, planned.length);
  let summary, summaryDigest;
  try { const bytes = await readFile(path.join(directory, "summary.json")); summary = JSON.parse(bytes); summaryDigest = hash(bytes); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const rows = summary?.executed ?? [];
  const seen = new Set();
  const records = rows.map((entry) => {
    assert.ok(planned.includes(entry.caseId) && !seen.has(entry.caseId), "Historical run identity is not in its plan"); seen.add(entry.caseId);
    const outcome = entry.skipped === true ? "skipped" : entry.passed === true && entry.closure === true ? "passed" : entry.result?.agentResult?.stopReason === "cancelled" ? "cancelled" : entry.failure || entry.cleanupFailure ? "error" : entry.passed === false ? "failed" : "unknown";
    return { taskId: entry.caseId, runId: `${path.basename(directory)}:${entry.caseId}`, outcome, usage: entry.usage?.complete === true ? "known" : "unknown", requests: Array.isArray(entry.requests) ? entry.requests.length : Number.isSafeInteger(entry.requests) ? entry.requests : null, model: plan.model, endpointId: hash(String(plan.baseUrl)), codeDigest: candidate.sourceDigest, buildDigest: candidate.buildDigest, evaluationDigest: entry.harnessDigest ?? null, manualInterventions: null };
  });
  const counts = Object.fromEntries(["passed", "failed", "timedOut", "error", "cancelled", "skipped", "unknown"].map((key) => [key, records.filter((entry) => entry.outcome === key).length]));
  counts.unknown += planned.length - seen.size;
  reports.push({ campaignId: path.basename(directory), revision: candidate.revision, planned: planned.length, outcomes: counts, unknownUsage: summary ? records.filter((entry) => entry.usage === "unknown" && entry.outcome !== "skipped").length : null, evidence: "insufficient", records, evidenceDigests: { plan: hash(planBytes), candidate: hash(candidateBytes), summary: summaryDigest ?? null }, notes: ["Imported historical evidence, not a run of the current candidate.", "Missing evaluation digests, manual-intervention records or missing summaries are not inferred.", "Different source/build candidates remain separate. No combined success rate is reported."] });
}
await writeFile(process.argv[2], JSON.stringify({ schema: 1, kind: "historical_import", reports }, null, 2) + "\n");
console.log(`Imported ${reports.length} separate historical plans without retaining prompts, credentials, URLs or raw logs.`);
