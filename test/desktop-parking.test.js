import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {makeHost,tmpDir,makeGate,say} from './helpers.js';
import {XvfbDesktop} from '../src/services/desktop-backend.js';
function setup() {
 const {host,clock}=makeHost({window_count:3});const parked=[];
 host.computer.backend={supportsParking:true,vncUrl:i=>`vnc://127.0.0.1:${5900+i}`,release:async(i,options)=>parked.push({i,...options}),shutdown:async()=>{}};
 for(const id of ['old','watching','controlled','new','next'])host.registry.create({id,profile:{name:id}});
 for(const id of ['old','watching','controlled'])host.computer.assignWindow(id);
 clock.advance(60000);
 return {host,clock,parked};
}
test('full pool parks only an unused desktop, preserving its profile and fencing old ownership',async()=>{
 const {host,parked}=setup();try {
  const old=host.computer.assignments()[0];
  host.computer.viewers.set('watching',1);host.computer.userControllers.set('controlled',Symbol());
  const result=await host.computer.requestWindow('new');
  assert.equal(result.ok,true);assert.equal(result.assignment.window_index,old.window_index);
  assert.deepEqual(parked,[{i:old.window_index,preserveFor:'old'}]);
  assert.equal(host.computer.verifyOwner('old',old.window_index,old.owner_token),false);
  assert.equal((await host.computer.requestWindow('next')).ok,false,'newly opened and watched desktops are protected');
 }finally{await host.close();}
});
test('queued work is protected and concurrent requests cannot share a reclaimed slot',async()=>{
 const {host,parked}=setup();try {
  host.scheduler.enqueue({agent_id:'watching',lane:'user',payload:{kind:'user_request',text:'queued'}});
  host.computer.userControllers.set('controlled',Symbol());
  const results=await Promise.all([host.computer.requestWindow('new'),host.computer.requestWindow('next')]);
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(parked.length,1);
  assert.ok(host.computer.assignments().some(a=>a.agent_id==='watching'));
 }finally{await host.close();}
});
test('a running bot retains its desktop even when it is the oldest reservation',async()=>{
 const {host}=setup();const entered=makeGate(),finish=makeGate();let running;
 try {
  host.computer.viewers.set('watching',1);host.computer.viewers.set('controlled',1);
  host.adapter.script=()=> (async function*(){entered.release();await finish.promise;yield say('Done');})();
  host.userRequest({agent_id:'old',text:'Keep working'});running=host.scheduler.pump('old');await entered.promise;
  assert.equal((await host.computer.requestWindow('new')).ok,false);
  assert.ok(host.computer.assignments().some(a=>a.agent_id==='old'));
 }finally{finish.release();await running;await host.close();}
});
test('failed parking keeps the slot reserved and retains the preserve instruction for recovery',async()=>{
 const {host}=setup();try {
  host.computer.viewers.set('watching',1);host.computer.viewers.set('controlled',1);
  host.computer.backend.release=async()=>{throw new Error('desktop still closing')};
  await assert.rejects(host.computer.requestWindow('new'),/still closing/);
  assert.equal(host.computer.doc.read().releasing[0].preserve_profile,true);
  assert.equal((await host.computer.requestWindow('next')).ok,false);
 }finally{await host.close();}
});
test('parking and reopening on another monitor preserves profile files without giving them to another bot',async()=>{
 const dir=tmpDir('desktop-profile');
 const backend=new XvfbDesktop({dir,isolation:{kind:'bwrap',executable:'/usr/bin/bwrap'},spawn:()=>{
  const child=new EventEmitter();child.kill=()=>queueMicrotask(()=>child.emit('exit',0,null));return child;
 },execFile:async()=>({stdout:'1280 800'}),sleep:async()=>{},probe:async()=>true});
 try {
  const original=path.join(dir,'computer','monitors','90','home');fs.mkdirSync(original,{recursive:true});fs.writeFileSync(path.join(original,'profile-marker'),'keep this session');
  backend.monitors.set(90,{ready:true,processes:[]});
  await backend.release(90,{preserveFor:'old'});
  assert.equal(fs.existsSync(original),false);
  assert.equal(fs.readFileSync(path.join(backend.savedHome('old'),'profile-marker'),'utf8'),'keep this session');
  await backend.ensureMonitor(91,{agentId:'other'});
  assert.equal(fs.existsSync(path.join(dir,'computer','monitors','91','home','profile-marker')),false);
  await backend.ensureMonitor(92,{agentId:'old'});
  assert.equal(fs.readFileSync(path.join(dir,'computer','monitors','92','home','profile-marker'),'utf8'),'keep this session');
  assert.equal(fs.existsSync(backend.savedHome('old')),false);
 }finally{await backend.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
