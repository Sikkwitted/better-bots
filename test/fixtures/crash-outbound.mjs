import {makeHost} from '../helpers.js';
const [dir,boundary,kind]=process.argv.slice(2);const {host}=makeHost({dir});
for(const id of ['agt_a','agt_b'])host.registry.create({id,profile:{name:id}});
const target=kind==='room'?host.createRoom({member_ids:['agt_a','agt_b'],purpose:'test'}).id:'agt_b';
const crash=()=>process.kill(process.pid,'SIGKILL');
const append=host.messages.outbox.append.bind(host.messages.outbox);host.messages.outbox.append=(e)=>{if(boundary==='envelope')crash();const r=append(e);if(boundary==='outbox')crash();return r;};
const transcript=host.transcripts.append.bind(host.transcripts);host.transcripts.append=(...args)=>{const r=transcript(...args);if(boundary==='sender'&&args[2].kind==='peer_message_out')crash();if(boundary==='room'&&args[2].kind==='room_message')crash();return r;};
host.deliverPeerMessage({sender_id:'agt_a',target_id:target,text:'handoff',message_id:'msg_boundary'});
