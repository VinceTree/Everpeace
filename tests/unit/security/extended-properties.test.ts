import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnOwned as spawn } from '../../../src/tools/owned-process.js';
import { propertyCheck } from '../../fixtures/property-check.js';
import { isPublicIpAddress } from '../../../src/network/public-address.js';
import { runFileTool } from '../../../src/tools/files.js';
import { runAgentLoop } from '../../../src/agent/agent-loop.js';
import { observeProcessCompletion } from '../../../src/tools/process-completion.js';

test('generated IPv6 and alternative IPv4 forms cannot bypass reserved ranges',async()=>{
  await propertyCheck('extended-dns',fc.property(fc.integer({min:0,max:65535}),fc.integer({min:0,max:255}),(n,b)=>{
    for(const ip of [`fe80::${n.toString(16)}`,`fc00::${n.toString(16)}`,`fdff::${n.toString(16)}`,`::ffff:127.0.0.${b}`,`::ffff:a00:${n.toString(16)}`,`0.0.0.${b}`])assert.equal(isPublicIpAddress(ip),false,ip);
  }));
});
test('generated path spellings never reveal a parent canary',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ep-path-properties-'))),workspace=path.join(root,'workspace');await fs.mkdir(workspace);await fs.writeFile(path.join(root,'canary.txt'),'outside-private-canary');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const prefix=fc.array(fc.constantFrom('.','..','directory','', '...'),{minLength:1,maxLength:8});
  await propertyCheck('extended-paths',fc.asyncProperty(prefix,fc.constantFrom('/','\\'),async(parts,separator)=>{
    const name=[...parts,'canary.txt'].join(separator);let result:unknown;try{result=await runFileTool('read_file',JSON.stringify({path:name}),workspace);}catch{/* rejection is valid */}assert.ok(!JSON.stringify(result??'').includes('outside-private-canary'));
  }));
});
test('cancellation at sampling, recording and tool admission blocks late writes',async()=>{
  await propertyCheck('extended-cancel-phases',fc.asyncProperty(fc.constantFrom('before','sampling','recording','dispatch'),async phase=>{
    const controller=new AbortController();let writes=0,requests=0;
    if(phase==='before')controller.abort();
    await runAgentLoop({signal:controller.signal,async sample(){requests++;if(phase==='sampling')controller.abort();return {output_text:'',output:[{type:'function_call',call_id:'fixture',name:'apply_patch',arguments:'{}'}]};},async record(){if(phase==='recording')controller.abort();},async dispatch(){if(phase==='dispatch')controller.abort();controller.signal.throwIfAborted();writes++;return '';},assistant(){}}).catch(()=>{});
    assert.equal(writes,0);if(phase==='before')assert.equal(requests,0);
  }),true);
});
test('real process cancellation and normal completion leave no child or abort listener',async()=>{
  await propertyCheck('extended-real-process-cleanup',fc.asyncProperty(fc.boolean(),fc.integer({min:0,max:3}),async(cancel,delay)=>{
    const controller=new AbortController(),child=spawn(process.execPath,['-e',`setTimeout(()=>process.exit(0),${cancel?60000:20})`],{windowsHide:true,detached:process.platform!=='win32',stdio:'ignore'});
    const owner=observeProcessCompletion(child,{signal:controller.signal,timeoutMs:10000});
    if(cancel){await new Promise(resolve=>setTimeout(resolve,delay));controller.abort();}
    const result=await owner.completion;assert.equal(owner.closed,true);assert.equal(result.cleanupError,undefined);if(child.pid)assert.throws(()=>process.kill(child.pid!,0));
  }),true);
});
