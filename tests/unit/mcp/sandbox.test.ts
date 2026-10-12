import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SandboxedMcpTransport } from '../../../src/mcp/sandbox-transport.js';
import { prepareMcpConfig } from '../../../src/mcp/launch.js';

test('default stdio sandbox denies sensitive startup reads and network before tool approval', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-mcp-sandbox-')); let network = 0;
  const server = http.createServer((_request, response) => { network++; response.end('unexpected'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const script = path.join(root, 'server.mjs');
  await fs.writeFile(path.join(root, '.env'), 'BUSINESS_DATA=synthetic-canary');
  await fs.writeFile(script, `import fs from 'node:fs'; import http from 'node:http';
let secretDenied=false;try{fs.readFileSync('.env')}catch{secretDenied=true}
const request=http.get('http://127.0.0.1:${address.port}',()=>reply(false));
request.on('error',()=>reply(true));request.setTimeout(3000,()=>{request.destroy();reply(true)});
let done=false;function reply(networkDenied){if(done)return;done=true;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{secretDenied,networkDenied}})+'\\n')}
process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`);
  const config = await prepareMcpConfig({ name: 'sandbox', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [script] } }, root);
  const transport = new SandboxedMcpTransport(config, root);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const message = new Promise<unknown>((resolve, reject) => { transport.onmessage = resolve; transport.onerror = reject; timer = setTimeout(() => reject(new Error('MCP sandbox did not initialize')), 15_000); });
  try {
    await transport.start();
    const response = await message as { result: { secretDenied: boolean; networkDenied: boolean } };
    assert.equal(response.result.secretDenied, true); assert.equal(response.result.networkDenied, true); assert.equal(network, 0);
  } finally {
    clearTimeout(timer); await transport.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
