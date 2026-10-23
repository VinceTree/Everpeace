import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyUnifiedPatch, runApplyPatch, previewApplyPatch } from '../../../src/tools/apply-patch.js';
import { safeCommitFile, safeReadFile } from '../../../src/tools/safe-files.js';

test('strict hunks enforce counts, ranges, continuity and newline markers', () => {
  assert.equal(applyUnifiedPatch('a\nb\nc\nd\n', '@@ -1,1 +1,2 @@\n-a\n+A\n+x\n@@ -4,1 +5,1 @@\n-d\n+D\n'), 'A\nx\nb\nc\nD\n');
  assert.equal(applyUnifiedPatch('', '@@ -0,0 +1,1 @@\n+first\n'), 'first\n');
  assert.equal(applyUnifiedPatch('last', '@@ -1,1 +1,1 @@\n-last\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n'), 'new');
  for (const diff of [
    '@@ -1,2 +1,1 @@\n-a\n+A\n', '@@ -1,1 +1,2 @@\n-a\n+A\n', '@@ -0,1 +1,1 @@\n-a\n+A\n', '@@ -9007199254740992,0 +1,1 @@\n+A\n', '@@ -1,1 +2,1 @@\n-a\n+A\n', '@@ -1,1 +1,1 @@\n-a\n+A\nstray', '@@ -1,1 +1,1 @@\n\\ No newline at end of file\n-a\n+A\n', '@@ -1,1 +1,1 @@\n-a\n+A\n@@ -1,1 +1,1 @@\n-a\n+B\n',
  ]) assert.throws(() => applyUnifiedPatch('a\n', diff), { code: 'PATCH_MISMATCH' });
});
test('rollback of a deleted file restores its bytes and hidden attribute', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-delete-attributes-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await safeCommitFile(root, 'hidden.txt', undefined, Buffer.from('\ufeffold\r\n'), undefined, 2);
  const result = await runApplyPatch([{ path: 'hidden.txt', action: 'delete' }, { path: 'new.txt', action: 'create', content: 'new' }], root, { beforeCommit: async file => { if (file === 'new.txt') throw new Error('injected failure'); } });
  assert.equal(result.batchState, 'rolled_back'); const restored = await safeReadFile(root, 'hidden.txt'); assert.equal(restored.bytes.toString(), '\ufeffold\r\n'); assert.equal(restored.attributes! & 2, 2);
});
test('large text edit preserves bytes and bounds preview while malformed batches perform no writes', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-large-patch-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = Buffer.from('\ufefftarget=old\r\n' + 'x'.repeat(16 * 1024 * 1024 - Buffer.byteLength('\ufefftarget=old\r\n\r\n')) + '\r\n'); await fs.writeFile(path.join(root, 'lock.txt'), before);
  const op = { path: 'lock.txt', action: 'update' as const, replace: { oldText: 'target=old', newText: 'target=new' } };
  const preview = await previewApplyPatch([op], root); assert.equal(preview.status, 'ready'); assert.ok(Buffer.byteLength(preview.diff) <= 256 * 1024);
  assert.equal((await runApplyPatch([op], root)).status, 'applied');
  assert.deepEqual(await fs.readFile(path.join(root, 'lock.txt')), Buffer.from(before.toString().replace('target=old', 'target=new')));
  const bad = await runApplyPatch([{ path: 'new.txt', action: 'create', content: 'must not exist' }, { path: 'lock.txt', action: 'update', patch: '@@ -1,2 +1,1 @@\n-target=new\n+wrong\n' }], root);
  assert.equal(bad.status, 'rejected'); await assert.rejects(fs.stat(path.join(root, 'new.txt')), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'oversized.txt'), Buffer.alloc(16 * 1024 * 1024 + 1, 120));
  assert.equal((await previewApplyPatch([{ path: 'oversized.txt', action: 'delete' }], root)).errorCode, 'FILE_TOO_LARGE');
});
