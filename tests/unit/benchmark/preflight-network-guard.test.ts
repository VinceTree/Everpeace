import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('offline preflight denies TCP and remote or unrelated pipes', () => {
  const guard = pathToFileURL(path.resolve('docs/benchmark/dsh-instrumentation/preflight-network-guard.mjs')).href;
  const source = `import net from 'node:net';import assert from 'node:assert/strict';for(const value of [{host:'127.0.0.1',port:80},'\\\\\\\\remote\\\\pipe\\\\everpeace-owner-11111111-1111-1111-1111-111111111111','unrelated'])assert.throws(()=>net.createConnection(value),/Network access is disabled/);console.log('blocked');`;
  assert.match(execFileSync(process.execPath, ['--import', guard, '--input-type=module', '-e', source], { encoding: 'utf8', windowsHide: true }), /blocked/);
});
