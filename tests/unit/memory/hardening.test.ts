import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LearnedMemoryRuntime, LearnedMemoryStore, memoryEntryRevision, redactSecrets, serializeEntries, type MemoryCandidate } from "../../../src/memory/learned-memory.js";

const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const response = (entries: unknown[]) => ({ id: "offline", status: "completed", output: [], usage, output_text: JSON.stringify({ entries }) });
const turn = (workspacePath: string, userInput = "Fix the fixture") => ({ workspacePath, userInput, transcript: "Verified fixture results", assistantText: "done", toolCallCount: 1 });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > until) assert.fail("Memory fixture did not settle"); await new Promise(done => setTimeout(done, 10)); }
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ep-memory-hardening-"));
  const owners: Array<() => Promise<void>> = [];
  const own = (runtime: LearnedMemoryRuntime, release?: () => void) => owners.push(async () => { release?.(); await runtime.dispose(); });
  t.after(async () => { for (const close of owners) await close(); assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, own, store: new LearnedMemoryStore({ directory: path.join(root, "memory") }) };
}

test("Memory completely redacts quoted credentials and remains idempotent across disk reads", async t => {
  const { root, store } = await fixture(t);
  for (const value of ['password="synthetic first tail"', "password='synthetic first tail'", JSON.stringify({ password: 'synthetic escaped" tail' })]) {
    const clean = redactSecrets(value);
    assert.doesNotMatch(clean, /synthetic|first|tail|escaped/u);
    assert.equal(redactSecrets(clean), clean);
    await store.append("user", root, [{ lesson: value, applyWhen: "fixture", reviewedAt: new Date().toISOString() }]);
  }
  assert.doesNotMatch(await fs.readFile(store.filePath("user", root), "utf8"), /synthetic|first|tail|escaped/u);
  assert.deepEqual(await store.read("user", root), await store.read("user", root));
});

test("old partially redacted Memory is masked and withheld until corrected", async t => {
  const { root, store } = await fixture(t);
  const file = store.filePath("user", root); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '# Learned Experience\n\n### 2026-01-01 · User · oldentry123\n- Lesson: password=[secret redacted] remaining-secret\n- Apply when: fixture\n- Reviewed at: 2026-01-01T00:00:00Z\n');
  const entry = (await store.read("user", root))[0]!;
  assert.doesNotMatch(JSON.stringify(entry), /remaining-secret/u);
  assert.equal((await store.snapshot(root)).text, "");
  assert.equal((await store.status(root)).needsReview, 1);
  await store.reviewEntry("user", root, entry.id, memoryEntryRevision(entry), "correct", { lesson: "Safe preference", applyWhen: "fixture" });
  assert.match((await store.snapshot(root)).text, /Safe preference/u);
});

test("capture preserves independent candidates and redacts requests and outputs before persistence", async t => {
  const { root, store, own } = await fixture(t); const requests: unknown[] = [];
  const source = ['password="synthetic-quoted tail with space"', JSON.stringify({ access_token: 'synthetic-escaped" tail' }), `-----BEGIN PRIVATE KEY-----\n${"SYNTHETICKEY".repeat(400)}`].join("\n");
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false, client: { responses: { async create(request) {
    requests.push(request);
    if (requests.length === 2) assert.doesNotMatch(await fs.readFile(path.join(store.directory, "capture-jobs.json"), "utf8"), /synthetic-|SYNTHETICKEY/u);
    return response(requests.length === 1
      ? [{ lesson: 'Use fixture password="synthetic-extracted value"', applyWhen: "case A", extra: { credentials: "synthetic-unexpected-field" } }, { lesson: JSON.stringify({ api_key: "synthetic-output value" }), applyWhen: "case B", kind: { credentials: "synthetic-invalid-kind" } }]
      : [{ lesson: JSON.stringify({ password: 'synthetic-merged" tail' }), applyWhen: "fixture" }]);
  } } } });
  own(runtime);
  await runtime.finishTurn({ ...turn(root), userInput: `Fix fixture ${source}`, assistantText: source, transcript: source }, "verified");
  await waitFor(async () => (await runtime.status(root)).capture?.state === "succeeded");
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /synthetic-|SYNTHETICKEY/u);
  for (const file of [store.filePath("project", root), path.join(store.directory, "capture-jobs.json"), path.join(store.directory, "memory-candidates.json")]) {
    assert.doesNotMatch(await fs.readFile(file, "utf8"), /synthetic-|SYNTHETICKEY/u);
  }
  const entries = await store.read("project", root);
  assert.equal(entries.length, 2);
  assert.equal(redactSecrets(entries[0]!.lesson), entries[0]!.lesson);
});

test("keywords cannot admit non-verified turns or persisted non-verified jobs", async t => {
  const { root, store, own } = await fixture(t); let requests = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false, client: { responses: { async create() { requests++; return response([]); } } } });
  own(runtime);
  for (const outcome of ["failed", "unverified", "cancelled", "stopped"] as const) await runtime.finishTurn(turn(root, "Always remember 记住 fixture"), outcome);
  assert.equal((await store.loadJobs()).length, 0);
  await runtime.dispose();
  await store.saveJobs([
    ...(["failed", "unverified", "cancelled", "stopped"] as const).map(outcome => ({ id: `old-${outcome}`, turn: turn(root, "Remember fixture"), outcome, status: "queued" as const, attempts: 0, createdAt: new Date(0).toISOString(), notBefore: new Date(0).toISOString(), requestPending: false, usageComplete: true })),
    { id: "old-unsettled", turn: turn(root, "Remember fixture"), outcome: "unverified", status: "running", attempts: 1, createdAt: new Date(0).toISOString(), notBefore: new Date(Date.now() + 60_000).toISOString() },
  ]);
  const resumed = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false, client: { responses: { async create() { requests++; return response([]); } } } });
  own(resumed);
  await resumed.loadPrompt(root);
  assert.equal(requests, 0);
  assert.ok((await store.loadJobs()).every(job => job.status === "failed"));
  assert.equal((await store.loadJobs()).find(job => job.id === "old-unsettled")?.usageComplete, false);
  assert.equal((await resumed.status(root)).capture?.usage, null);
});

test("new Memory survives the capacity limit and expired entries are evicted first", async t => {
  const { root, store } = await fixture(t);
  await store.append("project", root, Array.from({ length: 100 }, (_, i) => ({ lesson: `Existing ${i}`, applyWhen: `Fixture ${i}`, reviewedAt: new Date().toISOString(), ...(i === 99 ? { expiresAt: new Date(0).toISOString() } : {}) })));
  await store.append("project", root, [{ lesson: "New lesson", applyWhen: "New fixture", reviewedAt: new Date().toISOString() }]);
  const entries = await store.read("project", root);
  assert.equal(entries.filter(entry => entry.status === "active").length, 100);
  assert.equal(entries.find(entry => entry.lesson === "New lesson")?.status, "active");
  assert.equal(entries.find(entry => entry.lesson === "Existing 99")?.status, "archived");
  const expired = entries.find(entry => entry.lesson === "Existing 99")!;
  await store.reviewEntry("project", root, expired.id, memoryEntryRevision(expired), "renew");
  const renewed = await store.read("project", root);
  assert.equal(renewed.filter(entry => entry.status === "active").length, 100);
  assert.equal(renewed.find(entry => entry.id === expired.id)?.status, "active");
  const active = renewed.find(entry => entry.lesson === "New lesson")!;
  await store.reviewEntry("project", root, active.id, memoryEntryRevision(active), "correct", { lesson: "Corrected new lesson", applyWhen: "New fixture" });
  const corrected = await store.read("project", root);
  assert.equal(corrected.filter(entry => entry.status === "active").length, 100);
  assert.equal(corrected.find(entry => entry.lesson === "Corrected new lesson")?.status, "active");
});

test("stale review is recoverable and does not poison the next task", async t => {
  const { root, store, own } = await fixture(t);
  await store.append("user", root, [{ lesson: "Preference", applyWhen: "fixture" }]);
  const entry = (await store.read("user", root))[0]!;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false }, client: { responses: { async create() { return response([]); } } } });
  own(runtime);
  await assert.rejects(runtime.reviewEntry("user", root, entry.id, "stale", "renew"), /preview changed/u);
  await runtime.beginTask(); await runtime.endTask();
  await runtime.reviewEntry("user", root, entry.id, memoryEntryRevision(entry), "renew");
});

test("a second runtime clear fences an already staged automatic write", async t => {
  const { root, store: other, own } = await fixture(t); const entered = gate(), release = gate();
  class PausedStore extends LearnedMemoryStore {
    override async append(...args: Parameters<LearnedMemoryStore["append"]>) { if (args[3]?.beforeCommit) { entered.resolve(); await release.promise; } await super.append(...args); }
  }
  const store = new PausedStore({ directory: other.directory });
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false, client: { responses: { async create() { return response([{ lesson: "Old late result", applyWhen: "fixture" }]); } } } });
  own(runtime, release.resolve);
  await runtime.finishTurn(turn(root), "verified"); await entered.promise;
  await other.clear("project", root); release.resolve();
  await waitFor(async () => (await runtime.status(root)).capture?.state !== "running");
  assert.equal((await other.read("project", root)).length, 0);
});

test("global user clear revokes other workspaces while preserving project learning and unknown usage", async t => {
  const { root, store, own } = await fixture(t); const workspace = path.join(root, "other");
  const paused = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 100_000, client: { responses: { async create() { return response([]); } } } });
  await paused.finishTurn(turn(workspace, "Remember my preference while fixing fixture"), "verified"); await paused.dispose();
  await store.updateJobs(jobs => [...jobs, { ...jobs[0]!, id: "unknown", status: "failed", usageComplete: false }]);
  await store.clear("user", root);
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false, client: { responses: { async create() { return response([{ scope: "user", lesson: "Old preference", applyWhen: "all" }, { scope: "project", lesson: "Valid project result", applyWhen: "fixture" }]); } } } });
  own(runtime);
  await waitFor(async () => (await store.read("project", workspace)).length === 1);
  assert.equal((await store.read("user", root)).length, 0);
  assert.equal((await runtime.status(workspace)).capture?.usage, null);
});

test("a project clear during mixed submission preserves the still-authorized user material", async t => {
  const { root, store: clearing, own } = await fixture(t); const entered = gate(), release = gate();
  class PausedStore extends LearnedMemoryStore {
    override async append(...args: Parameters<LearnedMemoryStore["append"]>) {
      if (args[0] === "project" && args[3]?.job) { entered.resolve(); await release.promise; }
      return super.append(...args);
    }
  }
  const store = new PausedStore({ directory: clearing.directory });
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false, client: { responses: { async create() {
    return response([{ scope: "project", lesson: "Revoked project material", applyWhen: "fixture" }, { scope: "user", lesson: "Valid user preference", applyWhen: "future work" }]);
  } } } });
  own(runtime, release.resolve);
  await runtime.finishTurn(turn(root, "Remember my preference and fix fixture"), "verified"); await entered.promise;
  await clearing.clear("project", root); release.resolve();
  await waitFor(async () => (await runtime.status(root)).capture?.state === "succeeded");
  assert.equal((await store.read("project", root)).length, 0);
  assert.equal((await store.read("user", root))[0]?.lesson, "Valid user preference");
});

test("extracted conflicts are visible and have a revision-bound review lifecycle", async t => {
  const { root, store, own } = await fixture(t); let requests = 0;
  await store.append("project", root, [{ lesson: "Use npm", applyWhen: "Node projects", reviewedAt: new Date().toISOString() }]);
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false, client: { responses: { async create() { return response(++requests === 1 ? [{ lesson: "Use pnpm", applyWhen: "Node projects" }] : []); } } } });
  own(runtime);
  await runtime.finishTurn(turn(root), "verified"); await waitFor(async () => (await runtime.status(root)).capture?.state === "succeeded");
  const status = await store.status(root);
  assert.equal(status.needsReview, 1);
  assert.equal((await store.read("project", root)).filter(entry => entry.status === "active").length, 1);
  const candidates = await store.listReviewCandidates(root); assert.equal(candidates.length, 1);
  const preview = await store.previewCandidate(root, candidates[0]!.id);
  await assert.rejects(store.reviewCandidate(root, preview.candidate.id, "stale", "accept"));
  await store.reviewCandidate(root, preview.candidate.id, preview.revision, "accept");
  const entries = await store.read("project", root);
  assert.equal(entries.find(entry => entry.lesson === "Use npm")?.status, "superseded");
  assert.equal(entries.find(entry => entry.lesson === "Use pnpm")?.status, "active");
  assert.match(serializeEntries(entries), /Supersedes/u);
  assert.equal((await store.status(root)).needsReview, 0);
  await assert.rejects(store.reviewCandidate(root, preview.candidate.id, preview.revision, "accept"));
});

async function candidate(store: LearnedMemoryStore, workspacePath: string, id: string, lesson = "Use pnpm"): Promise<MemoryCandidate> {
  return { id, workspacePath, scope: "project", kind: "convention", confidence: "high", lesson, applyWhen: "Node projects", createdAt: new Date().toISOString(),
    redactionVersion: 2, epochs: await store.captureEpochs(workspacePath), status: "review", evidence: [{ createdAt: new Date().toISOString(), excerpt: "Verified fixture" }] };
}

test("candidate correction, rejection and visibility survive reconstruction without reactivation", async t => {
  const { root, store } = await fixture(t);
  const first = await candidate(store, root, "candidate-first");
  const second = await candidate(store, root, "candidate-second", "Use yarn");
  const foreign = await candidate(store, path.join(root, "other"), "candidate-foreign");
  const user = { ...await candidate(store, path.join(root, "other"), "candidate-user"), scope: "user" as const };
  await store.saveCandidates([first, second, foreign, user]);
  assert.deepEqual((await store.listReviewCandidates(root)).map(item => item.id), [first.id, second.id, user.id]);
  const rejected = await store.previewCandidate(root, first.id);
  await store.reviewCandidate(root, first.id, rejected.revision, "reject");
  await store.updateCandidates(() => [first, second, foreign, user]);
  assert.equal((await store.loadCandidates()).find(item => item.id === first.id)?.status, "rejected");
  const correction = { lesson: "Use the corrected runner", applyWhen: "Fixture validation" };
  const preview = await store.previewCandidate(root, second.id, correction);
  await store.reviewCandidate(root, second.id, preview.revision, "correct", correction);
  const reopened = new LearnedMemoryStore({ directory: store.directory });
  assert.equal((await reopened.read("project", root))[0]?.lesson, correction.lesson);
  assert.deepEqual((await reopened.listReviewCandidates(root)).map(item => item.id), [user.id]);
  await assert.rejects(reopened.previewCandidate(root, foreign.id));
});

test("candidate review binds all affected entry revisions and supersedes multiple conflicts", async t => {
  const { root, store } = await fixture(t);
  await store.append("project", root, [{ lesson: "Use npm", applyWhen: "Node projects" }, { lesson: "Use yarn", applyWhen: "Node projects" }]);
  const item = await candidate(store, root, "candidate-multiple"); await store.saveCandidates([item]);
  const stale = await store.previewCandidate(root, item.id);
  const entry = (await store.read("project", root))[0]!;
  await store.reviewEntry("project", root, entry.id, memoryEntryRevision(entry), "renew");
  await assert.rejects(store.reviewCandidate(root, item.id, stale.revision, "accept"), /preview changed/u);
  const fresh = await store.previewCandidate(root, item.id);
  await store.reviewCandidate(root, item.id, fresh.revision, "accept");
  const entries = await store.read("project", root);
  assert.equal(entries.filter(value => value.status === "superseded").length, 2);
  assert.equal(entries.find(value => value.status === "active")?.supersedesIds?.length, 2);
});

test("the final commit serializes simultaneous conflicting jobs", async t => {
  const { root, store } = await fixture(t);
  const items = await Promise.all([candidate(store, root, "simultaneous-a", "Use npm"), candidate(store, root, "simultaneous-b", "Use pnpm")]);
  const jobs = items.map((item, index) => ({ id: `job-${index}`, turn: turn(root), outcome: "verified" as const, status: "running" as const, epochs: item.epochs!,
    attempts: 0, createdAt: item.createdAt, notBefore: new Date(Date.now() + 60_000).toISOString(), requestPending: false, usageComplete: true }));
  await store.saveJobs(jobs);
  await store.saveCandidates(items.map(item => ({ ...item, status: "pending" })));
  await Promise.all(items.map((item, index) => new LearnedMemoryStore({ directory: store.directory }).append("project", root, [{ lesson: item.lesson, applyWhen: item.applyWhen, evidence: item.evidence }], { job: jobs[index]!, candidates: [item] })));
  assert.equal((await store.read("project", root)).filter(item => item.status === "active").length, 1);
  assert.equal((await store.listReviewCandidates(root)).length, 1);
});

function worker(mode: string, directory: string, workspace: string, args: string[] = []) {
  const child = fork(path.resolve("tests/fixtures/memory-control-worker.ts"), [mode, directory, workspace, ...args], { execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  const messages: Array<Record<string, unknown>> = []; let output = "";
  child.on("message", message => messages.push(message as Record<string, unknown>));
  child.stderr?.on("data", data => { output += String(data); });
  const exited = once(child, "exit");
  return { child, exited, async message(type: string) {
    await waitFor(async () => { if (messages.some(message => message.type === type)) return true; assert.equal(child.exitCode, null, output); return false; });
    return messages.find(message => message.type === type)!;
  } };
}
async function stop(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }

test("two real processes cannot commit a manual or staged automatic result after clear", { timeout: 30_000 }, async t => {
  const { root, store } = await fixture(t);
  for (const mode of ["manual", "automatic"]) {
    const producer = worker(mode, store.directory, root);
    try {
      await producer.message("checkpoint");
      const clearing = worker("clear", store.directory, root, [mode === "manual" ? "user" : "project"]);
      await clearing.message("done"); await clearing.exited;
      producer.child.send({ release: true });
      const result = await producer.message("done"); await producer.exited;
      assert.equal(result.success, false);
      assert.deepEqual(result.usage, usage);
      assert.equal((await store.read(mode === "manual" ? "user" : "project", root)).length, 0);
    } finally { await stop(producer.child); }
  }
});

test("interrupted clear and candidate acceptance recover atomically before readers", { timeout: 30_000 }, async t => {
  const { root, store } = await fixture(t);
  await store.append("user", root, [{ lesson: "Unrelated preference", applyWhen: "all" }]);
  for (const mode of ["crash-clear", "crash-review"]) {
    await store.append("project", root, [{ lesson: "Use npm", applyWhen: "Node projects" }]);
    const item = await candidate(store, root, "crash-candidate"); await store.saveCandidates([item]);
    const preview = await store.previewCandidate(root, item.id);
    const child = worker(mode, store.directory, root, [item.id, preview.revision]);
    await child.message("checkpoint"); await stop(child.child);
    const old = new Date(0); await fs.utimes(path.join(store.directory, "memory-control.json.lock"), old, old);
    const reopened = new LearnedMemoryStore({ directory: store.directory });
    const entries = await reopened.read("project", root);
    if (mode === "crash-clear") assert.equal(entries.length, 0);
    else { assert.equal(entries.find(entry => entry.lesson === "Use npm")?.status, "superseded"); assert.equal(entries.find(entry => entry.lesson === "Use pnpm")?.status, "active"); }
    assert.equal((await reopened.listReviewCandidates(root)).length, 0);
    assert.equal((await reopened.read("user", root)).length, 1);
    await assert.rejects(fs.access(path.join(store.directory, "memory-transaction.json")));
  }
});

test("corrupt control metadata is reported without resetting revocations", async t => {
  const { root, store } = await fixture(t);
  await store.clear("project", root);
  const file = path.join(store.directory, "memory-control.json");
  await fs.writeFile(file, '{"schemaVersion":1,"global":0,"user":0,"projects":{"invalid":0}}');
  await assert.rejects(store.read("project", root), /Invalid Memory control/u);
  assert.match(await fs.readFile(file, "utf8"), /invalid/u);
});
