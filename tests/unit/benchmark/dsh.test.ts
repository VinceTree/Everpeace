import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parseCampaignConfig } from "../../../src/benchmark/campaign-cli.js";
import { ensureDshBenchmarkProfile, PINNED_DSH_REVISION, type InstrumentedDshAdapterOptions } from "../../../src/benchmark/dsh.js";

interface InstrumentationModule {
  createInstrumentation(expected: {
    provider: string;
    model: string;
    reasoning: string;
    maxOutputTokens: number;
    tokenBudget: number;
  }, persist?: (value: Record<string, unknown>) => void): {
    wrap(options: Record<string, unknown>, next: () => AsyncIterable<Record<string, unknown>>): AsyncIterable<Record<string, unknown>>;
    snapshot(): Record<string, unknown>;
  };
}

async function instrumentationModule(): Promise<InstrumentationModule> {
  const url = pathToFileURL(resolve("docs/benchmark/dsh-instrumentation/index.mjs")).href;
  return await import(url) as InstrumentationModule;
}

async function collect(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _value of iterable) {
    // Consume the provider stream so the instrumentation settles in finally.
  }
}

const EXPECTED = {
  provider: "deepseek-official",
  model: "deepseek-flash",
  reasoning: "high",
  maxOutputTokens: 32_768,
  tokenBudget: 100,
};

test("dsh instrumentation records cache-aware usage at the stream attempt boundary", async () => {
  const { createInstrumentation } = await instrumentationModule();
  const saved: Record<string, unknown>[] = [];
  const instrumentation = createInstrumentation(EXPECTED, (value) => saved.push(structuredClone(value)));
  await collect(instrumentation.wrap({
    provider: EXPECTED.provider,
    model: EXPECTED.model,
    reasoningEffort: EXPECTED.reasoning,
    maxTokens: EXPECTED.maxOutputTokens,
  }, async function* () {
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }));
  assert.deepEqual(instrumentation.snapshot(), {
    schemaVersion: 1,
    expected: EXPECTED,
    attempts: [{
      id: 1,
      purpose: "coding",
      status: "completed",
      usage: { inputTokens: 16, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1 },
    }],
    inputTokens: 16,
    outputTokens: 4,
    reasoningTokens: 2,
    cachedInputTokens: 5,
    cacheObservedInputTokens: 16,
    complete: true,
    tokenBudget: 100,
    remainingTokens: 80,
    configurationErrors: [],
  });
  assert.ok(saved.length >= 2);
});

test("dsh instrumentation keeps unknown usage sticky and rejects another provider call", async () => {
  const { createInstrumentation } = await instrumentationModule();
  const instrumentation = createInstrumentation(EXPECTED);
  await collect(instrumentation.wrap({
    provider: EXPECTED.provider,
    model: EXPECTED.model,
    reasoningEffort: EXPECTED.reasoning,
    maxTokens: EXPECTED.maxOutputTokens,
  }, async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { code: "SERVER", message: "failed" } } };
  }));
  let downstreamCalls = 0;
  await collect(instrumentation.wrap({
    provider: EXPECTED.provider,
    model: EXPECTED.model,
    reasoningEffort: EXPECTED.reasoning,
    maxTokens: EXPECTED.maxOutputTokens,
  }, async function* () {
    downstreamCalls += 1;
  }));
  const snapshot = instrumentation.snapshot();
  assert.equal(snapshot.complete, false);
  assert.equal(downstreamCalls, 0);
  assert.deepEqual((snapshot.attempts as Array<{ status: string }>).map((attempt) => attempt.status), ["failed", "rejected"]);
  assert.match((snapshot.configurationErrors as string[])[0]!, /unknown usage/u);
});

test("dedicated dsh profile is created once and mismatched existing files fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "everpeace-dsh-profile-test-"));
  const instrumentationPath = join(root, "instrumentation.mjs");
  await writeFile(instrumentationPath, "export function apply() {}\n", "utf8");
  const options: InstrumentedDshAdapterOptions = {
    sourceRoot: root,
    entryPath: join(root, "bin.js"),
    dshHome: join(root, "home"),
    profile: "everpeace-benchmark",
    revision: PINNED_DSH_REVISION,
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    apiKey: "test-only",
    reasoning: "high",
    maxOutputTokens: 32_768,
    instrumentationPath,
  };
  try {
    await ensureDshBenchmarkProfile(options);
    await ensureDshBenchmarkProfile(options);
    const profileDir = join(options.dshHome, "profiles", options.profile);
    const patch = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
    assert.match(patch, /reasoningEffort: high/u);
    assert.match(patch, /maxTokens: 32768/u);
    assert.match(patch, /everpeace-benchmark-instrumentation/u);
    await writeFile(join(profileDir, "cordis.patch.yml"), `${patch}# changed\n`, "utf8");
    await assert.rejects(ensureDshBenchmarkProfile(options), /does not match/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("campaign config accepts only the reviewed dsh revision and resolves its paths", () => {
  const configPath = resolve("docs/benchmark/campaign.json");
  const base = {
    campaignId: "dsh-smoke",
    catalogPath: "tasks.json",
    fixtureRoot: "fixtures",
    runsRoot: "runs",
    artifactsRoot: "artifacts",
    sessionsRoot: "sessions",
    modelId: "deepseek-flash",
    seed: 1,
    repetitions: 1,
    taskTokenBudget: 1,
    campaignTokenBudget: 1,
    harnesses: [{
      kind: "dsh",
      name: "dsh-fixed",
      sourceRoot: "upstream",
      entryPath: "upstream/apps/cli/lib/bin.js",
      dshHome: "dsh-home",
      profile: "everpeace-benchmark",
      revision: PINNED_DSH_REVISION,
      expected: { model: "deepseek-flash", reasoning: "high", maxOutputTokens: 32_768 },
    }],
  };
  const parsed = parseCampaignConfig(base, configPath);
  assert.equal(parsed.harnesses[0]?.kind, "dsh");
  if (parsed.harnesses[0]?.kind !== "dsh") assert.fail("Expected dsh harness");
  assert.equal(parsed.harnesses[0].sourceRoot, resolve("docs/benchmark/upstream"));
  assert.throws(() => parseCampaignConfig({
    ...base,
    harnesses: [{ ...base.harnesses[0], revision: "deadbeef" }],
  }, configPath), /must be 639ed015/u);
});
