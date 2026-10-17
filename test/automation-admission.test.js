import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {makeHost,reopenHost} from './helpers.js';
for(const boundary of ['before_run','after_run','after_schedule']) test(`automation admission survives SIGKILL ${boundary}`,async()=>{
 const {dir,clock}=makeHost();const child=spawnSync(process.execPath,['test/fixtures/crash-admission.mjs',dir,boundary]);assert.equal(child.signal,'SIGKILL');
 const {host}=reopenHost({dir,clock});host.recover();host.tickAutomations();let executions=0;host.scheduler.runner=async()=>{executions++};await host.scheduler.drain();host.tickAutomations();
 assert.equal(executions,1);assert.equal(host.scheduler.durableRuns().length,1);assert.equal(host.listAutomations()[0].fires,1);
 const {host:again}=reopenHost({dir,clock});again.recover();assert.equal(again.tickAutomations().length,0);
});
test('failure after run admission followed by cancellation never executes',async()=>{
 const {host}=makeHost();host.registry.create({id:'agt_a',profile:{name:'A'}});const a=host.scheduleAutomation({agent_id:'agt_a',name:'once',text:'work'});
 const update=host.automations.update.bind(host.automations);host.automations.update=()=>{throw Error('stop')};assert.throws(()=>host.tickAutomations());host.automations.update=update;
 host.cancelAutomation(a.id);let executions=0;host.scheduler.runner=async()=>{executions++};await host.drain();assert.equal(executions,0);assert.equal(host.tickAutomations().length,0);
});
test('completed occurrence before schedule advance is not dispatched again',async()=>{
 const {host}=makeHost();host.registry.create({id:'agt_a',profile:{name:'A'}});host.scheduleAutomation({agent_id:'agt_a',name:'once',text:'work'});
 const update=host.automations.update.bind(host.automations);host.automations.update=()=>{throw Error('stop')};assert.throws(()=>host.tickAutomations());host.automations.update=update;
 let executions=0;host.scheduler.runner=async()=>{executions++};await host.drain();host.tickAutomations();await host.drain();assert.equal(executions,1);assert.equal(host.scheduler.durableRuns().length,1);
});
