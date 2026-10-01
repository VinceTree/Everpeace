import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { assertBenchmarkCheckoutIdentity, captureBenchmarkCheckoutIdentity, preflightBenchmarkCheckout } from "../../../src/benchmark/checkout.js";

const exec = promisify(execFile);

test("checkout identity binds revision, runtime source, and built entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-checkout-identity-"));
  try {
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, "dist", "benchmark"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
    await fs.writeFile(path.join(root, "src", "runtime.ts"), "export const value = 1;\n", "utf8");
    const entry = path.join(root, "dist", "benchmark", "production.mjs");
    await fs.writeFile(entry, `
export const createProductionBenchmarkAdapter = ({ model }) => ({
  async run(_task, context) {
    const attempt = context.requestAttemptLedger.begin('coding');
    await fetch(model.base_url + '/responses', {
      method: 'POST',
      body: JSON.stringify({ model: model.model_name, reasoning: { effort: model.request_settings.reasoningEffort }, max_output_tokens: model.request_settings.maxOutputTokens, stream: true }),
    });
    context.requestAttemptLedger.settle(attempt, 'completed', { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
    return { terminalOutcome: 'completed' };
  },
});
`, "utf8");
    await exec("git", ["add", "package.json", "src/runtime.ts"], { cwd: root });
    await exec("git", ["commit", "-m", "fixture"], { cwd: root });
    const identity = await captureBenchmarkCheckoutIdentity(root, entry);
    assert.match(identity.revision, /^[a-f0-9]{40}$/u);
    assert.match(identity.sourceDigest, /^[a-f0-9]{64}$/u);
    assert.match(identity.buildDigest, /^[a-f0-9]{64}$/u);
    const expected = { sourceRoot: root, entryPath: entry, revision: identity.revision, sourceDigest: identity.sourceDigest, buildDigest: identity.buildDigest };
    await assertBenchmarkCheckoutIdentity(expected);
    const preflight = await preflightBenchmarkCheckout({ ...expected, modelName: "deepseek-flash" });
    assert.equal(preflight.providerBoundaryObserved, true);
    assert.equal(preflight.requests, 1);
    assert.equal(preflight.reasoning, "high");
    assert.equal(preflight.maxOutputTokens, 32_768);
    await fs.writeFile(path.join(root, "src", "runtime.ts"), "export const value = 2;\n", "utf8");
    await assert.rejects(assertBenchmarkCheckoutIdentity(expected), /source digest changed/u);
    const withTrackedChange = await captureBenchmarkCheckoutIdentity(root, entry);
    await fs.writeFile(path.join(root, "src", "new-runtime.ts"), "export const added = true;\n", "utf8");
    const withUntrackedSource = await captureBenchmarkCheckoutIdentity(root, entry);
    assert.notEqual(withUntrackedSource.sourceDigest, withTrackedChange.sourceDigest);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("checkout preflight invokes the repository production adapter at a synthetic provider boundary", { timeout: 45_000 }, async () => {
  const root = process.cwd();
  const entryPath = path.resolve("src/benchmark/production.ts");
  const identity = await captureBenchmarkCheckoutIdentity(root, entryPath);
  const result = await preflightBenchmarkCheckout({
    sourceRoot: root,
    entryPath,
    revision: identity.revision,
    sourceDigest: identity.sourceDigest,
    buildDigest: identity.buildDigest,
    modelName: "deepseek-flash",
  });
  assert.equal(result.providerBoundaryObserved, true);
  assert.equal(result.requests, 1);
  assert.equal(result.usage.complete, true);
});
