import {uiText,UI_CATALOGS} from '../../localization/messages.js';
import {LearnedMemoryStore,memoryEntryRevision,type LearnedScope} from '../../memory/learned-memory.js';

export const MEMORY_HELP=UI_CATALOGS.en['help.memory'];
export async function runMemoryCommand(args:string[],store=new LearnedMemoryStore(),workspace=process.cwd(),output:(text:string)=>void=text=>process.stdout.write(text+'\n')):Promise<number>{
  try{
    const [action,scope,id,revision,correction]=args;
    if(!action||['--help','-h'].includes(action)){output(uiText('help.memory'));return 0;}
    if(action==='list'&&args.length===1){output(JSON.stringify(await store.status(workspace),null,2));return 0;}
    if(!['project','user'].includes(scope??''))throw Error(uiText('m5235360f15ec'));
    const learnedScope=scope as LearnedScope,entry=(await store.read(learnedScope,workspace)).find(e=>e.id===id);
    if(!entry)throw Error(uiText('mf36668ddf224'));
    if(action==='inspect'&&args.length===3){output(JSON.stringify({entry,revision:memoryEntryRevision(entry)},null,2));return 0;}
    if(!revision||!['renew','disable','delete','correct'].includes(action)||args.length!==(action==='correct'?5:4))throw Error(uiText('me39d34adfa7a'));
    let corrected:{lesson:string;applyWhen:string}|undefined;
    if(action==='correct'){const value:unknown=JSON.parse(correction!);if(!value||typeof value!=='object'||!('lesson'in value)||!('applyWhen'in value)||typeof value.lesson!=='string'||typeof value.applyWhen!=='string')throw Error(uiText('m38289a9f594a'));corrected={lesson:value.lesson,applyWhen:value.applyWhen};}
    await store.reviewEntry(learnedScope,workspace,id!,revision,action as 'renew'|'disable'|'delete'|'correct',corrected);output(uiText('m739cc90f3dba'));return 0;
  }catch{output(uiText('md387a1210a1c'));return 1;}
}
