import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCodexProcess } from "../../../src/codex/cli.js";
import { resolveBashLaunch, runBash } from "../../../src/tools/bash.js";
import {
  createEffectiveSandboxPolicy,
  materializeSandboxControlPaths,
  modelShellEnvironment,
  nativePermissionProfileArgs,
} from "../../../src/tools/sandbox-policy.js";

test("model shell strips inherited credentials and startup injection but keeps toolchain paths", () => {
  const source = { Path: "fixture-path", SystemRoot: "fixture-system", TEMP: "fixture-temp", CODEX_HOME: "fixture-home", OPENAI_API_KEY: "fake-key", github_token: "fake-token", DATABASE_PASSWORD: "fake-password", NODE_OPTIONS: "--require malicious.js", BASH_ENV: "malicious.sh", LD_PRELOAD: "malicious.so", PROJECT_SETTING: "yes" };
  assert.deepEqual(modelShellEnvironment(source), { Path: "fixture-path", SystemRoot: "fixture-system", TEMP: "fixture-temp", CODEX_HOME: "fixture-home", PROJECT_SETTING: "yes" });
  assert.equal(source.OPENAI_API_KEY, "fake-key");
});

test("sandbox payload output cannot trigger replay on success or failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-sandbox-replay-"));
  try {
    const script = path.join(root, "fixture.mjs");
    await fs.writeFile(script, "import { appendFileSync } from 'node:fs'; appendFileSync('effects', 'x'); console.log('helper_unknown_error'); console.error('sandbox helper setup failed'); process.exit(Number(process.env.FIXTURE_EXIT));");
    for (const [args, exitCode] of [
      [["sandbox", "--", "payload"], 0],
      [["sandbox", "--", "payload"], 19],
      [["sandbox", "-P", ":workspace", "payload"], 19],
    ] as const) {
      const result = await runCodexProcess(args, { platform: "win32", codexCliPath: script, cwd: root, env: { ...process.env, FIXTURE_EXIT: String(exitCode) } });
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.attempts, 1);
      assert.equal(result.error, undefined);
      assert.equal(await fs.readFile(path.join(root, "effects"), "utf8"), "x");
      await fs.unlink(path.join(root, "effects"));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("model launcher never inherits fake credentials or Node startup code", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-sandbox-env-"));
  try {
    const script = path.join(root, "fixture.mjs");
    await fs.writeFile(script, "console.log(JSON.stringify({ credentialPresent: 'FIXTURE_API_KEY' in process.env, startupPresent: 'NODE_OPTIONS' in process.env, setting: process.env.PROJECT_SETTING }));");
    const result = await runBash("ignored", { cwd: root, streamOutput: false, sandbox: { permissionProfile: ":workspace", codexCliPath: script }, env: { ...process.env, FIXTURE_API_KEY: "fake-key", NODE_OPTIONS: "--require ./must-not-load.cjs", PROJECT_SETTING: "preserved" } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { credentialPresent: false, startupPresent: false, setting: "preserved" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("cancelled sandbox commands do not start a launcher", async () => {
  const signal = AbortSignal.abort();
  const result = await runBash("ignored", { signal, streamOutput: false, sandbox: { permissionProfile: ":workspace", codexCliPath: "missing-launcher.mjs" } });
  assert.equal(result.cancelled, true);
  assert.equal(result.stdout, "");
});

test("effective sandbox policy freezes workspace, state, and backend boundaries", () => {
  const policy = createEffectiveSandboxPolicy(
    { mode: "workspace-write", web: true, shellNetwork: "deny" },
    "C:\\repo",
    ["C:\\skills"],
    { platform: "win32", env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, homeDirectory: "C:\\Users\\test" },
  );
  assert.equal(Object.isFrozen(policy), true);
  assert.deepEqual(policy.workspaceRoots, ["C:\\repo"]);
  assert.deepEqual(policy.materializedControlPaths, ["C:\\repo\\.everpeace"]);
  assert.equal(policy.networkMode, "deny");
  assert.ok(policy.pathRules.some((rule) => rule.path === "C:\\repo\\.everpeace" && rule.access === "read"));
  assert.ok(policy.pathRules.some((rule) => rule.path === "C:\\Users\\test\\AppData\\Roaming\\Everpeace" && rule.access === "none"));
  const args = nativePermissionProfileArgs(policy);
  assert.deepEqual(args.slice(0, 2), ["-P", "everpeace-model-workspace"]);
  assert.match(args.at(-1) ?? "", /extends=":workspace"/u);
  assert.match(args.at(-1) ?? "", /\\\\repo\\\\\.everpeace/iu);
  const launch = resolveBashLaunch("echo safe", { cwd: "C:\\repo", sandbox: { policy, codexCliPath: "C:\\codex.js" } });
  assert.ok(launch.args.includes("--sandbox-state-disable-network"));
});

test("full access remains an explicit native profile exception", () => {
  const policy = createEffectiveSandboxPolicy(
    { mode: "full-access", web: true },
    "/workspace",
    [],
    { platform: "linux", env: {}, homeDirectory: "/home/test" },
  );
  assert.deepEqual(policy.pathRules, []);
  assert.deepEqual(policy.materializedControlPaths, []);
  assert.deepEqual(nativePermissionProfileArgs(policy), ["-P", ":danger-full-access"]);
});

test("sandbox preparation rejects a redirected .everpeace control path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-policy-link-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-policy-target-"));
  try {
    await fs.symlink(target, path.join(root, ".everpeace"), process.platform === "win32" ? "junction" : "dir");
    const policy = createEffectiveSandboxPolicy({ mode: "workspace-write", web: true }, root);
    assert.throws(() => materializeSandboxControlPaths(policy), /real directory/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("native workspace profile blocks model shell writes to .everpeace", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-native-policy-"));
  const stateParent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-native-state-"));
  try {
    const stateRoot = path.join(stateParent, "Everpeace");
    const stateFile = path.join(stateRoot, "private.json");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(stateFile, "fixture-private-state", "utf8");
    const policy = createEffectiveSandboxPolicy(
      { mode: "workspace-write", web: true },
      root,
      [],
      { env: { ...process.env, APPDATA: stateParent } },
    );
    const result = await runBash(
      `Set-Content -LiteralPath 'regular.txt' -Value regular; Set-Content -LiteralPath '.everpeace\\blocked.txt' -Value blocked; Get-Content -LiteralPath '${stateFile.replaceAll("'", "''")}'`,
      { cwd: root, streamOutput: false, sandbox: { policy } },
    );
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, /fixture-private-state/u);
    assert.equal(await fs.readFile(path.join(root, "regular.txt"), "utf8").then(() => true, () => false), true);
    assert.equal(await fs.readFile(path.join(root, ".everpeace", "blocked.txt"), "utf8").then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateParent, { recursive: true, force: true });
  }
});
