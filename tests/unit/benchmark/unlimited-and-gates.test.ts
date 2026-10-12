import test from 'node:test';
import assert from 'node:assert/strict';
import {runBenchmarkCampaign} from '../../../src/benchmark/campaign.js';
import {runBenchmarkTask} from '../../../src/benchmark/runner.js';
import {controlledComparison} from '../../../src/benchmark/controlled-comparison.js';
import type {BenchmarkRunResult} from '../../../src/benchmark/types.js';
test('explicit null admits live tasks and campaigns without weakening metering',async()=>{
  const tasks=[{id:'unlimited',prompt:'fixture',workspacePath:process.cwd()}],adapter={name:'fixture',async run(){return {usage:{inputTokens:999999,outputTokens:3,complete:true}};}};
  await assert.rejects(runBenchmarkTask(tasks[0]!,adapter,{liveApi:true}),/positive/u);
  const result=await runBenchmarkCampaign(tasks,[adapter],{campaignId:'fixture',seed:1,repetitions:2,liveApi:true,taskTokenBudget:null,campaignTokenBudget:null,prepareRun:async task=>task});assert.equal(result.results.length,2);assert.equal(result.tokenUsage,2000004);assert.equal(result.statisticsComplete,true);
});
test('controlled gates include failed costs and require classification, repetitions and actual team execution',()=>{
  const planned=[],results:BenchmarkRunResult[]=[];
  for(let task=0;task<12;task++)for(let repetition=1;repetition<=5;repetition++)for(const arm of ['baseline','candidate']){const candidate=arm==='candidate';planned.push({index:planned.length,taskId:String(task),repetition,harness:arm});results.push({taskId:String(task),repetition,adapter:arm,status:'passed',startedAt:'2026-10-12T00:00:00Z',durationMs:candidate?900:1000,attempts:1,manualInterventions:0,unsafeActions:0,requestAttempts:1,workflowOutcome:'verified',verification:{attempted:true,passed:true,exitCode:0,stdout:'',stderr:'',durationMs:1,timedOut:false,cancelled:false},usage:{inputTokens:candidate?80:100,outputTokens:1,complete:true},editClassification:{state:'clean',outsideScope:0},metrics:{durationMs:1,phases:[],samplingAttempts:1,responses:1,responseRejections:0,incompleteResponses:0,invalidToolCalls:0,toolCalls:0,toolResults:0,unclosedToolCalls:0,toolFailures:0,toolBatches:0,firstToolStartDelayMs:null,firstModelEventDelayMs:null,firstModelTextDelayMs:null,retries:0,streamRecoveries:0,successfulStreamRecoveries:0,compactions:0,cancellations:0,steeringApplications:0,timings:{},toolResultOrder:[]}});}
  const campaign={campaignId:'fixture',seed:1,planned,results,skipped:[],tokenUsage:1,statisticsComplete:true};assert.equal(controlledComparison(campaign,'baseline','candidate','repair',true).eligibleForDefault,true);assert.equal(controlledComparison(campaign,'baseline','candidate','team',true).eligibleForDefault,false);assert.equal(controlledComparison(campaign,'baseline','candidate','repair',false).eligibleForDefault,false);
  const missing={...campaign,results:results.map((r,i)=>i===1?{...r,editClassification:{state:'unknown' as const,outsideScope:0}}:r)};assert.equal(controlledComparison(missing,'baseline','candidate','repair',true).eligibleForDefault,false);
  const expensive={...campaign,results:results.map(r=>r.adapter==='candidate'?{...r,durationMs:1100}:r)};assert.equal(controlledComparison(expensive,'baseline','candidate','repair',true).eligibleForDefault,false);
});
