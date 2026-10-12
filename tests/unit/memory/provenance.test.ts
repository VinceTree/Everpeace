import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LearnedMemoryStore,memoryEntryRevision} from '../../../src/memory/learned-memory.js';
test('legacy memory is inspectable, review-bound, expiring and corrected without injecting superseded content',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ep-provenance-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));let now=new Date('2026-10-12T00:00:00Z');const store=new LearnedMemoryStore({directory,now:()=>now});await store.append('project',directory,[{lesson:'wrong fixture convention',applyWhen:'fixture'}]);const entry=(await store.read('project',directory))[0]!;assert.equal((await store.snapshot(directory,'fixture')).text,'');assert.equal((await store.status(directory)).needsReview,1);
  await store.reviewEntry('project',directory,entry.id,memoryEntryRevision(entry),'renew');const renewed=(await store.read('project',directory))[0]!;assert.match((await store.snapshot(directory,'fixture')).text,/wrong fixture/u);
  await store.reviewEntry('project',directory,entry.id,memoryEntryRevision(renewed),'correct',{lesson:'correct fixture convention',applyWhen:'fixture'});const corrected=(await store.read('project',directory)).find(r=>r.supersedes===entry.id)!;assert.equal(corrected.reviewHistory?.length,2);assert.doesNotMatch((await store.snapshot(directory,'fixture')).text,/wrong fixture/u);assert.match((await store.snapshot(directory,'fixture')).text,/correct fixture/u);
  now=new Date('2027-02-01T00:00:00Z');assert.equal((await store.snapshot(directory,'fixture')).text,'');await assert.rejects(store.reviewEntry('project',directory,corrected.id,'outdated','disable'));
});
