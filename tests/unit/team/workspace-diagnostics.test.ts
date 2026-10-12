import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { inspectTeamFile } from '../../../src/team/file-artifacts.js';
import { createTeamWorkspace } from '../../../src/team/workspace.js';

test('unmaterialized LFS pointer is rejected without download or checkout filters', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-lfs-refusal-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123\n`;
  await fs.writeFile(path.join(root, 'asset.bin'), pointer);
  await assert.rejects(inspectTeamFile(root, 'asset.bin'), { code: 'TEAM_LFS_OBJECT_MISSING', reason: 'lfs_object_missing' });
  assert.equal(await fs.readFile(path.join(root, 'asset.bin'), 'utf8'), pointer); assert.deepEqual(await fs.readdir(root), ['asset.bin']);
});
test('submodule snapshot refusal exposes a stable code and leaves repository state intact', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-submodule-refusal-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'file'), 'fixture'); execFileSync('git', ['init', '--quiet', root]); execFileSync('git', ['-C', root, 'add', 'file']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${head},submodule`]);
  const before = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  await assert.rejects(createTeamWorkspace(root), { code: 'TEAM_SUBMODULE_UNSUPPORTED', reason: 'submodule_unsupported' });
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), before); await assert.rejects(fs.stat(path.join(root, 'submodule')), { code: 'ENOENT' });
});
