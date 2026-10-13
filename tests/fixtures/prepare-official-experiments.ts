import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { captureBenchmarkCheckoutIdentity } from "../../src/benchmark/checkout.js";
import { captureBenchmarkEvaluationDigest } from "../../src/benchmark/evaluation-identity.js";
import { parseReproducibleBenchmarkTaskCatalog } from "../../src/benchmark/catalog.js";
import { createBenchmarkCampaignPlan } from "../../src/benchmark/campaign.js";
import { parseCampaignConfig, preflight } from "../../src/benchmark/campaign-cli.js";
import { PINNED_DSH_REVISION } from "../../src/benchmark/dsh.js";

const [root, dshRoot, sourceCacheRoot, ...args] = process.argv.slice(2);
const argument = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
assert.ok(root && path.isAbsolute(root), "Supply a new absolute evidence directory");
assert.ok(dshRoot && path.isAbsolute(dshRoot), "Supply the pinned dsh deployment directory");
if (sourceCacheRoot) assert.ok(path.isAbsolute(sourceCacheRoot));
await mkdir(root);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const identity = await captureBenchmarkCheckoutIdentity(repository, path.join(repository, "dist/benchmark/production.js"));
const dshIdentity = await captureBenchmarkCheckoutIdentity(dshRoot, path.join(dshRoot, "apps/cli/lib/bin.js"));
assert.equal(dshIdentity.revision, PINNED_DSH_REVISION);
const catalogPath = path.join(repository, "docs/benchmark/real-fixtures/catalog.json");
const fixtureRoot = path.dirname(catalogPath);
const evaluationDigest = await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot);
const tasks = parseReproducibleBenchmarkTaskCatalog(await readFile(catalogPath, "utf8"));
assert.equal(tasks.length, 12);
for (const category of ["real_issue", "dependency_compatibility", "cross_module_refactor"]) assert.equal(tasks.filter(task => task.tags?.includes(category)).length, 4);
const expected = { model: argument("--raw-model") ?? "REQUIRES_RAW_MODEL_ID", reasoning: "high", maxOutputTokens: 32768 };
const registrationId = argument("--model-id") ?? "REQUIRES_REGISTERED_MODEL_ID";
const checkout = (name: string, settings = {}) => ({ kind: "everpeace-checkout", name, sourceRoot: repository, ...identity, expected, ...settings });
const external = { kind: "dsh", name: "dsh", sourceRoot: dshRoot, ...dshIdentity, dshHome: path.join(root, "dsh-home"), profile: "official-comparison", expected };
const arms = {
  repair: [checkout("repair-baseline", { repairStrategy: "baseline" }), checkout("repair-candidate", { repairStrategy: "candidate" })],
  team: [checkout("single", { team: { enabled: false } }), checkout("team", { team: { enabled: true, maxAgents: 3 } })],
  external: [checkout("everpeace"), external],
  performance: [checkout("loop-baseline", { loopStrategy: "baseline" }), checkout("loop-candidate", { loopStrategy: "candidate" })],
};
const preflightFailures: Array<{ experiment: string; error: string }> = [];
const save = (name: string, value: unknown) => writeFile(path.join(root, name), JSON.stringify(value, null, 2), { flag: "wx" });
for (const [experiment, harnesses] of Object.entries(arms)) {
  for (const stage of ["smoke", "formal"]) {
    const selected = stage === "smoke" ? [tasks[0]!, tasks[4]!, tasks[8]!] : tasks;
    const repetitions = stage === "smoke" ? 1 : 5;
    const config = { campaignId: `official-${experiment}-${stage}`, catalogPath, fixtureRoot, evaluationDigest, ...(sourceCacheRoot ? { sourceCacheRoot } : {}),
      modelId: registrationId, modelBaseUrl: "https://api.deepseek.com", responsesProfile: "deepseek", seed: 20261013, ordering: "paired", repetitions,
      taskIds: selected.map(task => task.id), taskTokenBudget: 100_000, campaignTokenBudget: selected.length * repetitions * 2 * 100_000, harnesses,
      runsRoot: path.join(root, experiment, stage, "runs"), artifactsRoot: path.join(root, experiment, stage, "artifacts"), sessionsRoot: path.join(root, experiment, stage, "sessions") };
    const parsed = parseCampaignConfig(config, path.join(root, `${experiment}-${stage}.json`));
    const planned = createBenchmarkCampaignPlan(selected, harnesses.map(arm => ({ name: arm.name, async run() { throw Error("Preparation cannot issue model requests"); } })), repetitions, config.seed, "paired");
    assert.equal(planned.length, stage === "smoke" ? 6 : 120);
    await save(`${experiment}-${stage}.json`, config);
    await save(`${experiment}-${stage}-plan.json`, { planned, parallelPairs: 1, authorization: "not granted; placeholders block live execution", modelRequests: 0 });
    if (stage === "smoke") {
      try { await preflight(parsed); }
      catch (error) { preflightFailures.push({ experiment, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
}
await save("protocol.json", { schema: 1, endpoint: "https://api.deepseek.com", provider: "DeepSeek official", rawModelId: expected.model, registrationId, identity, dshIdentity, evaluationDigest,
  preparationDigest: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"), modelRequests: 0, compatibility: { taskTokens: 10000, campaignTokens: 20000, maxOutputTokens: 1024 },
  preflightFailures,
  rules: ["serial paired arms, alternating first arm", "five repetitions per arm, 12 independent task clusters", "same raw model, endpoint, request settings, source and full task budget", "retain failures, skips and preparation errors", "unknown usage, cleanup, isolation or storage failure stops admission", "freeze final code, build, native components and evaluator before each live phase", "task-cluster intervals; no production defaults change from offline evidence"],
  limitations: ["12 public upstream changes across three repositories; does not represent all large projects", "dsh deployment bytes are fingerprinted; a pinned HEAD alone does not prove a clean source build", "draft token ceilings are admission limits, not supplier bill caps", "no paid or real-model compatibility or benefit evidence"] });
console.log("Prepared four serial 120-run comparisons and six-run smoke stages; provider requests: 0.");
