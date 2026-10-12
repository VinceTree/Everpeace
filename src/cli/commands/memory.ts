import {LearnedMemoryStore,memoryEntryRevision,type LearnedScope} from '../../memory/learned-memory.js';

export const MEMORY_HELP=`Local Memory review (no model or credential access)
  everpeace memory list
  everpeace memory inspect <project|user> <id>
  everpeace memory renew|disable|delete <project|user> <id> <revision>
  everpeace memory correct <project|user> <id> <revision> <JSON correction>
Run in the applicable project directory. Inspect before reviewing; stale revisions are refused.
Confidence describes extraction confidence, not correctness probability.`;
export async function runMemoryCommand(args:string[],store=new LearnedMemoryStore(),workspace=process.cwd(),output:(text:string)=>void=text=>process.stdout.write(text+'\n')):Promise<number>{
  try{
    const [action,scope,id,revision,correction]=args;
    if(!action||['--help','-h'].includes(action)){output(MEMORY_HELP);return 0;}
    if(action==='list'&&args.length===1){output(JSON.stringify(await store.status(workspace),null,2));return 0;}
    if(!['project','user'].includes(scope??''))throw Error('Invalid Memory scope');
    const learnedScope=scope as LearnedScope,entry=(await store.read(learnedScope,workspace)).find(e=>e.id===id);
    if(!entry)throw Error('Entry not found');
    if(action==='inspect'&&args.length===3){output(JSON.stringify({entry,revision:memoryEntryRevision(entry)},null,2));return 0;}
    if(!revision||!['renew','disable','delete','correct'].includes(action)||args.length!==(action==='correct'?5:4))throw Error('Inspect the entry and supply its revision');
    let corrected:{lesson:string;applyWhen:string}|undefined;
    if(action==='correct'){const value:unknown=JSON.parse(correction!);if(!value||typeof value!=='object'||!('lesson'in value)||!('applyWhen'in value)||typeof value.lesson!=='string'||typeof value.applyWhen!=='string')throw Error('Invalid correction');corrected={lesson:value.lesson,applyWhen:value.applyWhen};}
    await store.reviewEntry(learnedScope,workspace,id!,revision,action as 'renew'|'disable'|'delete'|'correct',corrected);output('Memory review saved. Subsequent requests reload the current entry state.');return 0;
  }catch{output('Memory review failed. Inspect the entry again; its revision, scope or storage may have changed.');return 1;}
}
