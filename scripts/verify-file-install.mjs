import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeReadFile, safeCommitFile } from '../dist/tools/safe-files.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-file-install-'));
try {
  if (process.platform !== 'win32') {
    await assert.rejects(safeReadFile(root, 'file'), { code: 'FILE_ACCESS_UNAVAILABLE' });
    console.log('Unsupported-platform file access fails closed; native acceptance is not claimed.');
  } else {
    await safeCommitFile(root, 'file', undefined, Buffer.from('\ufefforiginal\r\n'));
    const first = await safeReadFile(root, 'file');
    assert.ok(first.exists && first.identity);
    await safeCommitFile(root, 'file', first.bytes, Buffer.from('\ufeffupdated\r\n'));
    await assert.rejects(safeCommitFile(root, 'file', first.bytes, Buffer.from('stale')), { code: 'STALE_VERSION' });
    assert.equal((await safeReadFile(root, 'file')).bytes.toString('utf8'), '\ufeffupdated\r\n');
    await safeCommitFile(root, 'file', Buffer.from('\ufeffupdated\r\n'), undefined);
    assert.equal((await safeReadFile(root, 'file')).exists, false);
    console.log('Installed native helper: read/create/update/delete, byte identity and conflict smoke passed.');
  }
} finally {
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('everpeace-file-install-'));
  await fs.rm(root, { recursive: true, force: true });
}
