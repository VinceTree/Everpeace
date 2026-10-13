import assert from "node:assert/strict";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { captureBenchmarkCheckoutIdentity, createCheckoutBenchmarkAdapter } from "../../src/benchmark/checkout.js";
import { captureBenchmarkEvaluationDigest, captureFixtureTreeDigest } from "../../src/benchmark/evaluation-identity.js";
import { runBenchmarkTask, runBenchmarkVerification } from "../../src/benchmark/runner.js";
import { createFileBenchmarkArtifactSink } from "../../src/benchmark/artifacts.js";
import { SystemAuthStorage } from "../../src/storage/auth-storage.js";
import { ModelRegistry } from "../../src/storage/model-registry.js";

interface Sequence { id: string; tasks: Array<{ prompt: string; cases: Array<[unknown, unknown]>; solution: string }> }
const exec = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(repository, "docs/benchmark/memory-pilot");
const catalogPath = path.join(fixtureRoot, "tasks.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { sequences: Sequence[] };
const [mode, root, ...args] = process.argv.slice(2);
const argument = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const runnerDigest = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
assert.ok(root && path.isAbsolute(root), "Supply a new absolute evidence directory");
const save = (name: string, value: unknown) => writeFile(path.join(root, name), JSON.stringify(value, null, 2), { flag: "wx" });
const stub = (stage: number) => `export function step${stage}(value) { return null; }`;
const source = (sequence: Sequence, stage: number) => sequence.tasks.map((task, index) => index < stage ? task.solution : stub(index + 1)).join("\n") + "\n";
async function scaffold(workspace: string) {
  await mkdir(path.join(workspace, "src"), { recursive: true }); await mkdir(path.join(workspace, "tests")); await mkdir(path.join(workspace, "scripts"));
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "memory-coding-fixture", private: true, type: "module", scripts: { typecheck: "node --check src/index.js", lint: "node scripts/lint.mjs", test: "node --test", build: "node scripts/build.mjs" } }));
  await writeFile(path.join(workspace, "src/index.js"), [1, 2, 3, 4].map(stub).join("\n") + "\n");
  await writeFile(path.join(workspace, "scripts/lint.mjs"), "import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; const source=await readFile('src/index.js','utf8'); assert.ok(!/\\beval\\s*\\(/u.test(source));\n");
  await writeFile(path.join(workspace, "scripts/build.mjs"), "import {mkdir,copyFile} from 'node:fs/promises'; await mkdir('dist',{recursive:true}); await copyFile('src/index.js','dist/index.js');\n");
  await writeFile(path.join(workspace, "tests/smoke.test.mjs"), "import assert from 'node:assert/strict'; import * as api from '../src/index.js'; assert.equal(Object.keys(api).length,4);\n");
  await writeFile(path.join(workspace, ".gitignore"), "dist/\n");
  await exec("git", ["init", "--quiet"], { cwd: workspace }); await exec("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  await exec("git", ["add", "."], { cwd: workspace }); await exec("git", ["-c", "core.hooksPath=", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--quiet", "-m", "Initial coding fixture"], { cwd: workspace });
}
const verification = (workspace: string, sequence: Sequence, stage: number) => ({ command: process.execPath, args: [path.join(fixtureRoot, "verify.mjs"), workspace, sequence.id, String(stage)], timeoutMs: 30000 });
if (mode === "prepare") {
  await mkdir(root);
  const identity = await captureBenchmarkCheckoutIdentity(repository, path.join(repository, "dist/benchmark/production.js"));
  const evaluationDigest = await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot);
  const planned: Array<{ sequence: string; repetition: number; arm: string; stage: number; prompt: string }> = [];
  for (const sequence of catalog.sequences) for (let repetition = 1; repetition <= 3; repetition += 1) {
    for (const arm of (repetition % 2 ? ["off", "on"] : ["on", "off"])) for (const [step, task] of sequence.tasks.entries()) {
      planned.push({ sequence: sequence.id, repetition, arm, stage: step + 1, prompt: task.prompt });
    }
  }
  assert.equal(planned.length, 72);
  await scaffold(path.join(root, "initial"));
  await save("plan.json", { schema: 1, kind: "synthetic-continuous-coding-pilot", identity, evaluationDigest, runnerDigest, initialDigest: await captureFixtureTreeDigest(path.join(root, "initial")), modelId: argument("--model-id") ?? "REQUIRES_REGISTERED_MODEL_ID", rawModelId: argument("--raw-model") ?? "REQUIRES_RAW_MODEL_ID", endpoint: "https://api.deepseek.com", taskTokenBudget: 100000, campaignTokenBudget: 7200000, planned,
    rules: ["separate evolving workspace and empty Memory per sequence/arm/repetition", "fresh Session per task; only code and Memory persist", "capture only after workflow verification and external acceptance", "count coding, compression, extraction and consolidation requests", "predecessor failure skips subsequent tasks in that chain", "unknown usage, cancellation, cleanup or storage failure stops the entire pilot"], modelRequests: 0 });
} else if (mode === "prove") {
  const plan = JSON.parse(await readFile(path.join(root, "plan.json"), "utf8"));
  assert.equal(plan.runnerDigest, runnerDigest); assert.equal(plan.initialDigest, await captureFixtureTreeDigest(path.join(root, "initial")));
  assert.equal(plan.evaluationDigest, await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot));
  await mkdir(path.join(root, "proof"));
  const records = [];
  for (const sequence of catalog.sequences) {
    const workspace = path.join(root, "proof", sequence.id); await cp(path.join(root, "initial"), workspace, { recursive: true, errorOnExist: true, force: false });
    for (let stage = 1; stage <= 4; stage++) {
      const command = verification(workspace, sequence, stage);
      const defective = await runBenchmarkVerification(command, workspace, AbortSignal.timeout(35000));
      assert.equal(defective.passed, false); assert.match(defective.stderr, /ERR_ASSERTION/u);
      await writeFile(path.join(workspace, "src/index.js"), source(sequence, stage));
      const repaired = await runBenchmarkVerification(command, workspace, AbortSignal.timeout(35000));
      assert.ok(repaired.passed, repaired.stderr);
      records.push({ sequence: sequence.id, stage, defective, repaired });
    }
  }
  await save("proof.json", { plannedTasks: 12, proved: records.length, modelRequests: 0, records });
} else if (mode === "live") {
  assert.ok(args.includes("--live"), "Explicit --live and separate paid authorization are required");
  const plan = JSON.parse(await readFile(path.join(root, "plan.json"), "utf8"));
  assert.equal(plan.runnerDigest, runnerDigest); assert.equal(plan.initialDigest, await captureFixtureTreeDigest(path.join(root, "initial")));
  assert.ok(!plan.rawModelId.startsWith("REQUIRES_"), "Prepare a reviewed actual supplier model configuration before live");
  assert.equal(plan.evaluationDigest, await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot));
  const model = (await new ModelRegistry({ authStorage: new SystemAuthStorage() }).resolveAll()).available.find(value => value.id === plan.modelId && value.model_name === plan.rawModelId && value.base_url.replace(/\/+$/u, "") === plan.endpoint);
  assert.ok(model, "Frozen official model registration unavailable");
  await save("live-started.json", { at: new Date().toISOString(), identity: plan.identity, taskTokenBudget: plan.taskTokenBudget, campaignTokenBudget: plan.campaignTokenBudget });
  const controller = new AbortController(); const cancel = () => controller.abort(new Error("Pilot cancelled")); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const records: Array<Record<string, unknown>> = []; const skipped: Array<Record<string, unknown>> = [];
  const failedChains = new Set<string>(); let tokens = 0; let stopReason: string | undefined;
  try {
    for (const item of plan.planned as Array<{ sequence: string; repetition: number; arm: string; stage: number; prompt: string }>) {
      const chain = `${item.sequence}-${item.repetition}-${item.arm}`;
      if (stopReason || controller.signal.aborted || failedChains.has(chain)) { skipped.push({ ...item, reason: stopReason ?? (controller.signal.aborted ? "cancelled" : "predecessor_failed") }); continue; }
      if (plan.campaignTokenBudget - tokens < plan.taskTokenBudget) { stopReason = "budget_exhausted"; skipped.push({ ...item, reason: stopReason }); continue; }
      const directory = path.join(root, "chains", chain), workspace = path.join(directory, "workspace");
      if (item.stage === 1) { await mkdir(directory, { recursive: true }); await cp(path.join(root, "initial"), workspace, { recursive: true, force: false, errorOnExist: true }); }
      const sequence = catalog.sequences.find(value => value.id === item.sequence)!;
      const tests = sequence.tasks.slice(0, item.stage).flatMap((task, index) => task.cases.map(([input, expected]) => `assert.deepEqual(api.step${index + 1}(${JSON.stringify(input)}),${JSON.stringify(expected)});`));
      await writeFile(path.join(workspace, "tests/current.test.mjs"), "import assert from 'node:assert/strict'; import * as api from '../src/index.js';\n" + tests.join("\n"));
      const adapter = createCheckoutBenchmarkAdapter({ name: item.arm, sourceRoot: repository, ...plan.identity, model, sessionsRoot: path.join(directory, "sessions"), memoryPilot: { directory: path.join(directory, "memory"), enabled: item.arm === "on" } });
      const task = { id: `${item.sequence}-step${item.stage}`, prompt: item.prompt, workspacePath: workspace, timeoutMs: 900000, allowedPaths: ["src"], acceptance: verification(workspace, sequence, item.stage) };
      const result = await runBenchmarkTask(task, adapter, { liveApi: true, totalTokenBudget: plan.taskTokenBudget, signal: controller.signal, campaignId: chain, artifactSink: createFileBenchmarkArtifactSink(path.join(root, "artifacts")) });
      tokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      records.push({ ...item, result }); await appendFile(path.join(root, "results.jsonl"), JSON.stringify(records.at(-1)) + "\n");
      if (result.status !== "passed") failedChains.add(chain);
      if (result.cleanupFailed || result.storageFailed || result.isolationFailed || result.usage?.complete !== true) stopReason = result.cleanupFailed ? "cleanup_failed" : result.storageFailed ? "storage_failed" : result.isolationFailed ? "isolation_failed" : "usage_unknown";
    }
  } catch { stopReason ??= "runtime_or_storage_failure"; }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  const accounted = new Set([...records, ...skipped].map(item => `${item.sequence}:${item.repetition}:${item.arm}:${item.stage}`));
  for (const item of plan.planned) if (!accounted.has(`${item.sequence}:${item.repetition}:${item.arm}:${item.stage}`)) skipped.push({ ...item, reason: stopReason ?? "runtime_error" });
  try {
    const finalIdentity = await captureBenchmarkCheckoutIdentity(repository, plan.identity.entryPath);
    if (finalIdentity.revision !== plan.identity.revision || finalIdentity.sourceDigest !== plan.identity.sourceDigest || finalIdentity.buildDigest !== plan.identity.buildDigest || plan.evaluationDigest !== await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot) || runnerDigest !== createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")) stopReason = "identity_changed";
  } catch { stopReason = "identity_changed"; }
  await save("live-result.json", { planned: plan.planned.length, records, skipped, knownTokens: tokens, stopReason: stopReason ?? null, evidence: !stopReason && !skipped.length ? "complete-pilot-only" : "insufficient", scope: "Three synthetic code sequences; does not prove long-term real-issue productivity" });
  if (stopReason) throw Error(stopReason);
} else throw Error("Choose prepare, prove or live");
