import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {main as campaignMain,parseCampaignConfig} from '../../src/benchmark/campaign-cli.js';
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
import {canonicalBaseUrl} from '../../src/providers/capabilities.js';

export function optimizationConcurrency(taskBudget:number|null,campaignBudget:number|null,value='1'):number {
  const lanes=Number(value);if(!Number.isSafeInteger(lanes)||lanes<1||lanes>8)throw Error('parallel-pairs must be 1-8');
  if((taskBudget===null)!==(campaignBudget===null))throw Error('Optimization budgets must both be numeric or both explicitly null');
  if(taskBudget!==null&&lanes!==1)throw Error('Bounded optimization requires parallel-pairs=1');
  return lanes;
}

/** Multiple balanced pairs may run concurrently; each pair's arms run sequentially. */
export async function runOptimization(args=process.argv.slice(2)):Promise<void>{
  if(args.includes('--preflight')||args.includes('--prove-fixtures')){await campaignMain(args);return;}
  if(!args.includes('--live'))throw Error('Explicit --live is required');
  const configArg=args[args.indexOf('--config')+1];if(!configArg||!args.includes('--config'))throw Error('Use --config <campaign.json>');
  const lanesArg=args.includes('--parallel-pairs')?args[args.indexOf('--parallel-pairs')+1]:'1';
  const configPath=path.resolve(configArg),config=parseCampaignConfig(JSON.parse(await readFile(configPath,'utf8')),configPath);
  const lanes=optimizationConcurrency(config.taskTokenBudget,config.campaignTokenBudget,lanesArg);
  if(config.harnesses.length!==2||config.ordering!=='paired')throw Error('Optimization comparison requires exactly two paired arms');
  if(lanes===1){await campaignMain(args);return;}
  const registered=(await new ModelRegistry({authStorage:new SystemAuthStorage()}).resolveAll()).available.find(m=>m.id===config.modelId);if(!registered)throw Error('Frozen registered model unavailable');
  if(config.modelBaseUrl&&canonicalBaseUrl(registered.base_url)!==canonicalBaseUrl(config.modelBaseUrl))throw Error('Frozen endpoint mismatch');
  const model={...registered,...(config.responsesProfile?{responses_profile:config.responsesProfile}:{})};
  const tasks=parseReproducibleBenchmarkTaskCatalog(await readFile(config.catalogPath,'utf8')).filter(t=>!config.taskIds||config.taskIds.includes(t.id));
  const evaluationDigest=await captureBenchmarkEvaluationDigest(config.catalogPath,config.fixtureRoot),identities:Record<string,{codeDigest:string;buildDigest:string}>={};
  if(config.evaluationDigest&&config.evaluationDigest!==evaluationDigest)throw Error('Frozen evaluation changed');
  const evaluatorIdentity=await captureBenchmarkCheckoutIdentity(process.cwd(),path.resolve('scripts/benchmark/run-optimization.ts'));
  const adapters:BenchmarkHarnessAdapter[]=[];
  for(const arm of config.harnesses){
    if(arm.kind==='everpeace-checkout'){if(arm.expected.model!==model.model_name)throw Error('Frozen raw model mismatch');const identity=await captureBenchmarkCheckoutIdentity(arm.sourceRoot,arm.entryPath);identities[arm.name]={codeDigest:identity.sourceDigest,buildDigest:identity.buildDigest};adapters.push(createCheckoutBenchmarkAdapter({...arm,model,sessionsRoot:path.join(config.sessionsRoot,arm.name)}));}
    else if(arm.kind==='everpeace'){const name=arm.name??'everpeace',identity=await captureBenchmarkCheckoutIdentity(process.cwd(),path.resolve('src/benchmark/production.ts'));identities[name]={codeDigest:identity.sourceDigest,buildDigest:identity.buildDigest};adapters.push(createProductionBenchmarkAdapter({model,name,sessionsRoot:path.join(config.sessionsRoot,name),...(arm.team?{team:arm.team}:{}),...(arm.repairStrategy?{repairStrategy:arm.repairStrategy}:{})}));}
    else throw Error('Only production and frozen checkout arms are supported');
  }
  const planned=createBenchmarkCampaignPlan(tasks,adapters,config.repetitions,config.seed,'paired'),taskMap=new Map(tasks.map(t=>[t.id,t])),adapterMap=new Map(adapters.map(a=>[a.name,a]));
  await mkdir(config.artifactsRoot,{recursive:true});
  await writeFile(path.join(config.artifactsRoot,'campaign-started.json'),JSON.stringify({at:new Date().toISOString(),endpoint:model.base_url,model:model.model_name,responsesProfile:model.responses_profile??null,requestSettings:{reasoningEffort:'high',maxOutputTokens:32768},identities,evaluationDigest,taskTokenBudget:config.taskTokenBudget,campaignTokenBudget:config.campaignTokenBudget,parallelPairs:lanes}),{flag:'wx'});
  const runnerDigest=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  await writeFile(path.join(config.artifactsRoot,'campaign-plan.json'),JSON.stringify({schema:2,campaignId:config.campaignId,planned,model:model.model_name,evaluationDigest,evaluatorIdentity,identities,runnerDigest,parallelPairs:lanes,taskTokenBudget:config.taskTokenBudget,campaignTokenBudget:config.campaignTokenBudget,measurement:'Arms execute sequentially within each pair, with equal pair concurrency. Wall times include shared endpoint and machine contention.'},null,2),{flag:'wx'});
  const controller=new AbortController(),cancel=()=>controller.abort(new Error('Evaluation cancelled'));process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  const timer=setInterval(()=>{void readFile(path.join(config.artifactsRoot,'cancel.request')).then(cancel).catch(()=>{});},500);timer.unref();
  const results:BenchmarkRunResult[]=[];let cursor=0,stopReason:string|undefined,stopCode:BenchmarkCampaignResult['stopCode'];
  const pairs=Array.from({length:planned.length/2},(_,i)=>planned.slice(i*2,i*2+2));
  async function worker(){while(cursor<pairs.length&&!controller.signal.aborted){const pairIndex=cursor++,pair=pairs[pairIndex]!,task=taskMap.get(pair[0]!.taskId)!,repetition=pair[0]!.repetition;
    const pairResult=await runBenchmarkCampaign([task],pair.map(p=>adapterMap.get(p.harness)!),{campaignId:config.campaignId+'-pair-'+pairIndex,seed:1,repetitions:1,ordering:'paired',liveApi:true,taskTokenBudget:config.taskTokenBudget,campaignTokenBudget:config.campaignTokenBudget,signal:controller.signal,artifactSink:createFileBenchmarkArtifactSink(path.join(config.artifactsRoot,'runs')),prepareRun:(input,arm)=>prepareBenchmarkFixture(input,{fixtureRoot:config.fixtureRoot,destination:path.join(config.runsRoot,config.campaignId,arm,input.id,String(repetition)),signal:controller.signal}),onResult:async run=>{const record={...run,repetition,pairId:`${run.taskId}:${repetition}`};results.push(record);await appendFile(path.join(config.artifactsRoot,'results.jsonl'),JSON.stringify(record)+'\n');}});
    if(pairResult.stopReason){stopReason??=pairResult.stopReason;stopCode??=pairResult.stopCode;controller.abort(new Error(stopReason));}
  }}
  try{await Promise.allSettled(Array.from({length:lanes},async()=>{try{await worker();}catch{stopReason??='Optimization worker failed';stopCode??='runtime_error';controller.abort();}}));}finally{clearInterval(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
  const completed=new Set(results.map(r=>`${r.adapter}:${r.taskId}:${r.repetition}`));
  const skipped=planned.filter(p=>!completed.has(`${p.harness}:${p.taskId}:${p.repetition}`)).map(p=>({adapter:p.harness,taskId:p.taskId,repetition:p.repetition,reason:stopCode??'cancelled' as const}));
  const result:BenchmarkCampaignResult={campaignId:config.campaignId,seed:config.seed,planned,results,skipped,tokenUsage:results.reduce((sum,r)=>sum+(r.usage?.inputTokens??0)+(r.usage?.outputTokens??0),0),statisticsComplete:!stopCode&&!controller.signal.aborted&&results.length===planned.length&&results.every(r=>r.usage?.complete===true&&!r.cleanupFailed&&!r.isolationFailed&&!r.storageFailed),...(stopReason||controller.signal.aborted?{stopReason:stopReason??'Evaluation cancelled'}:{}),...(stopCode?{stopCode}:{})};
  try {
  if(await captureBenchmarkEvaluationDigest(config.catalogPath,config.fixtureRoot)!==evaluationDigest)throw Error('Frozen evaluation material changed');
  const finalEvaluator=await captureBenchmarkCheckoutIdentity(process.cwd(),path.resolve('scripts/benchmark/run-optimization.ts'));if(finalEvaluator.sourceDigest!==evaluatorIdentity.sourceDigest||finalEvaluator.buildDigest!==evaluatorIdentity.buildDigest)throw Error('Evaluator runner changed during the campaign');
  for(const arm of config.harnesses)if(arm.kind==='everpeace-checkout'){const current=await captureBenchmarkCheckoutIdentity(arm.sourceRoot,arm.entryPath);if(current.sourceDigest!==identities[arm.name]?.codeDigest||current.buildDigest!==identities[arm.name]?.buildDigest)throw Error('Frozen harness changed');}
  } catch { result.statisticsComplete=false;result.stopCode='identity_changed';result.stopReason='Frozen identity changed or could not be rechecked'; }
  await writeFile(path.join(config.artifactsRoot,'campaign-result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  const candidate=config.harnesses.find(a=>a.kind==='everpeace'||a.kind==='everpeace-checkout'?a.repairStrategy==='candidate'||a.team?.enabled:false);if(!candidate||candidate.kind!=='everpeace'&&candidate.kind!=='everpeace-checkout')throw Error('Candidate arm unavailable');
  const candidateName=candidate.name??'everpeace',baseline=adapters.find(a=>a.name!==candidateName)!.name,comparison=controlledComparison(result,baseline,candidateName,candidate.repairStrategy==='candidate'?'repair':'team',true);
  await writeFile(path.join(config.artifactsRoot,'controlled-comparison.json'),JSON.stringify(comparison,null,2));
  const publicReport=publicBenchmarkReport(result,{realModelRuns:true,evaluationDigest,byAdapter:identities,sourceTypes:Object.fromEntries(tasks.map(t=>[t.id,t.source!.sourceType!]))});await writeFile(path.join(config.artifactsRoot,'public-report.json'),JSON.stringify(publicReport,null,2));await writeFile(path.join(config.artifactsRoot,'public-report.md'),benchmarkMarkdown(publicReport));
  if(!result.statisticsComplete)throw Error(result.stopReason??'Campaign evidence is incomplete');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void runOptimization().catch(error=>{console.error('Optimization campaign failed:',error instanceof Error?error.message:'unknown');process.exitCode=1;});
