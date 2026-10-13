// Frozen consumer: requires the v1 contract, tolerates optional additive fields.
// This file is integrity-bound; update only through an explicit compatibility review.
import assert from 'node:assert/strict';
export function consume(lines, version = 1) {
  const events=[]; let finished=false; const tools=new Set();
  for(const line of lines.split('\n')) {
    if(!line.trim())continue;
    const event=JSON.parse(line);
    assert.equal(event.schema_version,version);
    assert.equal(typeof event.timestamp,'string');
    assert.ok(Number.isFinite(Date.parse(event.timestamp)));
    assert.equal(finished,false,'No event may follow run_finished');
    if(event.type==='session_started')assert.equal(typeof event.session_id,'string');
    if(event.type==='assistant_message')assert.equal(typeof event.text,'string');
    if(event.type==='tool_started'&&event.call_id)tools.add(event.call_id);
    if(event.type==='tool_finished'&&event.call_id){assert.ok(tools.has(event.call_id));tools.delete(event.call_id);}
    if(event.type==='run_finished'){
      assert.ok(['success','runtime_error','configuration_error','verification_failed','limit_reached','interaction_required','cancelled'].includes(event.status));
      assert.equal(typeof event.usage_complete,'boolean'); finished=true;
    }
    events.push(event);
  }
  assert.ok(finished,'Missing terminal record is an incomplete run');
  return events;
}
