import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { spawnOwned, processOwner } from '../../../src/tools/owned-process.js';
import { observeProcessCompletion } from '../../../src/tools/process-completion.js';

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }
test('Windows executable lookup excludes implicit cwd and uses canonical PATH', { skip: process.platform !== 'win32', timeout: 5000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-path-owner-'));
  await fs.writeFile(path.join(root, 'node.exe'), 'invalid shadow executable');
  try {
    const child = spawnOwned('node', ['-e', 'console.log("trusted-node")'], { cwd: root, env: { ...process.env, PATH: path.dirname(process.execPath) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const owned = observeProcessCompletion(child); let output = ''; child.stdout.on('data', value => { output += value; });
    const result = await owned.completion;
    assert.equal(result.cleanupStatus, 'confirmed_exited'); assert.equal(result.exitCode, 0); assert.equal(output.trim(), 'trusted-node');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Windows owned Job cancels parent and detached descendants without killing a control', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const control = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
  t.after(() => control.kill());
  const grandchild = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(JSON.stringify([process.pid,g.pid]));setInterval(()=>{},1000);`;
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',x=>console.log(JSON.stringify([process.pid,...JSON.parse(String(x))])));setInterval(()=>{},1000);`;
  const child = spawnOwned(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  const owned = observeProcessCompletion(child);
  const [data] = await once(child.stdout, 'data'); const pids = JSON.parse(String(data)) as number[];
  assert.equal((await processOwner(child.pid!)!.status!()).status, 'still_running');
  owned.stop(); const result = await owned.completion;
  assert.equal(result.cleanupError, undefined); assert.equal(result.cleanupStatus, 'confirmed_exited');
  assert.ok(pids.every(pid => !alive(pid))); assert.ok(alive(control.pid!));
});
test('Windows parent natural exit cleans its remaining descendants', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const child = spawnOwned(process.execPath, ['-e', `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref();`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const owned = observeProcessCompletion(child); let output = ''; child.stdout.on('data', value => { output += value; });
  const result = await owned.completion;
  assert.equal(result.cleanupStatus, 'confirmed_exited'); assert.equal(result.exitCode, 0); assert.ok(!alive(Number(output.trim())));
});
test('Windows owner crash fails closed and kill-on-close terminates payload', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const child = spawnOwned(process.execPath, ['-e', `console.log(process.pid);setInterval(()=>{},1000)`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const owned = observeProcessCompletion(child); const [data] = await once(child.stdout, 'data'); const pid = Number(String(data));
  child.kill(); const result = await owned.completion;
  assert.ok(result.cleanupError); assert.equal(result.cleanupStatus, 'unknown');
  for (let attempt = 0; alive(pid) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!alive(pid));
});
test('owner IPC denial terminates the bootstrap without launching payload', { skip: process.platform !== 'win32', timeout: 2000 }, async t => {
  t.mock.method(net, 'createConnection', () => { throw new Error('offline IPC denial'); }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const child = spawnOwned(process.execPath, ['-e', 'console.log("must not launch")'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; });
  const result = await observeProcessCompletion(child).completion;
  assert.equal(result.cleanupStatus, 'unknown'); assert.ok(result.cleanupError); assert.equal(output, ''); assert.ok(!alive(child.pid!));
});
test('a confirmed empty Job reports a missing executable as a launch error', { skip: process.platform !== 'win32', timeout: 2000 }, async () => {
  const child = spawnOwned(path.resolve('everpeace-missing-executable-fixture-37bce21.exe'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const result = await observeProcessCompletion(child).completion;
  assert.equal(result.cleanupStatus, 'confirmed_exited'); assert.equal(result.cleanupError, undefined); assert.equal((result.error as NodeJS.ErrnoException).code, 'ENOENT'); assert.equal(result.exitCode, null);
});
