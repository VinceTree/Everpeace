import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CodeNavigationRuntime, parseCodeNavigationArguments, type LanguageServerProcessFactory } from "../../../src/tools/code-navigation.js";
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
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true, hoverProvider: true } } });
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
  if (message.method === 'initialize') void send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true } } });
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
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true } } });
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
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
