import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, reopenHost } from './helpers.js';

test('desk disable survives restart, gates autonomous lanes, and preserves direct user access', async () => {
  const {host,dir,clock}=makeHost();
  const a=host.registry.create({profile:{name:'Builder',desk:'App'}});
  host.updateDesk({name:'App',hidden:true});
  assert.equal(host.deskEnabled(a.id),true,'visibility is not execution');
  const queued=host.scheduler.enqueue({agent_id:a.id,lane:'agent',payload:{kind:'agent_wake'}});
  host.updateDesk({name:'App',enabled:false});
  assert.equal(host.scheduler.durableRuns().find(r=>r.id===queued.id).status,'cancelled');
  const restored=reopenHost({dir,clock}).host;
  assert.equal(restored.listDesks()[0].hidden,true);
  assert.equal(restored.deskEnabled(a.id),false);
  restored.scheduler.enqueue({agent_id:a.id,lane:'background',payload:{kind:'test'}});
  const user=restored.userRequest({agent_id:a.id,text:'test'});
  await restored.scheduler.drain();
  assert.equal(restored.scheduler.durableRuns().find(r=>r.id===user.id).status,'completed');
  assert.equal(restored.scheduler.pendingRuns(a.id).length,1);
});

test('disabled desk retains routine; routine pause cancels old generation and enable gets fresh ID', () => {
  const {host,clock}=makeHost();const a=host.registry.create({profile:{name:'Scout',desk:'Research'}});
  const job=host.scheduleAutomation({agent_id:a.id,name:'Scan',text:'test',every_ms:60000});
  host.updateDesk({name:'Research',enabled:false});
  assert.equal(host.tickAutomations().length,0);
  assert.equal(host.listAutomations().length,1);
  host.setAutomationEnabled(job.id,false);
  assert.equal(host.listAutomations()[0].enabled,false);
  const resumed=host.setAutomationEnabled(job.id,true);
  assert.notEqual(resumed.id,job.id);
  assert.equal(host.scheduler.isAutomationCancelled(job.id),true);
  host.updateDesk({name:'Research',enabled:true});
  clock.advance(60001);
  assert.equal(host.tickAutomations().length,1);
});

test('disabling a desk aborts active autonomous work and keeps completed evidence', async () => {
  const {host}=makeHost();const a=host.registry.create({profile:{name:'Worker',desk:'App'}});
  let started;const ready=new Promise(r=>{started=r;});
  host.scheduler.runner=async(run,signal)=>{started();await new Promise(resolve=>signal.native.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted();};
  const run=host.scheduler.enqueue({agent_id:a.id,lane:'background',payload:{kind:'test'}});
  const pumping=host.scheduler.pump(a.id);await ready;
  host.updateDesk({name:'App',enabled:false});await pumping;
  const saved=host.scheduler.durableRuns().find(r=>r.id===run.id);
  assert.equal(saved.interrupt_reason,'user_cancelled');
  assert.notEqual(saved.status,'completed');
  host.updateDesk({name:'App',enabled:true});
  assert.equal(host.scheduler.pendingRuns(a.id).length,0);
});


test('handoff to a paused desk is saved with an explicit dispatch blocker', async () => {
  const {host}=makeHost();
  host.registry.create({id:'agt_sender',profile:{name:'Sender',desk:'Active'}});
  host.registry.create({id:'agt_paused',profile:{name:'Paused',desk:'Paused'}});
  host.updateDesk({name:'Paused',enabled:false});
  const ack=host.deliverPeerMessage({sender_id:'agt_sender',target_id:'agt_paused',text:'Do the next step'});
  assert.equal(ack.dispatch_status,'paused');
  assert.equal(ack.blocked_reason,'desk_disabled');
  assert.match(ack.message,/will not run/);
  await host.drain();
  assert.equal(host.messages.get(ack.message_id).status,'queued');
  assert.equal(host.status().agents.find(a=>a.id==='agt_paused').queued[0].blocked_reason,'desk_disabled');
  await host.close();
});
