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

test('CLI candidates can be previewed, corrected and rejected without model access', async t => {
  const {runMemoryCommand} = await import('../../../src/cli/commands/memory.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-memory-cli-candidates-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, {recursive:true,force:true}); });
  const store = new LearnedMemoryStore({directory:root});
  const make = (id:string) => ({id,workspacePath:root,scope:'project' as const,kind:'convention' as const,confidence:'high' as const,lesson:'Use pnpm',applyWhen:'fixture',createdAt:new Date().toISOString(),evidence:[],redactionVersion:2,status:'review' as const});
  await store.saveCandidates([make('cli-candidate-a'),make('cli-candidate-b')]);
  let output = '';
  const cli = (args:string[]) => runMemoryCommand(args,store,root,text=>{output=text;});
  assert.equal(await cli(['candidates','list']),0); assert.equal(JSON.parse(output).length,2);
  const correction = JSON.stringify({lesson:'Use the corrected fixture runner',applyWhen:'fixture'});
  assert.equal(await cli(['candidates','inspect','cli-candidate-a',correction]),0);
  const preview = JSON.parse(output);
  assert.equal(await cli(['candidates','correct','cli-candidate-a',preview.revision,correction]),0);
  assert.equal((await store.read('project',root))[0]?.lesson,'Use the corrected fixture runner');
  assert.equal(await cli(['candidates','inspect','cli-candidate-b']),0);
  const rejected = JSON.parse(output);
  assert.equal(await cli(['candidates','reject','cli-candidate-b',rejected.revision]),0);
  assert.equal(await cli(['candidates','accept','cli-candidate-b',rejected.revision]),1);
  assert.equal((await store.listReviewCandidates(root)).length,0);
  assert.equal(await cli(['candidates','correct','missing','stale','{}']),1);
});
