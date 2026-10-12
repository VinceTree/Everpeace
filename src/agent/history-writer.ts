import { persistState } from '../storage/persistence-error.js';
import type { PreparedToolOutput } from './context-limits.js';
import type { LoopEvent } from './agent-loop.js';

export interface HistoryWriterHost {
  append?: ((items:readonly Record<string,unknown>[])=>Promise<void>)|undefined;
  toolResult?: ((item:Record<string,unknown>,attachment?:PreparedToolOutput['attachment'])=>Promise<void>)|undefined;
  recorded(items:readonly Record<string,unknown>[]):void;
  event?: ((event:LoopEvent)=>void)|undefined;
}
/** In-memory history advances only after its durable owner accepts the record. */
export class AgentHistoryWriter {
  constructor(readonly host:HistoryWriterHost){}
  get supportsToolResults():boolean{return this.host.toolResult!==undefined;}
  async persist(items:readonly Record<string,unknown>[]):Promise<void>{
    if(!items.length)return;const start=performance.now();try{await persistState('Context persistence failed',()=>this.host.append?.(items));}finally{this.host.event?.({type:'timing_recorded',operation:'persistence',durationMs:performance.now()-start});}
  }
  async record(items:readonly Record<string,unknown>[]):Promise<void>{await this.persist(items);this.host.recorded(items);}
  async recordTool(item:Record<string,unknown>,prepared:PreparedToolOutput):Promise<void>{
    const start=performance.now();try{if(!this.host.toolResult)throw new Error('Tool result persistence is unavailable');await persistState('Tool output persistence failed',()=>this.host.toolResult!(item,prepared.attachment));this.host.recorded([item]);}finally{this.host.event?.({type:'timing_recorded',operation:'persistence',durationMs:performance.now()-start});}
  }
}
