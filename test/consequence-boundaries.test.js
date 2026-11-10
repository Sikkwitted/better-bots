import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {makeHost,call} from './helpers.js';
import {shellTool,detectIsolation,bwrapArgs} from '../src/tools/shell-tool.js';
import fs from 'node:fs';import path from 'node:path';
test('real confined shell cannot connect to localhost',async(t)=>{
 const isolation=detectIsolation();if(!['seatbelt','bwrap'].includes(isolation.kind))return t.skip('requires OS isolation');
 const {dir}=makeHost();const server=http.createServer((req,res)=>res.end('bypass'));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const tool=shellTool({workspace:path.join(dir,'workspace'),isolation});
 const result=await tool.handler({agent:{id:'agt_a'},input:{command:`curl --max-time 2 -s http://127.0.0.1:${server.address().port}`}});
 assert.notEqual(result.exit_code,0);assert.doesNotMatch(result.stdout??' ',/bypass/);
});
test('Linux shell always creates a separate network namespace',()=>{
 const {dir}=makeHost();const own=path.join(dir,'agents/agt_a');fs.mkdirSync(own,{recursive:true});assert.ok(bwrapArgs({workspace:dir,agentId:'agt_a',cwd:own,env:{}}).includes('--unshare-net'));
});
for(const action of ['click','type','key','open_url','move'])test(`screen ${action} runs by default and asks when external is set to Ask`,async()=>{
 const run=async(mode)=>{
  const {host}=makeHost({script:()=>[call('UseScreen',{window_index:0,owner_token:'token',action,detail:{text:'send',url:'https://example.com'}})]});
  host.registry.create({id:'agt_a',profile:{name:'A'}});if(mode)host.permissions.setStandingMode('external',mode);
  let performed=0;host.computer.performWindowAction=async()=>{performed++;return{ok:true}};
  host.userRequest({agent_id:'agt_a',text:'test'});await host.drain();
  return {performed,asked:host.audit.where(e=>e.type==='permission.asked'&&e.action==='external.browser').length};
 };
 assert.deepEqual(await run(null),{performed:1,asked:0});
 assert.deepEqual(await run('always'),{performed:1,asked:0});
 // Ask is the person's choice to review every click.
 assert.deepEqual(await run('ask'),{performed:0,asked:1});
});
test('unclassified calls enforce exact approvals, denials, expiry and ceilings',()=>{
 const {host,clock}=makeHost();const p=host.permissions;
 const args={agent_id:'a',action:'external.unclassified',target:'click publish',scope_id:'run',run_id:'run',call_id:'call',input_hash:'one'};
 p.setStandingMode('external','ask');let r=p.authorize(args).request;p.resolve(r.id,'allow_once');
 assert.equal(p.authorize({...args,input_hash:'different'}).decision,'ask');assert.equal(p.authorize(args).decision,'allowed');assert.equal(p.authorize(args).decision,'ask');
 r=p.authorize({...args,target:'delete'}).request;p.resolve(r.id,'deny');assert.equal(p.authorize({...args,target:'delete'}).basis,'denied_earlier');
 r=p.authorize({...args,target:'send'}).request;clock.advance(600001);assert.equal(p.resolve(r.id,'allow_once').ok,false);
 p.setCeiling('external','never');assert.equal(p.authorize(args).decision,'blocked');
});
