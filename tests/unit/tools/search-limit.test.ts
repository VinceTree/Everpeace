import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { runRipgrep } from '../../../src/tools/files.js';

test('output limit stops an endless search process and independently confirms its exit', { skip: process.platform !== 'win32', timeout: 4000 }, async () => {
  const started = performance.now();
  const result = await runRipgrep([], process.cwd(), undefined, async () => path.resolve(`native/process/bin/win32-${process.arch}/everpeace-output-test.exe`));
  assert.equal(result.incompleteReason, 'output_limit'); assert.equal(result.incomplete, true);
  const pid = JSON.parse(result.lines[0]!).pid as number;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(performance.now() - started < 2000, 'ordinary output-limit cancellation remains fast');
});
