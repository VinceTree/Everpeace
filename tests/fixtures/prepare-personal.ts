import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { runBenchmarkVerification } from "../../src/benchmark/runner.js";

const root = path.resolve(process.argv[2] ?? "");
const owner = JSON.parse(await readFile(path.join(root, "ownership.json"), "utf8"));
assert.equal(owner.kind, "everpeace-readiness");
assert.equal((await lstat(root)).isSymbolicLink(), false);
const baseline = path.join(root, "baseline");
const evaluatorRoot = path.join(root, "personal-evaluators");
await mkdir(evaluatorRoot, { recursive: true });
const pnpmCli = process.argv[3];
if (!pnpmCli || !path.isAbsolute(pnpmCli)) throw new Error("Pass an absolute pnpm.cjs path as the second argument");
const loader = import.meta.resolve("tsx");
const tasks = [
  { id: "understand", prompt: "Explain how everpeace exec reaches host verification, how cancellation waits for cleanup, and which state a resumed fork restores. Cite concrete source paths. Do not edit files.", allowedPaths: [], acceptance: "Cite exec/runtime.ts, workflow/task-runner.ts and runtime/production.ts; explain first-failure stop, stale evidence, fork debt, fresh permissions and cleanup. Each claim must match source. Any incorrect claim fails.", scoring: "manual-source-rubric" },
  { id: "usage-fix", prompt: "Fix nested Responses reasoning usage normalization in src/status/model-status.ts. Reasoning is a subset of output tokens. Preserve cache accounting and invalid-usage behavior. Add a focused regression and run all available package checks.", allowedPaths: ["src/status/model-status.ts", "tests/unit/status/model-status.test.ts"], acceptance: "Independent nested reasoning/cache assertion and all current manifest checks pass; no edits outside allowed paths.", scoring: "independent-assertion" },
  { id: "provider-feature", prompt: "Export isSupportedProvider(value: string): boolean from src/providers/openai-compatible.ts. It accepts exactly the same names, case and whitespace as parseProvider, returns false for unsupported strings, and never throws. Add focused tests and run all available package checks.", allowedPaths: ["src/providers/openai-compatible.ts", "tests/unit/providers/openai-compatible.test.ts"], acceptance: "Independent valid/invalid input assertions and all current manifest checks pass; preserve parseProvider behavior.", scoring: "independent-assertion" },
  { id: "cancel-resume", prompt: "Inspect the coding runner and create a short readiness note as readiness-result.txt. Start the full package checks; when asked to cancel, stop promptly and retain pending verification. Resume the same workspace with a new fork, inspect the note, then complete all discovered checks.", allowedPaths: ["readiness-result.txt"], acceptance: "Cancel after reliable model usage during host verification. Await child exit; persist pending debt. Restart and fork, observe debt before verifying, never restore old approvals, then pass all current manifest checks. Unknown usage or orphaned children fails.", scoring: "lifecycle-and-checks" },
];
const receipts: Record<string, unknown>[] = [];
const signal = new AbortController().signal;
async function command(command: string, args: string[], workspace: string) {
  const result = await runBenchmarkVerification({ command, args, timeoutMs: 300000 }, workspace, signal);
  assert.equal(result.cleanupFailed, undefined, result.error);
  assert.equal(result.passed, true, result.stderr || result.error);
  return result;
}
for (const task of tasks) {
  const workspacePath = path.join(root, "personal", task.id);
  await mkdir(path.dirname(workspacePath), { recursive: true });
  try { await lstat(workspacePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await command("git", ["clone", "--quiet", "--no-hardlinks", "--", baseline, workspacePath], root);
  }
  const head = await command("git", ["rev-parse", "HEAD"], workspacePath);
  assert.equal(head.stdout.trim(), owner.baseline);
  await command(process.execPath, [pnpmCli, "install", "--offline", "--frozen-lockfile"], workspacePath);
  let proof: unknown = { assembly: "passed", sourcePathsPresent: true };
  if (task.id === "usage-fix" || task.id === "provider-feature") {
    const relative = task.id === "usage-fix" ? "src/status/model-status.ts" : "src/providers/openai-compatible.ts";
    const filename = path.join(workspacePath, relative);
    const original = await readFile(path.join(baseline, relative), "utf8");
    const seeded = task.id === "usage-fix"
      ? original.replace("normalized.reasoning_tokens = detailsRecord.reasoning_tokens", "normalized.reasoning_tokens = 0") : original;
    assert.ok(task.id === "provider-feature" || seeded !== original, "Seed replacement must match");
    const addition = "\nexport function isSupportedProvider(value: string): boolean {\n  try { parseProvider(value); return true; } catch { return false; }\n}\n";
    const reference = task.id === "usage-fix" ? original : original + addition.replaceAll("\n", original.includes("\r\n") ? "\r\n" : "\n");
    const evaluator = path.join(evaluatorRoot, `${task.id}.mjs`);
    const checks = task.id === "usage-fix"
      ? "const usage = mod.normalizeTokenUsageSample({input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:7},output_tokens_details:{reasoning_tokens:3}}); assert.equal(usage.reasoning_tokens,3); assert.equal(usage.output_tokens,5); assert.equal(usage.cached_input_tokens,7);"
      : "assert.equal(typeof mod.isSupportedProvider,'function'); for(const value of ['deepseek',' OpenAI ','DEEPSEEK']) assert.equal(mod.isSupportedProvider(value),true); for(const value of ['', 'other', 'deepseek-flash']) assert.equal(mod.isSupportedProvider(value),false);";
    await writeFile(evaluator, `import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; const mod = await import(pathToFileURL(process.argv[2]).href); ${checks}\n`);
    await writeFile(filename, seeded);
    const failed = await runBenchmarkVerification({ command: process.execPath, args: ["--import", loader, evaluator, filename], timeoutMs: 30000 }, workspacePath, signal);
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stderr, /ERR_ASSERTION/u);
    await writeFile(filename, reference);
    const passed = await command(process.execPath, ["--import", loader, evaluator, filename], workspacePath);
    const seedFile = path.join(evaluatorRoot, `${task.id}-seed.ts`);
    const referenceFile = path.join(evaluatorRoot, `${task.id}-reference.ts`);
    await writeFile(seedFile, seeded);
    await writeFile(referenceFile, reference);
    const patch = await runBenchmarkVerification({ command: "git", args: ["diff", "--no-index", "--", seedFile, referenceFile] }, workspacePath, signal);
    assert.equal(patch.exitCode, 1, "Reference must change the seed");
    const patchLines = patch.stdout.split(/\r?\n/u);
    const firstHunk = patchLines.findIndex((line) => line.startsWith("@@"));
    assert.ok(firstHunk >= 0, "Reference diff must contain a hunk");
    const referencePatch = [`diff --git a/${relative} b/${relative}`, `--- a/${relative}`, `+++ b/${relative}`, ...patchLines.slice(firstHunk)].join("\n");
    await writeFile(path.join(evaluatorRoot, `${task.id}-reference.patch`), referencePatch);
    await writeFile(filename, seeded);
    await command("git", ["apply", "--check", "--", path.join(evaluatorRoot, `${task.id}-reference.patch`)], workspacePath);
    await command("git", ["apply", "--", path.join(evaluatorRoot, `${task.id}-reference.patch`)], workspacePath);
    assert.equal(await readFile(filename, "utf8"), reference);
    await writeFile(filename, seeded);
    proof = { failed, passed, referenceOutsideWorkspace: true };
  } else {
    for (const relative of ["src/exec/runtime.ts", "src/workflow/task-runner.ts", "src/runtime/production.ts"]) await readFile(path.join(workspacePath, relative));
  }
  receipts.push({ ...task, workspacePath, baseline: owner.baseline, tokenBudget: 100000, timeoutMs: 900000, maxRepairAttempts: 3, proof });
  process.stdout.write(`Personal ${task.id}: isolated assembly and reference proof prepared\n`);
  await writeFile(path.join(root, "personal.json"), JSON.stringify({ credentialsLoaded: false, paidAuthorized: false, model: "deepseek-flash", reasoning: "high", maxOutputTokens: 32768, campaignTokenBudget: 400000, evaluatorRoot, tasks: receipts }, null, 2));
}
