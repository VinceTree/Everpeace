import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnOwned } from '../../../src/tools/owned-process.js';
import { observeProcessCompletion } from '../../../src/tools/process-completion.js';
import { recoverFileBatch, listFileBatches, runFileBatch } from '../../../src/tools/file-batch.js';
import { safeReadFile } from '../../../src/tools/safe-files.js';
import { safeWorkspaceIdentity } from '../../../src/tools/safe-files.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

for (const userSave of [false, true]) test(`crashed multi-file batch ${userSave ? 'preserves a later save' : 'recovers from durable intent'}`, { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-batch-crash-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), '\ufeffold\r\n'); await fs.writeFile(path.join(root, 'b.txt'), 'second');
  const batchUrl = pathToFileURL(path.resolve('src/tools/file-batch.ts')).href, filesUrl = pathToFileURL(path.resolve('src/tools/safe-files.ts')).href;
  const code = `import{runFileBatch}from ${JSON.stringify(batchUrl)};import{safeReadFile}from ${JSON.stringify(filesUrl)};const root=${JSON.stringify(root)};const a=await safeReadFile(root,'a.txt'),b=await safeReadFile(root,'b.txt');await runFileBatch(root,[{path:'a.txt',before:a.bytes,beforeIdentity:a.identity,after:Buffer.from('agent')},{path:'b.txt',before:b.bytes,beforeIdentity:b.identity,after:Buffer.from('updated')}],{beforeCommit:async p=>{if(p==='b.txt'){console.log('committed-first');await new Promise(()=>{});}}});`;
  const child = spawnOwned(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  const owned = observeProcessCompletion(child); const [data] = await once(child.stdout, 'data'); assert.match(String(data), /committed-first/); owned.stop(); assert.equal((await owned.completion).cleanupError, undefined);
  const pending = await listFileBatches(root); assert.equal(pending.length, 1); assert.equal(pending[0]!.state, 'pending');
  if (userSave) { await fs.rename(path.join(root, 'a.txt'), path.join(root, 'agent-object')); await fs.writeFile(path.join(root, 'a.txt'), 'agent'); }
  const recovered = await recoverFileBatch(root, pending[0]!.id);
  assert.equal(recovered.state, userSave ? 'conflict' : 'rolled_back');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), userSave ? 'agent' : '\ufeffold\r\n');
  assert.equal(await fs.readFile(path.join(root, 'b.txt'), 'utf8'), 'second');
});
test('a failed second file rolls back the first and preserves the concurrent user object', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-batch-conflict-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a'), 'before'); await fs.writeFile(path.join(root, 'b'), 'before');
  const changes = await Promise.all(['a', 'b'].map(async file => { const value = await safeReadFile(root, file); return { path: file, before: value.bytes, beforeIdentity: value.identity!, after: Buffer.from('after') }; }));
  const result = await runFileBatch(root, changes, { beforeCommit: async file => { if (file === 'b') await fs.writeFile(path.join(root, file), 'user'); } });
  assert.equal(result.state, 'conflict'); assert.equal(await fs.readFile(path.join(root, 'a'), 'utf8'), 'before'); assert.equal(await fs.readFile(path.join(root, 'b'), 'utf8'), 'user'); assert.ok((await listFileBatches(root)).length);
});

for (const phase of ['journaled', 'moved', 'installed', 'disk_full'] as const) test(`native batch fault at ${phase} retains safe recovery`, { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-batch-phase-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'note.txt'), 'old'); const before = await safeReadFile(root, 'note.txt'), rootIdentity = await safeWorkspaceIdentity(root);
  const id = 'b'.repeat(32), token = 'a'.repeat(32), prefix = `.everpeace-batch-${id}`;
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  await fs.writeFile(path.join(root, `${prefix}.json`), JSON.stringify({ version: 1, id, rootIdentity, operations: [{ path: 'note.txt', token, before: hash('old'), after: hash('agent'), beforeIdentity: before.identity }] }));
  await fs.writeFile(path.join(root, `${prefix}.0.before`), 'old'); await fs.writeFile(path.join(root, `${prefix}.0.after`), 'agent');
  const word = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const field = (value: string) => { const bytes = Buffer.from(value); return Buffer.concat([word(bytes.length), bytes]); };
  const child = spawn(path.resolve(`native/files/bin/win32-${process.arch}/everpeace-files-test.exe`), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill()); let observed = ''; const closed = once(child, 'close'); child.stderr.on('data', value => { observed += String(value); }); child.stdout.resume();
  child.stdin.write(Buffer.concat([Buffer.from('EPF3'), word(2), field(root), field('note.txt'), field(rootIdentity), field(before.identity!), field('old'), field('agent'), word(1), word(0), field(token)]));
  for (const name of ['pinned', 'locked', 'journaled', 'moved', 'installed']) {
    const deadline = Date.now() + 5000; while (!observed.includes(`PHASE:${name}`)) { assert.ok(Date.now() < deadline, `phase ${name}`); await new Promise(resolve => setTimeout(resolve, 5)); }
    if (phase === 'disk_full' && name === 'journaled') { child.stdin.write('!'); break; }
    if (name === phase) { child.kill(); break; }
    child.stdin.write('\n');
  }
  await closed;
  assert.equal((await recoverFileBatch(root, id)).state, 'rolled_back');
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'old');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.everpeace-')), []);
});
test('committed recovery only cleans materials and corrupted records never restore files', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-batch-terminal-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'note'), 'old'); const value = await safeReadFile(root, 'note');
  const result = await runFileBatch(root, [{ path: 'note', before: value.bytes, beforeIdentity: value.identity!, after: Buffer.from('agent') }], { retainCommitted: true });
  assert.equal(result.state, 'committed'); await fs.writeFile(path.join(root, 'note'), 'user');
  const file = path.join(root, `.everpeace-batch-${result.id}.json`), valid = await fs.readFile(file);
  await fs.writeFile(file, valid.subarray(0, 20)); await assert.rejects(recoverFileBatch(root, result.id)); assert.equal(await fs.readFile(path.join(root, 'note'), 'utf8'), 'user');
  await fs.writeFile(file, valid); assert.equal((await recoverFileBatch(root, result.id)).state, 'committed'); assert.equal(await fs.readFile(path.join(root, 'note'), 'utf8'), 'user');
});
