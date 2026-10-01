import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCodexProcess } from "../../../src/codex/cli.js";
import { resolveBashLaunch, runBash } from "../../../src/tools/bash.js";
import { CodeNavigationRuntime } from "../../../src/tools/code-navigation.js";
import {
  createEffectiveSandboxPolicy,
  createLspSandboxPolicy,
  materializeSandboxControlPaths,
  modelShellEnvironment,
  nativePermissionProfileArgs,
  nativeLspPermissionProfileArgs,
} from "../../../src/tools/sandbox-policy.js";

test("model shell strips inherited credentials and startup injection but keeps toolchain paths", () => {
  const source = { Path: "fixture-path", SystemRoot: "fixture-system", TEMP: "fixture-temp", CODEX_HOME: "fixture-home", OPENAI_API_KEY: "fake-key", github_token: "fake-token", DATABASE_PASSWORD: "fake-password", NODE_OPTIONS: "--require malicious.js", BASH_ENV: "malicious.sh", LD_PRELOAD: "malicious.so", PROJECT_SETTING: "yes" };
  assert.deepEqual(modelShellEnvironment(source), { Path: "fixture-path", SystemRoot: "fixture-system", TEMP: "fixture-temp", CODEX_HOME: "fixture-home", PROJECT_SETTING: "yes" });
  assert.equal(source.OPENAI_API_KEY, "fake-key");
});

test("language-server policy is read-only, network denied, and rejects protected read roots", () => {
  const root = path.resolve("C:/workspace");
  const policy = createLspSandboxPolicy(root, [path.resolve("C:/tools/typescript")], {
    platform: "win32",
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
    homeDirectory: "C:\\Users\\test",
  });
  const args = nativeLspPermissionProfileArgs(policy);
  assert.equal(policy.networkMode, "deny");
  assert.match(args.join(" "), /everpeace-lsp-readonly/u);
  assert.match(args.join(" "), /:read-only/u);
  assert.throws(() => createLspSandboxPolicy(root, [path.join(root, ".everpeace")], {
    platform: "win32",
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
    homeDirectory: "C:\\Users\\test",
  }), /protected application state/u);
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

test("native workspace profile blocks model shell writes to .everpeace", {
  skip: process.platform !== "win32"
    ? "Windows-only native sandbox integration"
    : process.env.GITHUB_ACTIONS === "true"
      ? "GitHub-hosted Windows cannot initialize the nested native sandbox"
      : false,
  timeout: 20_000,
}, async () => {
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

test("native LSP profile denies writes/state and fails closed when networking remains available", {
  skip: process.platform !== "win32"
    ? "Windows-only native LSP sandbox integration"
    : process.env.GITHUB_ACTIONS === "true"
      ? "GitHub-hosted Windows cannot initialize the nested native sandbox"
      : false,
  timeout: 30_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-native-lsp-"));
  const stateParent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-native-lsp-state-"));
  const server = createServer();
  let connections = 0;
  server.on("connection", (socket) => { connections += 1; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("Expected a TCP listener address");
    const probeHost = Object.values(os.networkInterfaces()).flat().find((candidate) =>
      candidate?.family === "IPv4" && !candidate.internal)?.address;
    if (!probeHost) assert.fail("Native LSP network probe requires a non-loopback IPv4 address");
    const stateRoot = path.join(stateParent, "Everpeace");
    const stateFile = path.join(stateRoot, "private.json");
    const attemptedWrite = path.join(root, "blocked.txt");
    const source = path.join(root, "sample.ts");
    const languageServer = path.join(root, "server.mjs");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(stateFile, "fixture-private-state", "utf8");
    await fs.writeFile(source, "export const value = 1;\n", "utf8");
    await fs.writeFile(languageServer, String.raw`
import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
const [writePath, stateFile, networkHost, portText] = process.argv.slice(2);
let buffer = Buffer.alloc(0);
let evidence;
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
};
const networkDenied = () => new Promise((resolve) => {
  let settled = false;
  let timer;
  const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
  const socket = connect({ host: networkHost, port: Number(portText) });
  socket.once('connect', () => finish(false));
  socket.once('error', () => finish(true));
  timer = setTimeout(() => finish(true), 1000);
});
const receive = async (message) => {
  if (message.method === 'initialize') {
    let writeDenied = false;
    let stateDenied = false;
    try { await fs.writeFile(writePath, 'blocked'); } catch { writeDenied = true; }
    try { await fs.readFile(stateFile, 'utf8'); } catch { stateDenied = true; }
    evidence = { writeDenied, stateDenied, networkDenied: await networkDenied() };
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true } } });
  } else if (message.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: message.id, result: { contents: JSON.stringify(evidence) } });
  }
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) break;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
    if (buffer.length < end + 4 + length) break;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    void receive(message);
  }
});
`, "utf8");
    const policy = createLspSandboxPolicy(root, [path.dirname(process.execPath)], {
      env: { ...process.env, APPDATA: stateParent },
    });
    const runtime = new CodeNavigationRuntime({
      workspacePath: root,
      command: process.execPath,
      args: [languageServer, attemptedWrite, stateFile, probeHost, String(address.port)],
      policy,
      verifyIsolation: false,
    });
    const result = await runtime.query({ operation: "hover", path: "sample.ts", line: 1, column: 1 });
    assert.deepEqual(JSON.parse(result.hover ?? "{}"), { writeDenied: true, stateDenied: true, networkDenied: false });
    assert.equal(connections, 1);
    assert.equal(await fs.stat(attemptedWrite).then(() => true, () => false), false);
    await assert.rejects(runtime.probeIsolation(), /direct networking was permitted/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateParent, { recursive: true, force: true });
  }
});
