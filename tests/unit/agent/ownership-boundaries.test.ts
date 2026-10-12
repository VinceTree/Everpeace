import test from 'node:test';
import assert from 'node:assert/strict';
import {TurnLifecycle} from '../../../src/agent/turn-lifecycle.js';
import {AgentHistoryWriter} from '../../../src/agent/history-writer.js';
import {ToolDispatcher} from '../../../src/agent/tool-dispatcher.js';
import {ResourceCleanupError} from '../../../src/util/resource-cleanup-error.js';
test('failed persistence cannot advance history and emits a settlement timing',async()=>{
  let appended=0,timings=0;const writer=new AgentHistoryWriter({append:async()=>{throw Error('injected persistence failure');},recorded:()=>appended++,event:()=>timings++});await assert.rejects(writer.record([{type:'message'}]));assert.equal(appended,0);assert.equal(timings,1);
});
test('turn disposal is shared and cancellation ownership is released only at the outer boundary',async()=>{
  const lifecycle=new TurnLifecycle<void>(),controller=new AbortController();lifecycle.setController(controller);lifecycle.markRunning();lifecycle.setOperation(Promise.resolve());lifecycle.markIdle();assert.equal(lifecycle.controller,controller);let calls=0;const run=async()=>{calls++;lifecycle.markDisposed();controller.abort();await lifecycle.operation;};assert.equal(lifecycle.disposeOnce(run),lifecycle.disposeOnce(run));assert.equal(calls,1);lifecycle.clearTurn();assert.equal(lifecycle.controller,undefined);assert.equal(lifecycle.disposed,true);
});
test('cleanup failures dominate interaction delivery and retain resource debt',async()=>{
  const dispatcher=new ToolDispatcher();let debt=false,interactions=0;class Failure extends ResourceCleanupError {readonly resource='process';}const result=await dispatcher.run({type:'function_call',name:'fixture',call_id:'fixture',arguments:'{}'},{execute:async()=>{throw new Failure('injected cleanup failure');},cleanupFailed:()=>{debt=true;},takeInteraction:()=>{interactions++;return undefined;},recordInteraction:()=>{}});assert.equal(debt,true);assert.equal(interactions,0);assert.match(String(result),/cleanup_failed/u);
});
