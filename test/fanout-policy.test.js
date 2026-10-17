import test from 'node:test';import assert from 'node:assert/strict';import {makeHost,reopenHost,call} from './helpers.js';
function setup(script){const made=makeHost({script});for(const id of ['a','b','c'])made.host.registry.create({id,profile:{name:id}});return made;}
test('sequential tool calls cannot fan out without approval',async()=>{
 const {host}=setup(ctx=>ctx.agent_id==='a'?[call('SendToAgent',{target_id:'b',message:'one'}),call('SendToAgent',{target_id:'c',message:'two'})]:[]);
 host.userRequest({agent_id:'a',text:'one task'});await host.drain();
 assert.deepEqual(host.messages.allEnvelopes().map(e=>e.target_id),['b']);
 assert.ok(Object.values(host.permissions.doc.read().requests).some(r=>r.action==='coordination.fanout'));
});
test('explicit user recipient set permits intended team and persists through restart',async()=>{
 const {host,dir,clock}=setup(ctx=>ctx.agent_id==='a'?[call('SendToAgent',{target_id:'b',message:'one'}),call('SendToAgent',{target_id:'c',message:'two'})]:[]);
 const run=host.userRequest({agent_id:'a',text:'team',authorized_recipients:['b','c']});await host.drain();assert.equal(host.messages.allEnvelopes().length,2);
 const {host:again}=reopenHost({dir,clock});assert.equal(again.coordination.requiresApproval({id:'next',agent_id:'b',payload:{coordination_id:run.id}},'c'),false);
});
test('handoffs cannot launder a task recipient set',async()=>{
 const {host}=setup(ctx=>ctx.agent_id==='a'?[call('SendToAgent',{target_id:'b',message:'one'})]:ctx.agent_id==='b'?[call('SendToAgent',{target_id:'c',message:'two'})]:[]);
 host.userRequest({agent_id:'a',text:'task'});await host.drain();assert.deepEqual(host.messages.allEnvelopes().map(e=>e.target_id),['b']);
});
test('reply and retries are allowed; additional recipient and room require approval',()=>{
 const {host,dir,clock}=setup();const run={id:'task',agent_id:'a',payload:{}};host.coordination.ensure(run);host.coordination.commit(run,'b');
 assert.equal(host.coordination.requiresApproval(run,'b'),false);assert.equal(host.coordination.requiresApproval({...run,agent_id:'b'},'a'),false);
 assert.throws(()=>host.coordination.commit(run,'c'),/approval/);
 const room=host.createRoom({member_ids:['a','b','c'],purpose:'decision'});assert.equal(host.coordination.requiresApproval(run,room.id),true);
 host.coordination.commit(run,room.id,true);const {host:again}=reopenHost({dir,clock});assert.equal(again.coordination.requiresApproval(run,'c'),false);
});
test('exact approval adds one recipient while a continuation cannot add another silently',async()=>{
 const {host}=setup(ctx=>ctx.agent_id==='a'?[call('SendToAgent',{target_id:'b',message:'one'}),call('SendToAgent',{target_id:'c',message:'two'})]:[]);
 host.approval_mode='wait';const authorize=host.permissions.authorize.bind(host.permissions);
 host.permissions.authorize=args=>{const r=authorize(args);if(r.decision==='ask')host.permissions.resolve(r.request.id,'allow_once');return r;};
 const run=host.userRequest({agent_id:'a',text:'task'});await host.drain();assert.equal(host.messages.allEnvelopes().length,2);
 host.registry.create({id:'d',profile:{name:'D'}});assert.equal(host.coordination.requiresApproval({id:'continue',agent_id:'a',payload:{coordination_id:run.id}},'d'),true);
 assert.equal(host.audit.where(e=>e.type==='permission.allowed'&&e.action==='coordination.fanout').length,1);
});
