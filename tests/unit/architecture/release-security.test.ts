import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { windowsNativeSkip } from "../../fixtures/native-mode.js";
import { writeSupplyChain } from "../../fixtures/supply-chain.js";

const policy = await import(new URL("../../../scripts/release/policy.mjs", import.meta.url).href);
const workflows = await import(new URL("../../../scripts/release/check-workflows.mjs", import.meta.url).href);
const publishing = await import(new URL("../../../scripts/release/publish.mjs", import.meta.url).href);
const queue = await import(new URL("../../../scripts/release/queue-watch.mjs", import.meta.url).href);
const commands = await import(new URL("../../../scripts/release/commands.mjs", import.meta.url).href);

test("release rejects failed, missing, cancelled and skipped required platform results", () => {
  for (const result of [undefined, "failure", "cancelled", "skipped", "pending"]) {
    assert.throws(() => policy.requireSuccess({ linux: "success", windows: result }, ["linux", "windows"]));
  }
  assert.throws(() => policy.candidateSha("main"));
  policy.requireSuccess({ linux: "success", windows: "success" }, ["linux", "windows"]);
});

test("portable candidates cannot use a producer missing the Linux native build", () => {
  policy.requirePortableBuild("linux", "x64");
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["linux", "arm64"]]) assert.throws(() => policy.requirePortableBuild(platform, arch));
});

test("package launchers work through node_modules bin shims and closed exports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-manager-layout-"));
  try {
    const directory = path.join(root, "node_modules/pnpm/bin");
    const shim = path.join(root, "node_modules/.bin/pnpm.cmd");
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(path.dirname(shim));
    await fs.writeFile(shim, "This shell fixture must never run.\n");
    await fs.writeFile(path.join(directory, "../package.json"), '{"name":"pnpm","exports":{}}');
    const entry = path.join(directory, "pnpm.cjs");
    await fs.writeFile(entry, "console.log('fixture-manager');\n");
    const launcher = commands.findManagerLauncher("pnpm", [shim]);
    assert.equal(launcher, entry);
    assert.match(await commands.runCommand(process.execPath, [launcher, "--version"]), /fixture-manager/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a dedicated runner disappearing after preflight cancels only the current run", async () => {
  let time = 0;
  const mutations: string[] = [];
  await assert.rejects(queue.watchQueue({ repo: "fixture/repository", run: "123", limitMs: 10, now: () => time, sleep: async () => { time += 5; }, api: async (endpoint: string, options: { method?: string } = {}) => {
    if (options.method) mutations.push(endpoint);
    return { jobs: [{ name: "native / native", status: "queued" }] };
  } }), /did not start/u);
  assert.deepEqual(mutations, ["repos/fixture/repository/actions/runs/123/cancel"]);
  await queue.watchQueue({ repo: "fixture/repository", run: "123", api: async () => ({ jobs: [{ name: "native / native", status: "in_progress" }] }) });
});

test("remote actions and containers require immutable identities", () => {
  for (const reference of ["actions/checkout@v5", "owner/workflow@main", "docker://alpine:latest"]) assert.throws(() => workflows.inspectWorkflow({ jobs: { task: { steps: [{ uses: reference }] } } }));
  assert.throws(() => workflows.inspectWorkflow({ jobs: { task: { container: "alpine:latest" } } }));
  for (const on of ["pull_request_target", ["pull_request_target"], { pull_request_target: null }]) assert.throws(() => workflows.inspectWorkflow({ on }));
  workflows.checkWorkflows(process.cwd());
});

test("required native mode overrides Actions presence and rejects hosted or unsupported platforms", () => {
  assert.equal(windowsNativeSkip({ GITHUB_ACTIONS: "true", EVERPEACE_NATIVE_REQUIRED: "1" }, "win32"), false);
  assert.equal(windowsNativeSkip({ GITHUB_ACTIONS: "true" }, "win32"), false);
  assert.ok(windowsNativeSkip({ EVERPEACE_NATIVE_MODE: "hosted" }, "win32"));
  assert.throws(() => windowsNativeSkip({ EVERPEACE_NATIVE_REQUIRED: "1", EVERPEACE_NATIVE_MODE: "hosted" }, "win32"));
  assert.throws(() => windowsNativeSkip({ EVERPEACE_NATIVE_REQUIRED: "1" }, "linux"));
  const events = policy.nativeTests.map((name: string) => ({ type: "test:pass", data: { name } }));
  policy.requireNativeResults(events);
  assert.throws(() => policy.requireNativeResults(events.slice(1)));
  assert.throws(() => policy.requireNativeResults([...events, events[0]]));
  for (const property of ["skip", "todo"]) assert.throws(() => policy.requireNativeResults([{ ...events[0], data: { ...events[0].data, [property]: true } }, ...events.slice(1)]));
});

test("publishing performs zero mutations for failed gates, mismatched packages or conflicting tags", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-release-policy-"));
  const sha = "a".repeat(40);
  const bytes = Buffer.from("fixture package");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const receipt = { schema: 1, commit: sha, dirty: false, version: "1.2.3", filename: "everpeace-1.2.3.tgz", sha256: hash };
  const checks = Object.fromEntries(["candidate", "package", "consumers", "security", "evidence", "native", "gate"].map((name) => [name, "success"]));
  const mutations: string[] = [];
  const api = async (endpoint: string, options: { method?: string } = {}) => {
    if (options.method) mutations.push(endpoint);
    if (endpoint.includes("git/ref")) return { object: { type: "tag", sha: "c".repeat(40) } };
    if (endpoint.includes("git/tags")) return { object: { type: "commit", sha: "b".repeat(40) } };
    return undefined;
  };
  try {
    await fs.writeFile(path.join(directory, receipt.filename), bytes);
    await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt));
    await writeSupplyChain(directory, sha, hash);
    const arguments_ = { directory, sha, packageDigest: hash, checks, repo: "fixture/repository", api };
    await assert.rejects(publishing.publish({ ...arguments_, checks: { ...checks, native: "skipped" } }));
    await assert.rejects(publishing.publish({ ...arguments_, sha: "b".repeat(40) }));
    await assert.rejects(publishing.publish({ ...arguments_, packageDigest: "b".repeat(64) }));
    await assert.rejects(publishing.publish(arguments_), /Existing tag belongs/u);
    assert.deepEqual(mutations, []);
    await fs.writeFile(path.join(directory, receipt.filename), "tampered");
    await assert.rejects(publishing.publish(arguments_), /Package bytes differ/u);
    assert.deepEqual(mutations, []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("lint fixture and Windows failure drill return nonzero", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-lint-gate-"));
  try {
    const fixture = path.join(directory, "invalid.ts");
    await fs.writeFile(fixture, "console.log(5 === NaN);\n");
    const require = createRequire(import.meta.url);
    const launcher = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
    const lint = spawnSync(process.execPath, [launcher, "--config", ".oxlintrc.json", "--max-warnings", "0", fixture], { encoding: "utf8", windowsHide: true });
    assert.notEqual(lint.status, 0);
    assert.match(lint.stdout + lint.stderr, /NaN|isnan/iu);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    assert.throws(() => execFileSync(process.execPath, ["--test", "tests/fixtures/release-failure.mjs"], { env, stdio: "pipe", windowsHide: true }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("installation command timeout waits for its owned process tree", { timeout: 15_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-install-tree-"));
  const marker = path.join(root, "pids.json");
  const source = "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',\"console.log('ready');setInterval(()=>{},1000)\"],{detached:process.platform==='win32',windowsHide:true,stdio:['ignore','pipe','inherit']});child.stdout.once('data',()=>writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid])));setInterval(()=>{},1000);";
  let pids: number[] = [];
  try {
    await assert.rejects(commands.runCommand(process.execPath, ["-e", source, marker], { timeout: 2000 }), /cancelled or timed out/u);
    pids = JSON.parse(await fs.readFile(marker, "utf8"));
    assert.equal(pids.length, 2);
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        if (process.platform === "linux") {
          const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ") Z "; throw error; });
          assert.match(stat, /\) [ZX] /u);
        } else assert.fail("Installation fixture process survived timeout");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  } finally {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Owned fixture already gone. */ } }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
