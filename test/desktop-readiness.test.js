import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {XvfbDesktop,probeVnc} from '../src/services/desktop-backend.js';
import {tmpDir,makeGate} from './helpers.js';
function backend(dir,probe) {
 return new XvfbDesktop({dir,isolation:{kind:'bwrap',bwrap:'/test/bwrap'},probe,execFile:async()=>({stdout:'1280 800'}),sleep:async()=>{},spawn:()=>{
  const c=new EventEmitter();c.kill=()=>queueMicrotask(()=>c.emit('exit',0,null));return c;
 }});
}
test('desktop is not ready until the viewing service has answered',async()=>{
 const dir=tmpDir();const entered=makeGate(),answer=makeGate();let completed=false;
 const desktop=backend(dir,async()=>{entered.release();await answer.promise;return true;});
 try {
  const pending=desktop.ensureMonitor(93,{agentId:'agent'}).then(r=>{completed=true;return r;});await entered.promise;
  assert.equal(completed,false);assert.equal(desktop.monitors.get(93).ready,false);
  answer.release();assert.equal((await pending).real,true);assert.equal(desktop.monitors.get(93).ready,true);
 }finally{answer.release();await desktop.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
test('failed viewing startup retains a restored browser profile for another attempt',async()=>{
 const dir=tmpDir();const desktop=backend(dir,async()=>false);
 try {
  const saved=desktop.savedHome('agent');fs.mkdirSync(saved,{recursive:true});fs.writeFileSync(path.join(saved,'marker'),'profile');
  await assert.rejects(desktop.ensureMonitor(94,{agentId:'agent'}),/viewing service did not start/);
  assert.equal(fs.readFileSync(path.join(saved,'marker'),'utf8'),'profile');assert.equal(desktop.monitors.has(94),false);
 }finally{await desktop.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
test('VNC readiness probe waits for the real protocol greeting, not merely an open port',async()=>{
 let peer;const accepted=makeGate();const server=net.createServer(c=>{peer=c;accepted.release();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  let completed=false;const pending=probeVnc(server.address().port).then(r=>{completed=true;return r;});await accepted.promise;
  assert.equal(completed,false);peer.write('RFB 003.008\n');assert.equal(await pending,true);
 }finally{peer?.destroy();await new Promise(r=>server.close(r));}
});
