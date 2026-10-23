import test from 'node:test';
import assert from 'node:assert/strict';

test('deferred product plan preserves the full paired denominator without invented evidence',async()=>{
 const {productPlan}=await import(new URL('../../../scripts/benchmark/prepare-product-plan.mjs',import.meta.url).href) as {productPlan(seed?:number):{plannedCount:number;executed:number;complete:boolean;definitionDigest:string;parallelPairs:number;planned:Array<{pair:number;withinPair:number;taskId:string;arm:string;repetition:number;status:string}>;tasks:Array<{scenario:string;materialStatus:string}>;metrics:{tokens:null}}};
 const plan=productPlan();assert.equal(plan.plannedCount,150);assert.equal(plan.executed,0);assert.equal(plan.complete,false);assert.equal(plan.metrics.tokens,null);assert.equal(plan.parallelPairs,1);assert.equal(plan.tasks.length,15);
 assert.equal(new Set(plan.tasks.map(task=>task.scenario)).size,5);assert.ok(plan.tasks.every(task=>task.materialStatus==='not_frozen'));
 assert.deepEqual(productPlan().planned,plan.planned);assert.notDeepEqual(productPlan(42).planned,plan.planned);assert.equal(productPlan(42).definitionDigest,plan.definitionDigest);
 for(let i=0;i<plan.planned.length;i+=2){const a=plan.planned[i]!,b=plan.planned[i+1]!;assert.equal(a.pair,b.pair);assert.equal(a.taskId,b.taskId);assert.equal(a.repetition,b.repetition);assert.notEqual(a.arm,b.arm);assert.equal(a.status,'not_executed');}
});
