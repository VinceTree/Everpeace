import { ResourceCleanupError } from '../util/resource-cleanup-error.js';
import { ToolFeedbackError, toolFeedbackFields } from '../tools/tool-feedback.js';
import type { ToolCall } from './agent-loop.js';

type Output=string|{output:string;stop?:boolean};
interface DispatchHost {
  execute(call:ToolCall,signal?:AbortSignal):Promise<Output>;
  cleanupFailed(error:ResourceCleanupError):void;
  takeInteraction():{kind:'approval'|'question';tool:string;prompt?:string}|undefined;
  recordInteraction(value:ReturnType<DispatchHost['takeInteraction']>):void;
}
/** Tool errors and public interaction delivery have one dispatch boundary. */
export class ToolDispatcher {
  async run(call:ToolCall,host:DispatchHost,signal?:AbortSignal):Promise<Output>{
    let output:Output;
    try{output=await host.execute(call,signal);}catch(error){
      if(error instanceof ResourceCleanupError){host.cleanupFailed(error);return JSON.stringify({status:'error',cleanup_failed:true,error:error.message});}
      if(signal?.aborted||!(error instanceof ToolFeedbackError))throw error;
      output=JSON.stringify({status:'error',error:error.message,...toolFeedbackFields(error)});
    }
    const interaction=host.takeInteraction();if(!interaction)return output;
    const snapshot=structuredClone(interaction);host.recordInteraction(snapshot);return {output:JSON.stringify({status:'interaction_required',...snapshot}),stop:true};
  }
}
