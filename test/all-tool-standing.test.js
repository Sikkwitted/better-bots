import test from 'node:test';
import assert from 'node:assert/strict';
import {makeHost, reopenHost, call} from './helpers.js';
import {ACTION_POLICY} from '../src/services/permission-service.js';

test('every external tool category honors saved modes, including new unreviewed tools after restart',()=>{
 const {host,dir}=makeHost();
 for(const mode of ['always','ask','never']) {
  host.permissions.setStandingMode('external',mode);
  const p=reopenHost({dir}).host.permissions;
  for(const [action,policy] of Object.entries(ACTION_POLICY).filter(([,p])=>p.zone==='external')) {
   const decision=p.authorize({agent_id:'a',action,target:'exact target',scope_id:`${mode}-${action}`,tool:'brand_new_tool'});
   assert.equal(decision.decision,{always:'allowed',ask:'ask',never:'blocked'}[mode],action);
  }
 }
});

test('Settings Always releases an already waiting reviewed connected tool exactly once',async()=>{
 const {host}=makeHost({script:()=>[call('NewTool',{})]});
 host.approval_mode='wait';
 host.registry.create({id:'agt_a',profile:{name:'A'}});
 let executions=0;
 host.tools.register({name:'NewTool',description:'test',side_effect:'test',permission:{action:'integration.act',target:()=> 'exact'},input_schema:{type:'object'},handler:()=>{executions++;return {ok:true}}});
 host.permissions.setStandingMode('external','ask');
 host.userRequest({agent_id:'agt_a',text:'test'});
 const draining=host.drain();
 for(let i=0;i<100&&!host.permissions.pendingRequests().length;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(host.permissions.pendingRequests().length,1);
 const request=host.permissions.pendingRequests()[0];
 host.permissions.setStandingMode('external','always');
 await Promise.race([draining,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('wait did not release')),2000);timer.unref()})]);
 assert.equal(executions,1);
 assert.equal(host.permissions.pendingRequests().length,0);
});

test('consequential external actions follow the standing choice like everything else',()=>{
 const {host}=makeHost();
 const actions=['external.pay','external.delete','external.publish','external.send','external.credentials','external.unclassified','web.read_public','integration.read','integration.act','external.browser'];
 // Autonomous by default: nothing asks, not even paying or changing credentials.
 for(const action of actions) {
  assert.equal(ACTION_POLICY[action].per_call,undefined,action);
  assert.equal(host.permissions.authorize({agent_id:'a',action,target:'exact',scope_id:'s'}).decision,'allowed',action);
 }
 // Ask brings the card back, and answering Always returns the zone to working alone.
 host.permissions.setStandingMode('external','ask');
 const first=host.permissions.authorize({agent_id:'a',action:'external.pay',target:'exact',scope_id:'s2'});
 assert.equal(first.decision,'ask');
 assert.equal(host.permissions.resolve(first.request.id,'always').ok,true);
 assert.equal(host.permissions.authorize({agent_id:'a',action:'external.pay',target:'other',scope_id:'s3'}).decision,'allowed');
});
