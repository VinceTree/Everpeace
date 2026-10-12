import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LearnedMemoryStore,memoryEntryRevision} from '../../../src/memory/learned-memory.js';
test('CLI inspects, corrects and disables memory without a provider or keyring request',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ep-memory-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const config=process.platform==='win32'?path.join(root,'Everpeace'):path.join(root,'everpeace');
  const store=new LearnedMemoryStore({directory:path.join(config,'memory')}),workspace=process.cwd();await store.append('project',workspace,[{lesson:'fixture original convention',applyWhen:'fixture',reviewedAt:new Date().toISOString()}]);const original=(await store.read('project',workspace))[0]!;
  const env={...process.env,...(process.platform==='win32'?{APPDATA:root}:process.platform==='darwin'?{}:{XDG_CONFIG_HOME:root,XDG_STATE_HOME:root})};
  if(process.platform==='darwin'){t.skip('macOS configuration is tied to HOME; exercised by injected store tests');return;}
  const cli=(args:string[])=>promisify(execFile)(process.execPath,['--import','tsx','src/cli/index.ts','memory',...args],{cwd:workspace,env,windowsHide:true});
  const inspected=JSON.parse((await cli(['inspect','project',original.id])).stdout);assert.equal(inspected.revision,memoryEntryRevision(original));
  await cli(['correct','project',original.id,inspected.revision,JSON.stringify({lesson:'fixture corrected convention',applyWhen:'fixture'})]);const corrected=(await store.read('project',workspace)).find(e=>e.supersedes===original.id)!;assert.match((await store.snapshot(workspace,'fixture')).text,/corrected/u);
  await cli(['disable','project',corrected.id,memoryEntryRevision(corrected)]);assert.equal((await store.snapshot(workspace,'fixture')).text,'');await assert.rejects(cli(['renew','project',corrected.id,'stale']));
});
