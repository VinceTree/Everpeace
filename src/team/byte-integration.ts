import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ApplyPatchResult } from '../tools/apply-patch.js';
import { isProtectedPatchPath } from '../tools/sandbox-policy.js';
import { loadTeamWorkspace, type TeamWorkspaceRecord } from './workspace.js';
import { inspectTeamFile, safeTeamPath, copyTeamFile, TEAM_TOTAL_LIMIT } from './file-artifacts.js';

export interface TeamByteOperation { path: string; action: 'create'|'update'|'delete'; beforeHash: string|null; afterHash: string|null }
interface Journal {version:1;source:string;workspace:string;state:'prepared'|'committed'|'recovered';operations:TeamByteOperation[]}
type Guard=()=>void|Promise<void>;
function validOperation(op:TeamByteOperation):boolean {const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);return op.action==='create'?op.beforeHash===null&&hash(op.afterHash):op.action==='delete'?hash(op.beforeHash)&&op.afterHash===null:op.action==='update'&&hash(op.beforeHash)&&hash(op.afterHash);}
function authorized(name:string,scopes:readonly string[]):boolean {const file=process.platform==='win32'?name.toLowerCase():name;return !isProtectedPatchPath(name)&&scopes.some(p=>{const s=process.platform==='win32'?p.toLowerCase():p;return s==='.'||file===s||file.startsWith(s.replace(/\/$/u,'')+'/');});}
async function directory(record:TeamWorkspaceRecord,id:string):Promise<string> {if(!/^[a-f0-9-]{36}$/u.test(id))throw new Error('Invalid integration owner');await loadTeamWorkspace(record.workspace,record.source);const transactions=await safeTeamPath(record.owner,'transactions');await fs.mkdir(transactions,{recursive:true});const target=await safeTeamPath(record.owner,`transactions/${id}`);await fs.mkdir(target,{recursive:true});await safeTeamPath(record.owner,`transactions/${id}/journal.json`);return target;}
async function save(root:string,journal:Journal):Promise<void> {const temp=path.join(root,`${randomUUID()}.tmp`);try{await fs.writeFile(temp,JSON.stringify(journal),{flag:'wx',mode:0o600});await fs.rename(temp,path.join(root,'journal.json'));}finally{await fs.rm(temp,{force:true});}}
async function read(root:string,record:TeamWorkspaceRecord,scopes:readonly string[]):Promise<Journal|null> {
  const target=await safeTeamPath(root,'journal.json');let stat;try{stat=await fs.lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||stat.size>128*1024)throw new Error('Invalid integration journal');
  const j=JSON.parse(await fs.readFile(target,'utf8')) as Journal;
  const hash=(s:unknown)=>s===null||typeof s==='string'&&/^[a-f0-9]{64}$/u.test(s);
  if(j.version!==1||j.source!==record.source||j.workspace!==record.workspace||!['prepared','committed','recovered'].includes(j.state)||!Array.isArray(j.operations)||j.operations.length>20||j.operations.some(o=>!o||typeof o.path!=='string'||!authorized(o.path,scopes)||!['create','update','delete'].includes(o.action)||!hash(o.beforeHash)||!hash(o.afterHash)))throw new Error('Integration journal ownership or scope changed');
  return j;
}
async function replaceFromBackup(root:string,artifactName:string,record:TeamWorkspaceRecord,op:TeamByteOperation,expectedCurrent:string|null,guard:Guard,signal?:AbortSignal):Promise<void> {
  const target=await safeTeamPath(record.source,op.path,true);
  const temporary=path.join(path.dirname(target),`.everpeace-team-${randomUUID()}.tmp`);
  try {
    if(op.beforeHash!==null){const backup=await inspectTeamFile(root,artifactName,signal);if(!backup||backup.hash!==op.beforeHash)throw new Error('Integration recovery backup changed');await copyTeamFile(root,artifactName,temporary,backup,signal);}
    await guard();signal?.throwIfAborted();
    const current=await inspectTeamFile(record.source,op.path,signal);if((current?.hash??null)!==expectedCurrent)throw new Error('Concurrent edit retained during recovery');
    await safeTeamPath(record.source,op.path);
    if(op.beforeHash===null)await fs.unlink(target);else await fs.rename(temporary,target);
  } finally {await fs.rm(temporary,{force:true});}
}
export async function recoverTeamIntegration(record:TeamWorkspaceRecord,id:string,scopes:readonly string[],guard:Guard,signal?:AbortSignal):Promise<{conflicts:string[];recovered:boolean}> {
  const root=await directory(record,id),journal=await read(root,record,scopes);if(!journal||journal.state!=='prepared')return {conflicts:[],recovered:true};
  const conflicts:string[]=[];
  for(const [i,op] of [...journal.operations.entries()].reverse()) {
    try {const current=await inspectTeamFile(record.source,op.path,signal),hash=current?.hash??null;if(hash===op.beforeHash)continue;if(hash!==op.afterHash){conflicts.push(op.path);continue;}await replaceFromBackup(root,`${i}.before`,record,op,hash,guard,signal);}catch{conflicts.push(op.path);}
  }
  if(!conflicts.length){journal.state='recovered';await save(root,journal);}
  return {conflicts,recovered:conflicts.length===0};
}

/** Host-only byte operations are never accepted as model tool arguments. */
export async function integrateTeamBytes(record:TeamWorkspaceRecord,operations:readonly TeamByteOperation[],scopes:readonly string[],id:string,guard:Guard,signal?:AbortSignal):Promise<ApplyPatchResult> {
  if(!operations.length||operations.length>20||new Set(operations.map(o=>o.path)).size!==operations.length||operations.some(o=>!validOperation(o)||!authorized(o.path,scopes)))return {status:'rejected',files:[],error:'Unsafe byte integration scope'};
  const root=await directory(record,id),prior=await read(root,record,scopes);
  if(prior?.state==='committed') {
    if(JSON.stringify(prior.operations)!==JSON.stringify(operations))return {status:'rejected',files:[],error:'Integration identity changed'};
    for(const op of operations)if((await inspectTeamFile(record.source,op.path,signal))?.hash!==(op.afterHash??undefined))return {status:'rejected',files:[],error:'Committed integration changed'};
    return {status:'applied',files:operations.map(o=>({path:o.path,action:o.action,status:'applied'}))};
  }
  if(prior?.state==='prepared'){const recovered=await recoverTeamIntegration(record,id,scopes,guard,signal);if(!recovered.recovered)return {status:'failed',files:[],rolledBack:false,rollbackConflicts:recovered.conflicts,error:'Prior integration requires conflict resolution'};}
  const journal:Journal={version:1,source:record.source,workspace:record.workspace,state:'prepared',operations:[...operations]};
  const files:ApplyPatchResult['files']=[];let total=0;
  try {
    await guard();signal?.throwIfAborted();
    for(const [i,op] of operations.entries()) {
      const current=await inspectTeamFile(record.source,op.path,signal),after=await inspectTeamFile(record.workspace,op.path,signal);
      if((current?.hash??null)!==op.beforeHash||(after?.hash??null)!==op.afterHash)throw new Error('Integration artifact or destination changed');
      total+=(current?.size??0)+(after?.size??0);if(total>2*TEAM_TOTAL_LIMIT)throw new Error('Integration staging budget exceeded');
      for(const suffix of ['before','after'])await fs.rm(path.join(root,`${i}.${suffix}`),{force:true});
      if(current)await copyTeamFile(record.source,op.path,path.join(root,`${i}.before`),current,signal);
      if(after)await copyTeamFile(record.workspace,op.path,path.join(root,`${i}.after`),after,signal);
    }
    await save(root,journal);
    for(const [i,op] of operations.entries()) {
      const target=await safeTeamPath(record.source,op.path,true),temporary=path.join(path.dirname(target),`.everpeace-team-${randomUUID()}.tmp`);
      try {
        if(op.afterHash!==null){const staged=await inspectTeamFile(root,`${i}.after`,signal);if(!staged||staged.hash!==op.afterHash)throw new Error('Staged bytes changed');await copyTeamFile(root,`${i}.after`,temporary,staged,signal);}
        await guard();signal?.throwIfAborted();
        if((await inspectTeamFile(record.source,op.path,signal))?.hash!==(op.beforeHash??undefined))throw new Error('Concurrent edit retained during integration');
        await safeTeamPath(record.source,op.path);
        if(op.afterHash===null)await fs.unlink(target);else if(op.beforeHash===null){await fs.link(temporary,target);await fs.unlink(temporary);}else await fs.rename(temporary,target);
        files.push({path:op.path,action:op.action,status:'applied'});
      }finally{await fs.rm(temporary,{force:true});}
    }
    journal.state='committed';await save(root,journal);
    return {status:'applied',files,diffSummary:operations.map(o=>`${o.action} ${o.path} (raw bytes)`).join('\n')};
  }catch(error){
    const recovered=await recoverTeamIntegration(record,id,scopes,guard).catch(()=>({conflicts:operations.map(o=>o.path),recovered:false}));
    return {status:'failed',files,rolledBack:recovered.recovered,...(recovered.conflicts.length?{rollbackConflicts:recovered.conflicts}:{}),error:error instanceof Error?error.message:'Byte integration failed'};
  }
}
