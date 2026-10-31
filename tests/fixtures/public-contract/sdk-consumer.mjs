import assert from 'node:assert/strict';
import http from 'node:http';
import {runTask,EXEC_ERROR_CODES} from 'everpeace/sdk';
assert.ok(EXEC_ERROR_CODES.includes('CLEANUP_FAILED'));
const noModels={async resolveAll(){return {available:[],missing:[]};}};
const invalid=await runTask({prompt:' ',registry:noModels});
assert.equal(invalid.exitCode,2);assert.equal(invalid.errorCode,'CONFIGURATION_ERROR');
const workspacePath=process.env.EVERPEACE_CONSUMER_WORKSPACE;
let calls=0;
const server=http.createServer(async(request,response)=>{
  for await(const _chunk of request){ /* fully drain the request */ }
  calls++; const name=calls===1?'submit_plan':'request_user_input';
  const argumentsValue=calls===1?{title:'Public SDK plan',plan:'Inspect and verify a scoped change.'}:{questions:[{id:'scope',header:'Scope',question:'Choose scope',options:[{label:'Small',description:'One module'},{label:'Large',description:'Multiple modules'}]}]};
  response.writeHead(200,{'Content-Type':'text/event-stream'});
  response.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'response-'+calls,object:'response',status:'completed',output:[{id:'item-'+calls,type:'function_call',name,call_id:'call-'+calls,arguments:JSON.stringify(argumentsValue)}],usage:{input_tokens:2,output_tokens:1,total_tokens:3}}})+'\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const model={id:'consumer',model_name:'consumer-fixture',base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'fixture'};
const registry={async resolveAll(){return {available:[model],missing:[]};}};
try {
  const events=[];const result=await runTask({prompt:'Inspect a scoped plan',plan:true,workspacePath,registry,timeoutMs:15000,onEvent:async event=>{events.push(event);await Promise.resolve();}});
  assert.equal(result.exitCode,0,JSON.stringify({calls,status:result.status,tool:result.interaction?.tool,prompt:result.interaction?.prompt}));assert.equal(result.status,'plan');assert.equal(result.errorCode,undefined);assert.equal(events[0].type,'session_started');
  const starts=events.filter(e=>e.type==='tool_started'),ends=events.filter(e=>e.type==='tool_finished');assert.equal(starts.length,ends.length);
  const question=await runTask({prompt:'Ask which scope',plan:true,workspacePath,registry,timeoutMs:15000});assert.equal(question.exitCode,5);assert.equal(question.errorCode,'INTERACTION_REQUIRED');
  const failed=await runTask({prompt:'Callback failure',plan:true,workspacePath,registry,onEvent(){throw Error('Consumer callback failed');}});assert.equal(failed.exitCode,1);assert.equal(failed.classification,'runtime_error');
  const controller=new AbortController();controller.abort();const cancelled=await runTask({prompt:'Pre-cancelled',workspacePath,registry,signal:controller.signal});assert.equal(cancelled.classification,'cancelled');assert.equal(cancelled.exitCode,130);
  assert.equal(calls,2);console.log('Public SDK consumer passed');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
