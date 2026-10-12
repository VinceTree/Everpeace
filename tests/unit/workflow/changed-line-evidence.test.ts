import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../../src/team/workspace.js';
import { captureChangedLines } from '../../../src/workflow/changed-line-evidence.js';
import { collectVerificationEvidence, isVerificationEvidence, parseCoverageLines } from '../../../src/workflow/verification-evidence.js';
test('tracked line edits map precisely; executed unrelated lines do not cover the change',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ep-line-evidence-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'a.ts'),'first\nsecond\nthird\n');await git(root,['init']);await git(root,['add','.']);await git(root,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline']);await fs.writeFile(path.join(root,'a.ts'),'first\nchanged\nthird\n');
  const changedLines=await captureChangedLines(root,['a.ts']);assert.deepEqual(changedLines['a.ts'],[2]);
  const report={text:'SF:a.ts\nDA:1,1\nDA:2,0\nend_of_record',identity:'fresh',digest:'a'.repeat(64)};
  const evidence=collectVerificationEvidence([],{workspacePath:root,changedPaths:['a.ts'],changedLines},new Map(),new Map([['coverage/lcov.info',report]]));assert.equal(evidence.coverage.state,'covered');assert.equal(evidence.changedLines?.state,'uncovered');assert.equal(evidence.independent,'not_run');assert.equal(isVerificationEvidence(evidence),true);
});
test('Istanbul only maps statement start locations with real numeric counts',()=>{
  const root=path.resolve('fixture');const hits=parseCoverageLines(JSON.stringify({'a.ts':{s:{'0':1,'1':0},statementMap:{'0':{start:{line:1}},'1':{start:{line:8}}}}}),'istanbul',root);assert.equal(hits.get('a.ts')?.get(8),false);assert.equal(hits.get('a.ts')?.has(2),false);assert.equal(parseCoverageLines('{"a.ts":{"s":{"0":1}}}','istanbul',root).size,0);
});
