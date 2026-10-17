import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {makeHost,reopenHost} from './helpers.js';
for(const kind of ['agent','room'])for(const boundary of ['envelope','outbox','sender',...(kind==='room'?['room']:[])])test(`${kind} outbound recovery after SIGKILL at ${boundary}`,async()=>{
 const {dir,clock}=makeHost();const child=spawnSync(process.execPath,['test/fixtures/crash-outbound.mjs',dir,boundary,kind]);assert.equal(child.signal,'SIGKILL');
 const {host}=reopenHost({dir,clock});host.recover();host.recover();await host.drain();
 const envelope=host.messages.get('msg_boundary');
 assert.equal(host.messages.outbox.readAll().filter(e=>e.id===envelope.id).length,1);
 assert.equal(host.transcripts.all('agent','agt_a').filter(e=>e.message_id===envelope.id).length,1);
 assert.equal(host.transcripts.all(kind,envelope.target_id).filter(e=>e.message_id===envelope.id).length,1);
 assert.equal(host.audit.where(e=>e.type==='message.sent'&&e.message_id===envelope.id).length,1);
 const {host:again,adapter}=reopenHost({dir,clock});again.recover();await again.drain();assert.equal(adapter.calls.length,0);
});
test('same-host recovery repairs a partial outbound commit',()=>{
 const {host}=makeHost();for(const id of ['a','b'])host.registry.create({id,profile:{name:id}});
 const append=host.messages.outbox.append.bind(host.messages.outbox);host.messages.outbox.append=()=>{throw Error('disk failure')};
 assert.throws(()=>host.deliverPeerMessage({sender_id:'a',target_id:'b',text:'repair',message_id:'same'}));host.messages.outbox.append=append;
 host.recover();host.recover();assert.equal(host.transcripts.all('agent','a').filter(e=>e.message_id==='same').length,1);
});
