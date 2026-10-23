/** Credential-free drafts and frozen planned denominators, never live execution. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureBenchmarkCheckoutIdentity, preflightBenchmarkCheckout } from "../../src/benchmark/checkout.js";
import { captureBenchmarkEvaluationDigest } from "../../src/benchmark/evaluation-identity.js";
import { parseReproducibleBenchmarkTaskCatalog } from "../../src/benchmark/catalog.js";
import { parseCampaignConfig } from "../../src/benchmark/campaign-cli.js";
import { createBenchmarkCampaignPlan } from "../../src/benchmark/campaign.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = process.argv[2]; assert.ok(root && path.isAbsolute(root), "Supply a new absolute artifact directory outside the checkout");
const relation = path.relative(repository, root); assert.ok(relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation));
await mkdir(root);
const save = (name: string, value: unknown) => writeFile(path.join(root, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const identity = await captureBenchmarkCheckoutIdentity(repository, path.join(repository, "dist/benchmark/production.js"));
const expected = { model: "REQUIRES_MODEL_AUTHORIZATION", reasoning: "high", maxOutputTokens: 32768 };
const metrics = ["independent successes / planned", "first-pass successes", "wall time", "all requests", "all known tokens and unknown usage", "duplicate reads", "conflicts", "manual interventions", "task-specific external erroneous-edit assertions"];
const preflights = [];
for (const experiment of ["repair", "team"] as const) {
  const harnesses = ["baseline", "candidate"].map((arm) => ({ kind: "everpeace-checkout", name: `${experiment}-${arm}`, sourceRoot: repository, ...identity, expected,
    ...(experiment === "repair" ? { repairStrategy: arm } : { repairStrategy: "baseline", team: { enabled: arm === "candidate", maxAgents: 3 } }) }));
  for (const harness of harnesses) preflights.push(await preflightBenchmarkCheckout({ ...harness, repairStrategy: harness.repairStrategy as "baseline" | "candidate", modelName: expected.model }));
  for (const [group, fixtureDirectory, catalogFile] of [["node", "docs/benchmark/fixtures", "docs/benchmark/DEEPSEEK_NODE_TASKS.json"], ["expanded", "tests/fixtures/expanded", "docs/benchmark/EXPANDED_TASKS.json"]]) {
    const catalogPath = path.join(repository, catalogFile!); const fixtureRoot = path.join(repository, fixtureDirectory!);
    const tasks = parseReproducibleBenchmarkTaskCatalog(await readFile(catalogPath, "utf8"));
    const config = { campaignId: `${experiment}-${group}`, catalogPath, fixtureRoot, evaluationDigest: await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot),
      modelId: "REQUIRES_MODEL_AUTHORIZATION", modelBaseUrl: "https://api.deepseek.com", seed: 20261011, ordering: "paired", repetitions: 5,
      taskTokenBudget: 100000, campaignTokenBudget: tasks.length * 10 * 100000, harnesses,
      runsRoot: path.join(root, experiment, group!, "runs"), artifactsRoot: path.join(root, experiment, group!, "artifacts"), sessionsRoot: path.join(root, experiment, group!, "sessions") };
    parseCampaignConfig(config, path.join(root, "config.json"));
    const adapters = harnesses.map((harness) => ({ name: harness.name, async run() { throw new Error("Preparation cannot issue model requests"); } }));
    await save(`${experiment}-${group}.json`, config);
    await save(`${experiment}-${group}-plan.json`, { planned: createBenchmarkCampaignPlan(tasks, adapters, 5, config.seed, "paired"), realModelRuns: 0, authorization: "not granted; numeric budgets are drafts, not authorization" });
  }
}
await save("frozen-protocol.json", { identity, preparationDigest: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"), experiments: ["repair", "team"], metrics, realModelRuns: 0,
  rules: ["one variable at a time", "same task/model/profile/request settings/source/budget", "five repetitions per arm; serial interleaved pairs", "retain failures, skips and platform gaps in the planned denominator", "unknown usage stops the campaign", "external task-specific regression and scope classifiers required before a benefit claim"],
  decision: "Production stays at three repairs and single Agent. No automatic recommendation until reliable complete usage, external erroneous-edit evidence and repeated live gains exist.", preflights });
console.log("Prepared two separate 190-run experiment drafts across 19 diagnostic tasks. Real model calls: 0.");
