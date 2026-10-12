import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {parseReproducibleBenchmarkTaskCatalog} from '../../src/benchmark/catalog.js';
import {proveBenchmarkFixture} from '../../src/benchmark/preparation.js';
import {captureBenchmarkEvaluationDigest} from '../../src/benchmark/evaluation-identity.js';
const catalog=path.resolve('docs/benchmark/OPTIMIZATION_TASKS.json'),root=path.resolve('tests/fixtures/optimization'),output=path.resolve(process.argv[2]??'.cache/optimization-proof');await mkdir(output,{recursive:true});
const tasks=parseReproducibleBenchmarkTaskCatalog(await readFile(catalog,'utf8')),records=[];
for(const task of tasks){try{const result=await proveBenchmarkFixture(task,{fixtureRoot:root,destination:path.join(output,task.id)});records.push({task:task.id,healthy:true,seeded:result.seeded.passed,reference:result.repaired.passed});}catch(error){records.push({task:task.id,error:String(error)});}}
await writeFile(path.join(output,'proof.json'),JSON.stringify({schema:1,evaluationDigest:await captureBenchmarkEvaluationDigest(catalog,root),records},null,2));assert.equal(records.filter(r=>r.healthy&&r.seeded===false&&r.reference===true).length,12);console.log('All 12 frozen optimization tasks proved healthy → defective → repaired.');
