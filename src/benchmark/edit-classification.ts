import { spawn } from 'node:child_process';
import { observeProcessCompletion } from '../tools/process-completion.js';
import type { BenchmarkTask, BenchmarkVerificationResult } from './types.js';

export interface EditClassification { state: 'clean' | 'erroneous' | 'unknown'; regression?: BenchmarkVerificationResult; outsideScope: number }
/** Scoring is evaluator-owned. Failure to solve the task is not an erroneous edit. */
export async function classifyEditScope(task: BenchmarkTask, regression?: BenchmarkVerificationResult): Promise<EditClassification> {
  if (!task.allowedPaths?.length || !regression?.attempted || regression.error || regression.timedOut || regression.cancelled || regression.cleanupFailed) return {state:'unknown', outsideScope:0, ...(regression ? {regression} : {})};
  let outsideScope = 0;
  for (const args of [['diff','--name-only','-z','HEAD','--'], ['ls-files','--others','--exclude-standard','-z']]) {
    const child = spawn('git', args, {cwd:task.workspacePath,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    const owner = observeProcessCompletion(child,{timeoutMs:30000}); let output=''; let overflow=false;
    child.stdout!.setEncoding('utf8'); child.stdout!.on('data',(chunk:string)=>{if(Buffer.byteLength(output)+Buffer.byteLength(chunk)>2*1024*1024){overflow=true;owner.stop();}else output+=chunk;}); child.stderr!.resume();
    const result=await owner.completion;
    if(result.cleanupError) throw result.cleanupError;
    if(result.error || result.timedOut || result.exitCode!==0 || overflow) return {state:'unknown',outsideScope,regression};
    for(const name of output.split('\0').filter(Boolean)) { const file=process.platform==='win32'?name.toLowerCase():name; if(!task.allowedPaths.some(p=>{const scope=process.platform==='win32'?p.toLowerCase():p;return scope==='.'||file===scope||file.startsWith(scope.replace(/\/$/u,'')+'/');})) outsideScope++; }
  }
  return {state:!regression.passed||outsideScope>0?'erroneous':'clean', outsideScope, regression};
}
