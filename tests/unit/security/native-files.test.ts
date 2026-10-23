import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeCommitFile, safeReadFile } from '../../../src/tools/safe-files.js';
import { recoverFile } from '../../../src/tools/file-recovery.js';
import { runFileTool } from '../../../src/tools/files.js';

function word(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function field(s: string | Buffer): Buffer { const b = Buffer.from(s); return Buffer.concat([word(b.length), b]); }
async function fixture() { return fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-file-races-')); }
function start(workspace: string) {
  const executable = fileURLToPath(new URL(`../../../native/files/bin/win32-${process.arch}/everpeace-files-test.exe`, import.meta.url));
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const phases: string[] = []; let stderr = ''; const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); phases.splice(0, phases.length, ...[...stderr.matchAll(/PHASE:([a-z]+)/gu)].map(match => match[1]!)); });
  const closed = new Promise<Buffer>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve(Buffer.concat(chunks))); });
  child.stdin.write(Buffer.concat([Buffer.from('EPF2'), word(2), field(workspace), field('note.txt'), field(''), field(''), field('old'), field('agent'), word(1), word(0)]));
  const phase = async (name: string) => { const until = Date.now() + 5000; while (!phases.includes(name)) { if (Date.now() > until) throw new Error(`Missing phase ${name}`); await new Promise(resolve => setTimeout(resolve, 5)); } };
  return { child, phase, closed, next: () => child.stdin.write('\n') };
}

test('native access rejects junctions, hard links, and stale-byte commits', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture(); const outside = await fixture();
  try {
    await fs.writeFile(path.join(outside, 'secret'), 'fake-canary');
    await fs.symlink(outside, path.join(root, 'junction'), 'junction');
    await assert.rejects(safeReadFile(root, 'junction/secret'), { code: 'POLICY_DENIED' });
    await fs.symlink(root, path.join(root, 'internal-junction'), 'junction');
    await assert.rejects(runFileTool('read_file', JSON.stringify({ path: 'internal-junction/linked' }), root), { code: 'POLICY_DENIED' });
    await fs.link(path.join(outside, 'secret'), path.join(root, 'linked'));
    await assert.rejects(safeReadFile(root, 'linked'), { code: 'POLICY_DENIED' });
    await assert.rejects(safeReadFile(root, '\ud800'), { code: 'POLICY_DENIED' });
    await fs.writeFile(path.join(root, 'note.txt'), 'user');
    await assert.rejects(safeCommitFile(root, 'note.txt', Buffer.from('old'), Buffer.from('agent')), { code: 'STALE_VERSION' });
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'user');
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test('the process retains workspace identity across requests after root replacement', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture(); const original = `${root}-original`;
  try {
    await fs.writeFile(path.join(root, 'note.txt'), 'old');
    assert.equal((await safeReadFile(root, 'note.txt')).bytes.toString(), 'old');
    await fs.rename(root, original); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'note.txt'), 'replacement');
    await assert.rejects(safeReadFile(root, 'note.txt'), { code: 'FILE_CONFLICT' });
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'replacement');
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(original, { recursive: true, force: true }); }
});

test('native pinned parents and target handles block concurrent replacement and saves', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture(); await fs.writeFile(path.join(root, 'note.txt'), 'old'); const running = start(root);
  try {
    await running.phase('pinned');
    await assert.rejects(fs.rename(root, `${root}-swapped`));
    running.next(); await running.phase('locked');
    await assert.rejects(fs.writeFile(path.join(root, 'note.txt'), 'user'));
    running.next(); await running.phase('moved'); running.next(); await running.phase('installed'); running.next();
    assert.equal((await running.closed).readUInt32LE(0), 0);
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'agent');
  } finally { running.child.kill(); await running.closed; await fs.rm(root, { recursive: true, force: true }); }
});

test('a concurrent save into the commit gap survives with a recoverable original', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture(); await fs.writeFile(path.join(root, 'note.txt'), 'old'); const running = start(root);
  try {
    await running.phase('pinned'); running.next(); await running.phase('locked'); running.next(); await running.phase('moved');
    await fs.writeFile(path.join(root, 'note.txt'), 'user', { flag: 'wx' }); running.next();
    const result = await running.closed; assert.equal(result.readUInt32LE(0), 5);
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'user');
    const backup = (await fs.readdir(root)).find(name => name.endsWith('.bak'))!; assert.ok(backup);
    assert.equal(await fs.readFile(path.join(root, backup), 'utf8'), 'old');
    await assert.rejects(recoverFile(root, backup), { code: 'FILE_CONFLICT' });
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'user');
  } finally { running.child.kill(); await running.closed; await fs.rm(root, { recursive: true, force: true }); }
});

test('crash after moving the original allows explicit exclusive recovery', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture(); await fs.writeFile(path.join(root, 'note.txt'), 'old'); const running = start(root);
  try {
    await running.phase('pinned'); running.next(); await running.phase('locked'); running.next(); await running.phase('moved'); running.child.kill(); await running.closed;
    const backup = (await fs.readdir(root)).find(name => name.endsWith('.bak'))!; assert.ok(backup);
    await recoverFile(root, backup);
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'old');
    assert.ok(!(await fs.readdir(root)).includes(backup));
  } finally { running.child.kill(); await running.closed; await fs.rm(root, { recursive: true, force: true }); }
});

test('crash recovery refuses a later object with identical post-image bytes', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture(); await fs.writeFile(path.join(root, 'note.txt'), 'old'); const running = start(root);
  try {
    await running.phase('pinned'); running.next(); await running.phase('locked'); running.next(); await running.phase('moved'); running.next(); await running.phase('installed');
    running.child.kill(); await running.closed;
    const backup = (await fs.readdir(root)).find(name => name.endsWith('.bak'))!; assert.ok(backup);
    await fs.rename(path.join(root, 'note.txt'), path.join(root, 'previous-agent-object'));
    await fs.writeFile(path.join(root, 'note.txt'), 'agent');
    await assert.rejects(recoverFile(root, backup), { code: 'FILE_CONFLICT' });
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'agent');
    assert.equal(await fs.readFile(path.join(root, backup), 'utf8'), 'old');
  } finally { running.child.kill(); await running.closed; await fs.rm(root, { recursive: true, force: true }); }
});
