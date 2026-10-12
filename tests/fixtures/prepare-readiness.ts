import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReproducibleBenchmarkTaskCatalog } from "../../src/benchmark/catalog.js";
import { proveBenchmarkFixture } from "../../src/benchmark/preparation.js";
import { captureBenchmarkCheckoutIdentity } from "../../src/benchmark/checkout.js";

// Development preparation only: deliberately has no AuthStorage or live entry.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [mode, suppliedRoot] = process.argv.slice(2);
if (!suppliedRoot || !path.isAbsolute(suppliedRoot) || !["proof", "configs"].includes(mode ?? "")) {
  throw new Error("Usage: prepare-readiness.ts <proof|configs> <absolute-owned-root>");
}
const root = path.resolve(suppliedRoot);
if ((await lstat(root)).isSymbolicLink()) throw new Error("Readiness root must not be a symlink");
const owner = JSON.parse(await readFile(path.join(root, "ownership.json"), "utf8"));
if (owner.kind !== "everpeace-readiness") throw new Error("Missing readiness ownership marker");
const catalogPath = path.join(repository, "docs/benchmark/DEEPSEEK_NODE_TASKS.json");
const fixtureRoot = path.join(repository, "docs/benchmark/fixtures");
if (mode === "proof") {
  const tasks = parseReproducibleBenchmarkTaskCatalog(await readFile(catalogPath, "utf8"));
  const proofs: Record<string, unknown>[] = [];
  for (const task of tasks) {
    try {
      const proof = await proveBenchmarkFixture(task, {
        fixtureRoot, destination: path.join(root, "fixture-proof", task.id),
      });
      proofs.push({ id: task.id, status: "passed", pristine: "passed", ...proof });
      process.stdout.write(`${task.id}: expected assertion failed, reference passed\n`);
    } catch (error) {
      proofs.push({ id: task.id, status: "failed", error: String(error) });
      process.exitCode = 1;
      process.stderr.write(`${task.id}: ${String(error)}\n`);
    }
    await writeFile(path.join(root, "fixture-proof.json"), JSON.stringify({ createdAt: new Date().toISOString(), proofs }, null, 2));
  }
} else {
  const expected = { model: "deepseek-flash", reasoning: "high", maxOutputTokens: 32768 };
  const harnesses = [];
  for (const [name, sourceRoot] of [["everpeace-baseline", path.join(root, "baseline")], ["everpeace-candidate", repository]]) {
    const entryPath = path.join(sourceRoot!, "dist/benchmark/production.js");
    const identity = await captureBenchmarkCheckoutIdentity(sourceRoot!, entryPath);
    harnesses.push({ kind: "everpeace-checkout", name, sourceRoot, ...identity, expected });
  }
  const dshSource = process.argv[4] ? path.resolve(process.argv[4]!) : path.join(root, "dsh");
  harnesses.push({ kind: "dsh", name: "dsh-fixed", sourceRoot: dshSource,
    entryPath: path.join(dshSource, "apps/cli/lib/bin.js"), dshHome: path.join(root, "dsh-home"),
    profile: "everpeace-benchmark", revision: "639ed015397290b3745d163aafe02ffee4aa3f84", expected });
  for (const [stage, repetitions, budget] of [["smoke", 1, 900000], ["comparison", 3, 9000000]] as const) {
    const stageRoot = path.join(root, stage);
    await mkdir(stageRoot, { recursive: true });
    await writeFile(path.join(root, `${stage}.json`), JSON.stringify({
      campaignId: `deepseek-${stage}`, catalogPath, fixtureRoot,
      runsRoot: path.join(stageRoot, "runs"), artifactsRoot: path.join(stageRoot, "artifacts"), sessionsRoot: path.join(stageRoot, "sessions"),
      modelId: "deepseek-flash", seed: 20261009, repetitions,
      taskTokenBudget: 100000, campaignTokenBudget: budget,
      ...(stage === "smoke" ? { taskIds: ["chalk-ansi-nested-reset", "commander-async-subcommand-error", "dayjs-plugin-immutability"] } : {}), harnesses,
    }, null, 2));
  }
  process.stdout.write(`Prepared smoke (9) and comparison (90) configs in ${root}; paid execution requires separate authorization.\n`);
}
