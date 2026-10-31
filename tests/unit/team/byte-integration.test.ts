import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTeamWorkspace, workspaceOperations, removeTeamWorkspace, git } from '../../../src/team/workspace.js';
import { integrateTeamBytes, recoverTeamIntegration } from '../../../src/team/byte-integration.js';

async function fixture(t: TestContext) {
  const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ep-byte-test-')));
  await fs.writeFile(path.join(source,'asset.bin'),Buffer.from([0,255,1,2]));
  await fs.writeFile(path.join(source,'other.bin'),Buffer.from([0,254,3]));
  await git(source,['init']);await git(source,['add','.']);await git(source,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline']);
  const record=await createTeamWorkspace(source);
  t.after(async()=>{await removeTeamWorkspace(record);await fs.rm(source,{recursive:true,force:true});});
  return record;
}
test('binary bytes and a 17 MiB artifact are streamed and integrated unchanged',async t=>{
  const record=await fixture(t),content=Buffer.alloc(17*1024*1024,0xa5);content[0]=0;
  await fs.writeFile(path.join(record.workspace,'asset.bin'),content);
  const changes=await workspaceOperations(record,['asset.bin']);assert.equal(changes.operations.length,0);assert.equal(changes.byteOperations.length,1);
  const result=await integrateTeamBytes(record,changes.byteOperations,['asset.bin'],randomUUID(),()=>{});
  assert.equal(result.status,'applied');assert.deepEqual(await fs.readFile(path.join(record.source,'asset.bin')),content);
});
test('binary create and delete share one host-owned transaction',async t=>{
  const record=await fixture(t);await fs.unlink(path.join(record.workspace,'asset.bin'));await fs.writeFile(path.join(record.workspace,'new.bin'),Buffer.from([0,255,128]));
  const changes=await workspaceOperations(record,['.']);const result=await integrateTeamBytes(record,changes.byteOperations,['.'],randomUUID(),()=>{});
  assert.equal(result.status,'applied');await assert.rejects(fs.stat(path.join(record.source,'asset.bin')),{code:'ENOENT'});assert.deepEqual(await fs.readFile(path.join(record.source,'new.bin')),Buffer.from([0,255,128]));
});
test('concurrent user edits are preserved and retained worker bytes remain available',async t=>{
  const record=await fixture(t);await fs.writeFile(path.join(record.workspace,'asset.bin'),Buffer.from([0,9]));const changes=await workspaceOperations(record,['.']);await fs.writeFile(path.join(record.source,'asset.bin'),Buffer.from([0,7]));
  const result=await integrateTeamBytes(record,changes.byteOperations,['.'],randomUUID(),()=>{});assert.equal(result.status,'failed');assert.deepEqual(await fs.readFile(path.join(record.source,'asset.bin')),Buffer.from([0,7]));assert.deepEqual(await fs.readFile(path.join(record.workspace,'asset.bin')),Buffer.from([0,9]));
});
test('cancellation between writes rolls back owned bytes; journal recovery is idempotent',async t=>{
  const record=await fixture(t);await fs.writeFile(path.join(record.workspace,'asset.bin'),Buffer.from([0,9]));await fs.writeFile(path.join(record.workspace,'other.bin'),Buffer.from([0,8]));const changes=await workspaceOperations(record,['.']),id=randomUUID(),controller=new AbortController();let calls=0;
  const result=await integrateTeamBytes(record,changes.byteOperations,['.'],id,()=>{if(++calls===3)controller.abort();},controller.signal);
  assert.equal(result.status,'failed');assert.equal(result.rolledBack,true);assert.deepEqual(await fs.readFile(path.join(record.source,'asset.bin')),Buffer.from([0,255,1,2]));assert.deepEqual(await recoverTeamIntegration(record,id,['.'],()=>{}),{recovered:true,conflicts:[]});
});
test('a replaced destination directory never writes through a junction',async t=>{
  const record=await fixture(t),outside=await fs.mkdtemp(path.join(os.tmpdir(),'ep-byte-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.mkdir(path.join(record.workspace,'nested'));await fs.writeFile(path.join(record.workspace,'nested','asset.bin'),Buffer.from([0,9]));const changes=await workspaceOperations(record,['nested']);
  await fs.symlink(outside,path.join(record.source,'nested'),process.platform==='win32'?'junction':'dir');
  t.after(()=>fs.unlink(path.join(record.source,'nested')).catch(()=>{}));
  const result=await integrateTeamBytes(record,changes.byteOperations,['nested'],randomUUID(),()=>{});assert.equal(result.status,'failed');assert.deepEqual(await fs.readdir(outside),[]);
});
test('staging disk failure does not change source or discard the worker artifact',async t=>{
  const record=await fixture(t);await fs.writeFile(path.join(record.workspace,'asset.bin'),Buffer.from([0,9]));const changes=await workspaceOperations(record,['.']);const original=fs.writeFile;
  t.mock.method(fs,'writeFile',async(...args:Parameters<typeof fs.writeFile>)=>{if(String(args[0]).endsWith('.after'))throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});return original(...args);});
  const result=await integrateTeamBytes(record,changes.byteOperations,['.'],randomUUID(),()=>{});assert.equal(result.status,'failed');assert.deepEqual(await fs.readFile(path.join(record.source,'asset.bin')),Buffer.from([0,255,1,2]));assert.deepEqual(await fs.readFile(path.join(record.workspace,'asset.bin')),Buffer.from([0,9]));
});

test('a save after byte staging is preserved by the native final commit', async t => {
  const record = await fixture(t); await fs.writeFile(path.join(record.workspace, 'asset.bin'), Buffer.from([0, 9]));
  const changes = await workspaceOperations(record, ['asset.bin']); let calls = 0;
  const user = Buffer.from([0, 7, 8]);
  const result = await integrateTeamBytes(record, changes.byteOperations, ['asset.bin'], randomUUID(), async () => {
    if (++calls === 2) await fs.writeFile(path.join(record.source, 'asset.bin'), user);
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(await fs.readFile(path.join(record.source, 'asset.bin')), user);
  assert.deepEqual(await fs.readFile(path.join(record.workspace, 'asset.bin')), Buffer.from([0, 9]));
});
