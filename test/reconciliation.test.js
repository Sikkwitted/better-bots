import test from 'node:test';import assert from 'node:assert/strict';import {makeHost,reopenHost} from './helpers.js';
function uncertain(kind){const made=makeHost();const {host}=made;let id;
 if(kind==='run'){const run=host.scheduler.enqueue({agent_id:'a',lane:'background'});host.scheduler.checkpoint(run,'tool_pending');run.status='recovery_required';host.scheduler.save(run);id=run.id;}
 else{id='job';host.memory.retention.doc.update(s=>{s.jobs[id]={id,status:'reconciliation_required',item:{document_id:'doc'},scope:'agent',owner_id:'a',writer_agent_id:'a'};return s;});}
 return {...made,id};
}
for(const kind of ['run','memory'])for(const outcome of ['confirmed_complete','confirmed_not_executed','abandoned','unresolved'])test(`${kind}: durable operator ${outcome}`,async()=>{
 const {host,dir,clock,id}=uncertain(kind);const item=host.reconciliation.list()[0];
 const input={kind,id,expected_revision:item.revision,outcome,evidence:'Checked provider receipt 123',request_id:'decision'};
 host.reconciliation.resolve(input);host.reconciliation.resolve(input);
 const {host:again}=reopenHost({dir,clock});again.reconciliation.recover();again.reconciliation.recover();
 assert.equal(again.audit.where(e=>e.type==='reconciliation.resolved').length,1);
 const {doc,key}=again.reconciliation.store(kind);const record=doc.read()[key][id];assert.equal(record.resolutions.length,1);
 const expected=outcome==='confirmed_complete'?(kind==='run'?'completed':'succeeded'):outcome==='confirmed_not_executed'?(kind==='run'?'queued':'pending'):outcome==='abandoned'?(kind==='run'?'cancelled':'abandoned'):(kind==='run'?'recovery_required':'reconciliation_required');
 assert.equal(record.status,expected);
 if(kind==='run'){let calls=0;again.scheduler.runner=async()=>{calls++};again.scheduler.recover();await again.scheduler.drain();assert.equal(calls,outcome==='confirmed_not_executed'?1:0);}
});
test('stale decisions, missing evidence, and retry of recorded effects are refused',()=>{
 const {host,id}=uncertain('run');const item=host.reconciliation.list()[0];const input={kind:'run',id,expected_revision:item.revision,outcome:'confirmed_not_executed',evidence:'verified',request_id:'one'};
 assert.throws(()=>host.reconciliation.resolve({...input,evidence:''}),/evidence/);assert.throws(()=>host.reconciliation.resolve({...input,expected_revision:'old'}),/changed/);
 const run=host.scheduler.durableRuns()[0];host.scheduler.checkpoint(run,'tool_recorded',{record:{decision:'allowed',result:{ok:true}}});
 assert.throws(()=>host.reconciliation.resolve({...input,expected_revision:host.reconciliation.list()[0].revision}),/recorded actions/);
});
test('decision survives audit failure and recovery repairs its audit once',()=>{
 const {host,dir,clock,id}=uncertain('run');const input={kind:'run',id,expected_revision:host.reconciliation.list()[0].revision,outcome:'abandoned',evidence:'user stopped task',request_id:'once'};
 host.audit.record=()=>{throw Error('audit unavailable')};assert.throws(()=>host.reconciliation.resolve(input));
 const {host:again}=reopenHost({dir,clock});again.reconciliation.recover();again.reconciliation.resolve(input);assert.equal(again.audit.where(e=>e.type==='reconciliation.resolved').length,1);
});

test('operator resolves through the HTTP API and cannot spoof actor or omit evidence',async(t)=>{
 const {createServer}=await import('../src/server.js');const {host,id}=uncertain('run');const server=createServer({host,live:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 const {items}=await (await fetch(base+'/api/reconciliation')).json();
 const response=await fetch(base+'/api/reconciliation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'run',id,expected_revision:items[0].revision,outcome:'abandoned',evidence:'Operator reviewed saved receipts',request_id:'http'})});assert.equal(response.status,200);assert.equal((await response.json()).decision.actor,'user');
 assert.equal((await (await fetch(base+'/api/reconciliation')).json()).items.length,0);
});
test('reviewed non-execution through HTTP dispatches the same run without a second user message',async(t)=>{
 const {createServer}=await import('../src/server.js');const {host,id}=uncertain('run');let drains=0;
 host.drain=async()=>{drains++;};
 const server=createServer({host,live:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 const {items}=await (await fetch(base+'/api/reconciliation')).json();
 const response=await fetch(base+'/api/reconciliation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
  kind:'run',id,expected_revision:items[0].revision,outcome:'confirmed_not_executed',
  evidence:'No output or tool action was recorded for this run',request_id:'reviewed-retry',
 })});
 assert.equal(response.status,200);assert.equal(drains,1);
 assert.equal(host.scheduler.durableRuns().find(run=>run.id===id).status,'queued');
});
test('cancelled automation cannot be revived by a reconciliation retry',()=>{
 const {host,id}=uncertain('run');const run=host.scheduler.durableRuns()[0];run.payload.automation_id='cancelled';host.scheduler.save(run);host.scheduler.cancelAutomation('cancelled');
 assert.throws(()=>host.reconciliation.resolve({kind:'run',id,expected_revision:host.reconciliation.list()[0].revision,outcome:'confirmed_not_executed',evidence:'not sent',request_id:'bad-retry'}),/cancelled automation/);
});
test('run explanation includes operator resolution evidence',()=>{
 const {host,id}=uncertain('run');host.reconciliation.resolve({kind:'run',id,expected_revision:host.reconciliation.list()[0].revision,outcome:'abandoned',evidence:'Reviewed outcome',request_id:'explain'});
 assert.ok(host.explain(id).audit.some(e=>e.type==='reconciliation.resolved'&&e.evidence==='Reviewed outcome'));
});
