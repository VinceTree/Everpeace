import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CodeNavigationRuntime, parseCodeNavigationArguments } from "../../../src/tools/code-navigation.js";

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
    const runtime = new CodeNavigationRuntime({ workspacePath: root, command: process.execPath, args: [server] });

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

test("code navigation validates one-based UTF-16 positions", () => {
  assert.deepEqual(parseCodeNavigationArguments('{"operation":"hover","path":"x.ts","line":1,"column":2}'), {
    operation: "hover",
    path: "x.ts",
    line: 1,
    column: 2,
  });
  assert.throws(() => parseCodeNavigationArguments('{"operation":"hover","path":"x.ts","line":0,"column":2}'), /Invalid/u);
});
