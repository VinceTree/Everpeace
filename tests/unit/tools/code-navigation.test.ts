import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CodeNavigationRuntime, LanguageServerIsolationError, parseCodeNavigationArguments, type LanguageServerProcessFactory } from "../../../src/tools/code-navigation.js";
import { createLspSandboxPolicy } from "../../../src/tools/sandbox-policy.js";

const startTestProcess: LanguageServerProcessFactory = ({ command, args, cwd }) => {
  const child = spawn(command, [...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  return {
    stdout: child.stdout,
    exit,
    write(data) {
      return new Promise<void>((resolve, reject) => child.stdin.write(data, (error) => error ? reject(error) : resolve()));
    },
    closeInput() { child.stdin.end(); },
    async terminate() {
      if (child.exitCode === null) child.kill();
      await exit;
    },
  };
};

const fakeServer = String.raw`
let buffer = Buffer.alloc(0);
const documents = new Map();
let editRejected = false;
let waitingDefinition;
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
};
const replyDefinition = (message) => send({
  jsonrpc: '2.0',
  id: message.id,
  result: [{ uri: message.params.textDocument.uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } } }],
});
const receive = (message) => {
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true, hoverProvider: true, textDocumentSync: { openClose: true } } } });
  else if (message.method === 'initialized') send({ jsonrpc: '2.0', id: 'server-edit', method: 'workspace/applyEdit', params: { edit: { changes: {} } } });
  else if (message.id === 'server-edit') {
    editRejected = Boolean(message.error);
    if (editRejected && waitingDefinition) replyDefinition(waitingDefinition);
  } else if (message.method === 'textDocument/didOpen') documents.set(message.params.textDocument.uri, message.params.textDocument.text);
  else if (message.method === 'textDocument/definition') {
    if (editRejected) replyDefinition(message);
    else waitingDefinition = message;
  } else if (message.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'plaintext', value: documents.get(message.params.textDocument.uri) } } });
  }
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) break;
    const header = buffer.subarray(0, end).toString('ascii');
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    if (buffer.length < end + 4 + length) break;
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
    buffer = buffer.subarray(end + 4 + length);
    receive(JSON.parse(body));
  }
});
`;

test("read-only TypeScript navigation rejects server edits and reads current document contents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-code-navigation-"));
  try {
    const server = path.join(root, "server.mjs");
    const source = path.join(root, "sample.ts");
    await fs.writeFile(server, fakeServer, "utf8");
    await fs.writeFile(source, "export const first = 1;\n", "utf8");
    const runtime = new CodeNavigationRuntime({
      workspacePath: root,
      command: process.execPath,
      args: [server],
      policy: createLspSandboxPolicy(root),
      startProcess: startTestProcess,
    });

    const definition = await runtime.query({ operation: "definition", path: "sample.ts", line: 1, column: 14 });
    assert.deepEqual(definition.locations, [{ path: "sample.ts", line: 2, column: 3, endLine: 2, endColumn: 8 }]);

    const firstHover = await runtime.query({ operation: "hover", path: "sample.ts", line: 1, column: 14 });
    assert.match(firstHover.hover ?? "", /first = 1/u);
    await fs.writeFile(source, "export const second = 2;\n", "utf8");
    const secondHover = await runtime.query({ operation: "hover", path: "sample.ts", line: 1, column: 14 });
    assert.match(secondHover.hover ?? "", /second = 2/u);
    assert.doesNotMatch(secondHover.hover ?? "", /first = 1/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("code navigation rejects positions outside current UTF-16 text and unsupported capabilities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-code-navigation-capabilities-"));
  try {
    const server = path.join(root, "server.mjs");
    const source = path.join(root, "sample.ts");
    await fs.writeFile(server, fakeServer, "utf8");
    await fs.writeFile(source, "export const value = 1;\n", "utf8");
    const runtime = new CodeNavigationRuntime({
      workspacePath: root,
      command: process.execPath,
      args: [server],
      policy: createLspSandboxPolicy(root),
      startProcess: startTestProcess,
    });
    await assert.rejects(runtime.query({ operation: "hover", path: "sample.ts", line: 9, column: 1 }), /UTF-16 document bounds/u);
    await assert.rejects(runtime.query({ operation: "references", path: "sample.ts", line: 1, column: 1 }), /does not advertise references/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("code navigation validates one-based UTF-16 positions", () => {
  assert.deepEqual(parseCodeNavigationArguments('{"operation":"hover","path":"x.ts","line":1,"column":2}'), {
    operation: "hover",
    path: "x.ts",
    line: 1,
    column: 2,
  });
  assert.throws(() => parseCodeNavigationArguments('{"operation":"hover","path":"x.ts","line":0,"column":2}'), /Invalid/u);
});

test("code navigation accepts fragmented frames and rejects malformed frames", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-code-navigation-frames-"));
  try {
    const source = path.join(root, "sample.ts");
    const fragmentedServer = path.join(root, "fragmented.mjs");
    const malformedServer = path.join(root, "malformed.mjs");
    await fs.writeFile(source, "export const value = 1;\n", "utf8");
    await fs.writeFile(fragmentedServer, String.raw`
let buffer = Buffer.alloc(0);
const send = async (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]);
  for (const byte of frame) { process.stdout.write(Buffer.from([byte])); await new Promise((resolve) => setImmediate(resolve)); }
};
const receive = (message) => {
  if (message.method === 'initialize') void send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true, textDocumentSync: 1 } } });
  else if (message.method === 'textDocument/hover') void send({ jsonrpc: '2.0', id: message.id, result: { contents: 'fragmented' } });
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) break;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
    if (buffer.length < end + 4 + length) break;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    receive(message);
  }
});
`, "utf8");
    await fs.writeFile(malformedServer, "process.stdin.once('data', () => process.stdout.write('Content-Length: invalid\\r\\n\\r\\n{}'));\n", "utf8");
    const policy = createLspSandboxPolicy(root);
    const fragmented = new CodeNavigationRuntime({ workspacePath: root, command: process.execPath, args: [fragmentedServer], policy, startProcess: startTestProcess });
    assert.equal((await fragmented.query({ operation: "hover", path: "sample.ts", line: 1, column: 1 })).hover, "fragmented");
    const malformed = new CodeNavigationRuntime({ workspacePath: root, command: process.execPath, args: [malformedServer], policy, startProcess: startTestProcess });
    await assert.rejects(malformed.query({ operation: "hover", path: "sample.ts", line: 1, column: 1 }), /invalid JSON-RPC frame/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("code navigation cancels on permission revision changes and requires successful cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-code-navigation-lifecycle-"));
  try {
    const server = path.join(root, "server.mjs");
    const source = path.join(root, "sample.ts");
    await fs.writeFile(server, fakeServer, "utf8");
    await fs.writeFile(source, "export const value = 1;\n", "utf8");
    let revision = "one";
    const hangingServer = path.join(root, "hanging.mjs");
    await fs.writeFile(hangingServer, String.raw`
let buffer = Buffer.alloc(0);
const send = (message) => { const body = Buffer.from(JSON.stringify(message)); process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n'); process.stdout.write(body); };
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return;
  const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
  if (buffer.length < end + 4 + length) return;
  const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
  buffer = buffer.subarray(end + 4 + length);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true, textDocumentSync: 2 } } });
});
`, "utf8");
    const policy = createLspSandboxPolicy(root);
    const slowWriteServer: LanguageServerProcessFactory = (options) => {
      const processHandle = startTestProcess(options);
      return {
        ...processHandle,
        async write(data) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          await processHandle.write(data);
        },
      };
    };
    const changing = new CodeNavigationRuntime({
      workspacePath: root,
      command: process.execPath,
      args: [hangingServer],
      policy,
      startProcess: slowWriteServer,
      permissionRevision: () => revision,
    });
    const pending = changing.query({ operation: "hover", path: "sample.ts", line: 1, column: 1 });
    setTimeout(() => { revision = "two"; }, 50).unref?.();
    await assert.rejects(pending, /Permission policy changed/u);

    const cleanupFailure: LanguageServerProcessFactory = (options) => {
      const processHandle = startTestProcess(options);
      return { ...processHandle, async terminate() { await processHandle.terminate(); throw new Error("fixture cleanup failed"); } };
    };
    const cleanup = new CodeNavigationRuntime({ workspacePath: root, command: process.execPath, args: [server], policy, startProcess: cleanupFailure });
    await assert.rejects(cleanup.query({ operation: "hover", path: "sample.ts", line: 1, column: 1 }), /fixture cleanup failed/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("code navigation fails closed when a process transport permits direct networking", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-code-navigation-isolation-"));
  try {
    const runtime = new CodeNavigationRuntime({
      workspacePath: root,
      command: process.execPath,
      policy: createLspSandboxPolicy(root),
      startProcess: startTestProcess,
      verifyIsolation: false,
    });
    await assert.rejects(runtime.probeIsolation(), /direct networking was permitted/u);
    assert.deepEqual({ ...runtime.getIsolationEvidence(), target: undefined }, {
      outcome: "allowed", positiveControl: "passed", transport: "tcp_ipv4", target: undefined, reason: "connection_succeeded",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("code navigation rejects protected inputs and aliases before forwarding document bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-navigation-protected-"));
  try {
    const protectedDirectories = [".git", ".codex", ".agents", ".everpeace", "application-state/Everpeace"];
    for (const directory of protectedDirectories) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
      await fs.writeFile(path.join(root, directory, "private.ts"), "const secret = 'fixture-private';\n");
    }
    await fs.symlink(path.join(root, ".everpeace"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    let launches = 0;
    const policy = createLspSandboxPolicy(root);
    const runtime = new CodeNavigationRuntime({
      workspacePath: root, command: process.execPath,
      policy: { ...policy, deniedRoots: [...policy.deniedRoots, path.join(root, "application-state", "Everpeace")] },
      startProcess() { launches += 1; throw new Error("Protected source reached the process boundary"); },
    });
    for (const directory of [...protectedDirectories, "alias"]) {
      await assert.rejects(runtime.query({ operation: "hover", path: `${directory}/private.ts`, line: 1, column: 1 }), /protected application state or control metadata/u);
    }
    assert.equal(launches, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("code navigation removes protected, aliased and external result locations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-navigation-results-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-navigation-outside-"));
  try {
    await fs.mkdir(path.join(root, ".everpeace"));
    await fs.writeFile(path.join(root, ".everpeace", "private.ts"), "private");
    await fs.writeFile(path.join(root, "source.ts"), "const value = 1;\n");
    await fs.writeFile(path.join(outside, "outside.ts"), "outside");
    await fs.symlink(path.join(root, ".everpeace"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const locations = [path.join(root, "source.ts"), path.join(root, ".everpeace", "private.ts"), path.join(root, "alias", "private.ts"), path.join(outside, "outside.ts")]
      .map((target) => ({ uri: pathToFileURL(target).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }));
    const server = path.join(root, "server.mjs");
    await fs.writeFile(server, fakeServer.replace("[{ uri: message.params.textDocument.uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } } }]", JSON.stringify(locations)));
    const runtime = new CodeNavigationRuntime({ workspacePath: root, command: process.execPath, args: [server], policy: createLspSandboxPolicy(root), startProcess: startTestProcess });
    const result = await runtime.query({ operation: "definition", path: "source.ts", line: 1, column: 1 });
    assert.deepEqual(result.locations, [{ path: "source.ts", line: 1, column: 1, endLine: 1, endColumn: 2 }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("code navigation negotiates UTF-16 and transient open/close before sending source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-navigation-sync-"));
  try {
    const server = path.join(root, "server.mjs");
    await fs.writeFile(path.join(root, "source.ts"), "const 中文 = '😀';\r\n");
    for (const [capabilities, expectedError] of [
      ["positionEncoding: 'utf-8', textDocumentSync: 1", /UTF-16 position encoding/u],
      ["positionEncoding: 'utf-32', textDocumentSync: 1", /UTF-16 position encoding/u],
      ["textDocumentSync: 0", /open\/close synchronization/u],
      ["textDocumentSync: 3", /open\/close synchronization/u],
      ["textDocumentSync: { openClose: false, change: 1 }", /open\/close synchronization/u],
      ["textDocumentSync: undefined", /open\/close synchronization/u],
      ["positionEncoding: 'utf-16', textDocumentSync: { openClose: true }", undefined],
      ["textDocumentSync: 2", undefined],
    ] as const) {
      await fs.writeFile(server, fakeServer.replace("textDocumentSync: { openClose: true }", capabilities));
      let opened = false;
      const writes: string[] = [];
      const runtime = new CodeNavigationRuntime({
        workspacePath: root, command: process.execPath, args: [server], policy: createLspSandboxPolicy(root),
        startProcess(options) {
          const processHandle = startTestProcess(options);
          return { ...processHandle, async write(data) {
            const frame = data.toString();
            writes.push(frame);
            if (frame.includes('"method":"textDocument/didOpen"')) opened = true;
            await processHandle.write(data);
          } };
        },
      });
      const query = runtime.query({ operation: "hover", path: "source.ts", line: 1, column: 1 });
      if (expectedError) {
        await assert.rejects(query, expectedError);
        assert.equal(opened, false, capabilities);
      } else {
        assert.match((await query).hover ?? "", /中文 = '😀'/u);
        assert.equal(opened, true);
      }
      assert.ok(writes.some((frame) => frame.includes('"positionEncodings":["utf-16"]')));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("hover truncation preserves complete Chinese and emoji UTF-8 codepoints", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-navigation-hover-"));
  try {
    const server = path.join(root, "server.mjs");
    await fs.writeFile(server, fakeServer);
    const runtime = new CodeNavigationRuntime({ workspacePath: root, command: process.execPath, args: [server], policy: createLspSandboxPolicy(root), startProcess: startTestProcess });
    for (const suffix of ["😀", "中文"]) {
      const prefix = "x".repeat(64 * 1024 - 1);
      await fs.writeFile(path.join(root, "source.ts"), `${prefix}${suffix}\r\n`);
      const result = await runtime.query({ operation: "hover", path: "source.ts", line: 1, column: 1 });
      assert.equal(result.hover, prefix);
      assert.equal(result.truncated, true);
      assert.ok(Buffer.byteLength(result.hover ?? "") <= 64 * 1024);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("isolation probe accepts only explicit socket denial after a passing host positive control", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-navigation-probe-evidence-"));
  try {
    for (const [payload, expected] of [
      ['{"outcome":"denied","code":"EACCES"}', "denied"],
      ['{"outcome":"denied","code":"EPERM"}', "denied"],
      ['{"outcome":"inconclusive","code":"ECONNREFUSED"}', "inconclusive"],
      ['{"outcome":"inconclusive","code":"TIMEOUT"}', "inconclusive"],
      ['{"outcome":"denied","code":"ECONNREFUSED"}', "inconclusive"],
      ["denied", "inconclusive"],
      ["null", "inconclusive"],
    ] as const) {
      let terminated = false;
      const runtime = new CodeNavigationRuntime({
        workspacePath: root, command: process.execPath, policy: createLspSandboxPolicy(root),
        startProcess() {
          const stdout = new PassThrough();
          let finish!: () => void;
          const exit = new Promise<void>((resolve) => { finish = resolve; });
          return {
            stdout, exit, async write() {},
            closeInput() { stdout.end(payload); finish(); },
            async terminate() { terminated = true; finish(); await exit; },
          };
        },
      });
      if (expected === "denied") await runtime.probeIsolation();
      else await assert.rejects(runtime.probeIsolation(), LanguageServerIsolationError);
      assert.equal(runtime.getIsolationEvidence()?.positiveControl, "passed");
      assert.equal(runtime.getIsolationEvidence()?.outcome, expected, payload);
      assert.equal(terminated, true);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("isolation evidence remains inconclusive after probe cleanup failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-navigation-probe-cleanup-"));
  try {
    const runtime = new CodeNavigationRuntime({
      workspacePath: root, command: process.execPath, policy: createLspSandboxPolicy(root),
      startProcess() {
        const stdout = new PassThrough();
        let finish!: () => void;
        const exit = new Promise<void>((resolve) => { finish = resolve; });
        return { stdout, exit, async write() {}, closeInput() { stdout.end('{"outcome":"denied","code":"EACCES"}'); finish(); }, async terminate() { throw new Error("fixture cleanup failed"); } };
      },
    });
    await assert.rejects(runtime.probeIsolation(), LanguageServerIsolationError);
    assert.equal(runtime.getIsolationEvidence()?.outcome, "inconclusive");
    assert.equal(runtime.getIsolationEvidence()?.reason, "probe_cleanup_failed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
