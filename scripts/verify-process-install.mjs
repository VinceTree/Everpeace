import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnOwned } from '../dist/tools/owned-process.js';
import { observeProcessCompletion } from '../dist/tools/process-completion.js';

assert.equal(process.platform, 'win32', 'Native process installation acceptance requires Windows');
const code = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(JSON.stringify([process.pid,p.pid]));setInterval(()=>{},1000);`;
const child = spawnOwned(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
const owned = observeProcessCompletion(child, { timeoutMs: 10000 });
const [data] = await once(child.stdout, 'data');
const pids = JSON.parse(String(data)); owned.stop();
const result = await owned.completion;
assert.equal(result.cleanupError, undefined); assert.equal(result.cleanupStatus, 'confirmed_exited');
for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
console.log('Installed process owner: root and detached child cleanup independently confirmed.');
