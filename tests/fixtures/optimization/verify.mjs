import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [task,workspace,mode='acceptance']=process.argv.slice(2);
if(!task||!workspace||!['acceptance','regression','setup'].includes(mode))throw Error('Invalid external verifier invocation');
if(mode==='setup'){assert.ok(Number(process.versions.node.split('.')[0])>=22);console.log('Dependency-free pinned source preparation verified.');process.exit(0);}
const spec=JSON.parse(await readFile(new URL('./'+task+'/assertions.json',import.meta.url),'utf8'));
try{
  for(const name of ['a','b']){
    const assertions=spec[mode][name];if(!assertions.length)continue;
    const module=await import(pathToFileURL(path.join(workspace,name+'.mjs')).href);
    for(const [input,expected]of assertions)assert.deepEqual(await module.transform(input),expected);
  }
  console.log(JSON.stringify({kind:mode,passed:true,assertions:spec[mode].a.length+spec[mode].b.length}));
}catch(error){console.error('OPTIMIZATION_ASSERTION_FAILED',error instanceof Error?error.message:String(error));process.exitCode=1;}
