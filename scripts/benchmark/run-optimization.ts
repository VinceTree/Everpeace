import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseCampaignConfig} from '../../src/benchmark/campaign-cli.js';
import {parseReproducibleBenchmarkTaskCatalog} from '../../src/benchmark/catalog.js';
import {createBenchmarkCampaignPlan,runBenchmarkCampaign,type BenchmarkCampaignResult} from '../../src/benchmark/campaign.js';
import {createCheckoutBenchmarkAdapter,captureBenchmarkCheckoutIdentity} from '../../src/benchmark/checkout.js';
import {createProductionBenchmarkAdapter} from '../../src/benchmark/production.js';
import {prepareBenchmarkFixture} from '../../src/benchmark/preparation.js';
import {captureBenchmarkEvaluationDigest} from '../../src/benchmark/evaluation-identity.js';
import {createFileBenchmarkArtifactSink} from '../../src/benchmark/artifacts.js';
import {controlledComparison} from '../../src/benchmark/controlled-comparison.js';
import {publicBenchmarkReport,benchmarkMarkdown} from '../../src/benchmark/report.js';
import {SystemAuthStorage} from '../../src/storage/auth-storage.js';
import {ModelRegistry} from '../../src/storage/model-registry.js';
import type {BenchmarkRunResult,BenchmarkHarnessAdapter} from '../../src/benchmark/types.js';

/** Multiple balanced pairs may run concurrently; each pair's arms run sequentially. */
export async function runOptimization(args=process.argv.slice(2)):Promise<void>{
  if(!args.includes('--live'))throw Error('Explicit --live is required');
  const configArg=args[args.indexOf('--config')+1];if(!configArg||!args.includes('--config'))throw Error('Use --config <campaign.json>');
  const lanesArg=args.includes('--parallel-pairs')?args[args.indexOf('--parallel-pairs')+1]:'4',lanes=Number(lanesArg);if(!Number.isSafeInteger(lanes)||lanes<1||lanes>8)throw Error('parallel-pairs must be 1–8');
  const configPath=path.resolve(configArg),config=parseCampaignConfig(JSON.parse(await readFile(configPath,'utf8')),configPath);
  if(config.taskTokenBudget!==null||config.campaignTokenBudget!==null)throw Error('Balanced concurrent runner requires explicit null budgets; use campaign-cli for capped campaigns');
  if(config.harnesses.length!==2||config.ordering!=='paired')throw Error('Optimization comparison requires exactly two paired arms');
  const model=(await new ModelRegistry({authStorage:new SystemAuthStorage()}).resolveAll()).available.find(m=>m.id===config.modelId);if(!model)throw Error('Frozen registered model unavailable');
  const tasks=parseReproducibleBenchmarkTaskCatalog(await readFile(config.catalogPath,'utf8')).filter(t=>!config.taskIds||config.taskIds.includes(t.id));
  const evaluationDigest=await captureBenchmarkEvaluationDigest(config.catalogPath,config.fixtureRoot),identities:Record<string,{codeDigest:string;buildDigest:string}>={};
  const evaluatorIdentity=await captureBenchmarkCheckoutIdentity(process.cwd(),path.resolve('scripts/benchmark/run-optimization.ts'));
  const adapters:BenchmarkHarnessAdapter[]=[];
  for(const arm of config.harnesses){
    if(arm.kind==='everpeace-checkout'){const identity=await captureBenchmarkCheckoutIdentity(arm.sourceRoot,arm.entryPath);identities[arm.name]={codeDigest:identity.sourceDigest,buildDigest:identity.buildDigest};adapters.push(createCheckoutBenchmarkAdapter({...arm,model,sessionsRoot:path.join(config.sessionsRoot,arm.name)}));}
    else if(arm.kind==='everpeace'){const name=arm.name??'everpeace',identity=await captureBenchmarkCheckoutIdentity(process.cwd(),path.resolve('src/benchmark/production.ts'));identities[name]={codeDigest:identity.sourceDigest,buildDigest:identity.buildDigest};adapters.push(createProductionBenchmarkAdapter({model,name,sessionsRoot:path.join(config.sessionsRoot,name),...(arm.team?{team:arm.team}:{}),...(arm.repairStrategy?{repairStrategy:arm.repairStrategy}:{})}));}
    else throw Error('Only production and frozen checkout arms are supported');
  }
  const planned=createBenchmarkCampaignPlan(tasks,adapters,config.repetitions,config.seed,'paired'),taskMap=new Map(tasks.map(t=>[t.id,t])),adapterMap=new Map(adapters.map(a=>[a.name,a]));
  await mkdir(config.artifactsRoot,{recursive:true});
  const runnerDigest=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  await writeFile(path.join(config.artifactsRoot,'campaign-plan.json'),JSON.stringify({schema:2,campaignId:config.campaignId,planned,model:model.model_name,evaluationDigest,evaluatorIdentity,identities,runnerDigest,parallelPairs:lanes,taskTokenBudget:config.taskTokenBudget,campaignTokenBudget:config.campaignTokenBudget,measurement:'Arms execute sequentially within each pair, with equal pair concurrency. Wall times include shared endpoint and machine contention.'},null,2));
  const controller=new AbortController(),cancel=()=>controller.abort(new Error('Evaluation cancelled'));process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  const timer=setInterval(()=>{void readFile(path.join(config.artifactsRoot,'cancel.request')).then(cancel).catch(()=>{});},500);timer.unref();
  const results:BenchmarkRunResult[]=[];let cursor=0,stopReason:string|undefined;
  const pairs=Array.from({length:planned.length/2},(_,i)=>planned.slice(i*2,i*2+2));
  async function worker(){while(cursor<pairs.length&&!controller.signal.aborted){const pairIndex=cursor++,pair=pairs[pairIndex]!,task=taskMap.get(pair[0]!.taskId)!,repetition=pair[0]!.repetition;
    const pairResult=await runBenchmarkCampaign([task],pair.map(p=>adapterMap.get(p.harness)!),{campaignId:config.campaignId+'-pair-'+pairIndex,seed:1,repetitions:1,ordering:'paired',liveApi:true,taskTokenBudget:config.taskTokenBudget,campaignTokenBudget:config.campaignTokenBudget,signal:controller.signal,artifactSink:createFileBenchmarkArtifactSink(path.join(config.artifactsRoot,'runs')),prepareRun:(input,arm)=>prepareBenchmarkFixture(input,{fixtureRoot:config.fixtureRoot,destination:path.join(config.runsRoot,config.campaignId,arm,input.id,String(repetition)),signal:controller.signal})});
    for(const run of pairResult.results){const record={...run,repetition};results.push(record);await appendFile(path.join(config.artifactsRoot,'results.jsonl'),JSON.stringify(record)+'\n');console.log(JSON.stringify({completed:results.length,planned:planned.length,task:run.taskId,arm:run.adapter,status:run.status,requests:run.requestAttempts,tokens:run.usage?(run.usage.inputTokens+run.usage.outputTokens):null}));}
    if(pairResult.stopReason){stopReason=pairResult.stopReason;controller.abort(new Error(stopReason));}
  }}
  try{await Promise.all(Array.from({length:lanes},worker));}finally{clearInterval(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
  const completed=new Set(results.map(r=>`${r.adapter}:${r.taskId}:${r.repetition}`));
  const skipped=planned.filter(p=>!completed.has(`${p.harness}:${p.taskId}:${p.repetition}`)).map(p=>({adapter:p.harness,taskId:p.taskId,repetition:p.repetition,reason:'cancelled' as const}));
  const result:BenchmarkCampaignResult={campaignId:config.campaignId,seed:config.seed,planned,results,skipped,tokenUsage:results.reduce((sum,r)=>sum+(r.usage?.inputTokens??0)+(r.usage?.outputTokens??0),0),statisticsComplete:results.length===planned.length&&results.every(r=>r.usage?.complete===true&&!r.cleanupFailed&&!r.isolationFailed),...(stopReason||controller.signal.aborted?{stopReason:stopReason??'Evaluation cancelled'}:{})};
  await writeFile(path.join(config.artifactsRoot,'campaign-result.json'),JSON.stringify(result,null,2));
  if(await captureBenchmarkEvaluationDigest(config.catalogPath,config.fixtureRoot)!==evaluationDigest)throw Error('Frozen evaluation material changed');
  const finalEvaluator=await captureBenchmarkCheckoutIdentity(process.cwd(),path.resolve('scripts/benchmark/run-optimization.ts'));if(finalEvaluator.sourceDigest!==evaluatorIdentity.sourceDigest||finalEvaluator.buildDigest!==evaluatorIdentity.buildDigest)throw Error('Evaluator runner changed during the campaign');
  for(const arm of config.harnesses)if(arm.kind==='everpeace-checkout'){const current=await captureBenchmarkCheckoutIdentity(arm.sourceRoot,arm.entryPath);if(current.sourceDigest!==identities[arm.name]?.codeDigest||current.buildDigest!==identities[arm.name]?.buildDigest)throw Error('Frozen harness changed');}
  const candidate=config.harnesses.find(a=>a.kind==='everpeace'||a.kind==='everpeace-checkout'?a.repairStrategy==='candidate'||a.team?.enabled:false);if(!candidate||candidate.kind!=='everpeace'&&candidate.kind!=='everpeace-checkout')throw Error('Candidate arm unavailable');
  const candidateName=candidate.name??'everpeace',baseline=adapters.find(a=>a.name!==candidateName)!.name,comparison=controlledComparison(result,baseline,candidateName,candidate.repairStrategy==='candidate'?'repair':'team',true);
  await writeFile(path.join(config.artifactsRoot,'controlled-comparison.json'),JSON.stringify(comparison,null,2));
  const publicReport=publicBenchmarkReport(result,{realModelRuns:true,evaluationDigest,byAdapter:identities,sourceTypes:Object.fromEntries(tasks.map(t=>[t.id,t.source!.sourceType!]))});await writeFile(path.join(config.artifactsRoot,'public-report.json'),JSON.stringify(publicReport,null,2));await writeFile(path.join(config.artifactsRoot,'public-report.md'),benchmarkMarkdown(publicReport));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void runOptimization().catch(error=>{console.error('Optimization campaign failed:',error instanceof Error?error.message:'unknown');process.exitCode=1;});
