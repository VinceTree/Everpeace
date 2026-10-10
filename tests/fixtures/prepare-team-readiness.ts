/** Offline preparation only. No AuthStorage import and no live execution path. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureBenchmarkCheckoutIdentity, preflightBenchmarkCheckout } from "../../src/benchmark/checkout.js";
import { captureBenchmarkEvaluationDigest } from "../../src/benchmark/evaluation-identity.js";
import { parseReproducibleBenchmarkTaskCatalog } from "../../src/benchmark/catalog.js";
import { parseCampaignConfig } from "../../src/benchmark/campaign-cli.js";
import { proveBenchmarkFixture } from "../../src/benchmark/preparation.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [mode, suppliedRoot, suppliedModelId, suppliedModelName, suppliedBaseUrl] = process.argv.slice(2);
assert.ok(suppliedRoot && path.isAbsolute(suppliedRoot) && ["prepare", "proof"].includes(mode ?? ""), "Use prepare-team-readiness.ts <prepare|proof> <absolute-new-owned-root> [registered-model-id raw-model-id base-url]");
const root = path.resolve(suppliedRoot);
const relation = path.relative(repository, root);
assert.ok(relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation), "Readiness artifacts must stay outside the user checkout");
const catalogPath = path.join(repository, "docs/benchmark/DEEPSEEK_NODE_TASKS.json");
const fixtureRoot = path.join(repository, "docs/benchmark/fixtures");
const tasks = parseReproducibleBenchmarkTaskCatalog(await readFile(catalogPath, "utf8"));
const save = (name: string, value: unknown) => writeFile(path.join(root, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
if (mode === "prepare") {
  await mkdir(root); // Exclusive creation: existing reports and user artifacts are never overwritten.
  await save("ownership.json", { kind: "everpeace-team-readiness" });
  const identity = await captureBenchmarkCheckoutIdentity(repository, path.join(repository, "dist/benchmark/production.js"));
  const evaluationDigest = await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot);
  const harnessDigest = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
  const modelId = suppliedModelId ?? "REQUIRES_MODEL_AUTHORIZATION";
  const modelName = suppliedModelName ?? "REQUIRES_MODEL_AUTHORIZATION";
  const baseUrl = suppliedBaseUrl ?? "https://provider.invalid/v1";
  const expected = { model: modelName, reasoning: "high", maxOutputTokens: 32_768 };
  const harnesses = [false, true].map((team) => ({ kind: "everpeace-checkout", name: team ? "team" : "single", sourceRoot: repository, ...identity, expected, ...(team ? { team: { enabled: true, maxAgents: 3 } } : {}) }));
  const preflights = [];
  for (const harness of harnesses) preflights.push(await preflightBenchmarkCheckout({ ...harness, modelName, modelBaseUrl: baseUrl, responsesProfile: "deepseek" }));
  await save("preflight.json", { evidence: "synthetic provider boundary; no credentials; no network; not a live model result", preflights });
  const suffix = randomUUID().slice(0, 8);
  for (const [stage, repetitions, budget] of [["smoke", 1, 600_000], ["comparison", 3, 6_000_000]] as const) {
    const config = { campaignId: `team-${stage}-${suffix}`, catalogPath, fixtureRoot, evaluationDigest, modelId, modelBaseUrl: baseUrl, responsesProfile: "deepseek", seed: 20261010, repetitions, taskTokenBudget: 100_000, campaignTokenBudget: budget,
      runsRoot: path.join(root, stage, "runs"), artifactsRoot: path.join(root, stage, "artifacts"), sessionsRoot: path.join(root, stage, "sessions"),
      ...(stage === "smoke" ? { taskIds: tasks.slice(0, 3).map((task) => task.id) } : {}), harnesses };
    parseCampaignConfig(config, path.join(root, `${stage}.json`)); await save(`${stage}.json`, config);
  }
  await save("compatibility-plan.json", { identity, harnessDigest, evaluationDigest, modelId, modelName, baseUrl, responsesProfile: "deepseek", authorization: "not authorized; review model/profile and explicit task/campaign ceilings before any live request", taskTokenBudget: 10_000, campaignTokenBudget: 20_000, requestSettings: { reasoningEffort: "high", maxOutputTokens: 1024 }, cases: ["text", "reasoning-tools"], note: "Explicit short protocol-probe settings; smoke/comparison keep 32768. This plan is not a CampaignConfig or authorization." });
  await save("candidate.json", { identity, harnessDigest, evaluationDigest, configurationDigests: await Promise.all(["smoke.json", "comparison.json", "compatibility-plan.json"].map(async (file) => ({ file, sha256: createHash("sha256").update(await readFile(path.join(root, file))).digest("hex") }))), liveCalls: 0 });
  console.log(`Prepared current-candidate single/team preflights, six-run smoke and sixty-run comparison drafts in ${root}. Live calls: 0.`);
} else {
  assert.equal(JSON.parse(await readFile(path.join(root, "ownership.json"), "utf8")).kind, "everpeace-team-readiness");
  const proofs = [];
  for (const task of tasks) {
    const proof = await proveBenchmarkFixture(task, { fixtureRoot, destination: path.join(root, "proof", task.id) });
    proofs.push({ taskId: task.id, ...proof }); console.log(`${task.id}: seed rejected; reference accepted`);
  }
  await save("fixture-proof.json", { evidence: "fixed offline task/scorer proof; not model quality", proofs });
}
