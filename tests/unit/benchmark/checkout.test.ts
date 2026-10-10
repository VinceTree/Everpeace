import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { assertBenchmarkCheckoutIdentity, captureBenchmarkCheckoutIdentity, createCheckoutBenchmarkAdapter, preflightBenchmarkCheckout } from "../../../src/benchmark/checkout.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { createBenchmarkMetricsCollector } from "../../../src/benchmark/metrics.js";

const exec = promisify(execFile);

test("checkout identity binds revision, runtime source, and all built modules", async () => {
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
export const createProductionBenchmarkAdapter = ({ model, loopStrategy }) => ({
  async run(_task, context) {
    const attempt = context.requestAttemptLedger.begin('coding');
    if (model.id === 'telemetry') {
      if (loopStrategy !== 'candidate') throw new Error('Candidate strategy was not forwarded');
      context.onPhase('tool_wait');
      context.onEvent({ type: 'request_composition', instructionsBytes: 10, toolsBytes: 20, toolResultsBytes: 30, requestBytes: 100 });
      context.onEvent({ type: 'response_received', response: { output_text: 'PRIVATE_BODY', output: [{ type: 'reasoning', content: 'PRIVATE_BODY' }, { type: 'function_call', call_id: 'call', name: 'read_file', arguments: 'PRIVATE_BODY' }] } });
      context.onEvent({ type: 'tool_started', call: { type: 'function_call', call_id: 'call', name: 'read_file', arguments: 'PRIVATE_BODY' } });
      context.onEvent({ type: 'tool_finished', call: { type: 'function_call', call_id: 'call', name: 'read_file', arguments: 'PRIVATE_BODY' }, output: JSON.stringify({ status: 'error', error: 'PRIVATE_BODY' }) });
      context.requestAttemptLedger.settle(attempt, 'completed', { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
      return { terminalOutcome: 'completed', requestAttempts: 1 };
    }
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
    const adapter = createCheckoutBenchmarkAdapter({ ...expected, name: "candidate", loopStrategy: "candidate", sessionsRoot: path.join(root, "sessions"), model: { id: "telemetry", base_url: "https://relay.invalid/v1", model_name: "deepseek-flash", api_key: "dummy", responses_profile: "deepseek" } });
    const metrics = createBenchmarkMetricsCollector();
    const artifacts: string[] = [];
    const task = { id: "telemetry", prompt: "Read a file", workspacePath: root };
    const result = await adapter.run(task, { task, signal: AbortSignal.timeout(15_000), attempt: 1, phase: "implement", requestAttemptLedger: new RequestAttemptLedger(), onPhase: metrics.onPhase, onEvent: metrics.onEvent, async writeArtifact(_name, content) { artifacts.push(content); return undefined; } });
    assert.deepEqual(metrics.snapshot().toolBatchSizes, [1]);
    assert.equal(metrics.snapshot().toolFailures, 1);
    assert.equal(metrics.snapshot().requestComposition?.requestBytes, 100);
    assert.equal(result?.requestAttempts, 1);
    assert.equal(result?.usage?.inputTokens, 2);
    assert.ok(!artifacts.join("").includes("PRIVATE_BODY"));
    const importedRuntime = path.join(root, "dist", "runtime.mjs");
    await fs.writeFile(importedRuntime, "export const version = 1;\n");
    await assert.rejects(assertBenchmarkCheckoutIdentity(expected), /build digest changed/u);
    const firstBuild = await captureBenchmarkCheckoutIdentity(root, entry);
    await fs.writeFile(importedRuntime, "export const version = 2;\n");
    const secondBuild = await captureBenchmarkCheckoutIdentity(root, entry);
    assert.notEqual(secondBuild.buildDigest, firstBuild.buildDigest);
    assert.equal(secondBuild.sourceDigest, firstBuild.sourceDigest);
    await fs.rm(importedRuntime);
    await assertBenchmarkCheckoutIdentity(expected);
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

test("checkout preflight forwards team configuration and accounts actual independent member requests", { timeout: 45_000 }, async () => {
  const root = process.cwd(); const entryPath = path.resolve("src/benchmark/production.ts");
  const identity = await captureBenchmarkCheckoutIdentity(root, entryPath);
  const result = await preflightBenchmarkCheckout({ sourceRoot: root, ...identity, team: { enabled: true, maxAgents: 3 }, modelName: "deepseek-flash" });
  assert.equal(result.networkCalls, 0); assert.equal(result.processCleanup, "awaited");
  assert.equal(result.memberRequests, 2); assert.ok(result.requests >= 5);
  assert.equal(result.usage.inputTokens, result.requests); assert.equal(result.usage.outputTokens, result.requests); assert.equal(result.usage.complete, true);
});
