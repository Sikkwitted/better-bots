import test from 'node:test';
import assert from 'node:assert/strict';
import {presentChatEntries, groupChatActivity, hasVisibleWork, withApprovalStatus, roomProgress} from '../web/chat-presentation.js';
import {chatTurnIds} from '../src/core/chat-turns.js';
test('an exact pending approval overrides a misleading streaming phase without mutating the run', () => {
 const run = {id:'current',phase:'typing'};
 const approvals = [{id:'approval',run_id:'current'}];
 assert.deepEqual(withApprovalStatus(run,approvals),{id:'current',phase:'approval',approval_request_id:'approval'});
 assert.equal(run.phase,'typing');
 assert.equal(withApprovalStatus({id:'other',phase:'thinking'},approvals).phase,'thinking');
 assert.equal(withApprovalStatus(run,[]).phase,'typing');
 assert.equal(withApprovalStatus(null,approvals),null);
});
test('room status identifies a member blocked behind another turn or its exact approval', () => {
 const room={id:'room',epoch:2,discussion:{status:'active',rounds:{0:['a','b']},turns:{}}};
 const agents=[{id:'a',name:'Editor',active_run:{id:'run',payload:{kind:'agent_wake'}}}];
 assert.match(roomProgress(room,agents).text,/Editor to finish another turn/);
 assert.equal(roomProgress(room,agents,[{id:'permission',run_id:'run'}]).approval_request_id,'permission');
 assert.equal(roomProgress(room,agents,[{id:'other',run_id:'unrelated'}]).approval_request_id,undefined);
 agents[0].active_run.payload={room_id:'room',epoch:2};
 assert.equal(roomProgress(room,agents).text,'Editor is responding to the room.');
 room.discussion.status='completed';assert.equal(roomProgress(room,agents),null);
});
test('tool narration is compact while the final answer remains a reply',()=>{
 const entries=[{kind:'user_message',text:'go'},{kind:'agent_text',run_id:'a',text:'Looking'},{kind:'tool_call',run_id:'a'},{kind:'agent_text',run_id:'a',text:'Opening'},{kind:'tool_call',run_id:'a'},{kind:'agent_text',run_id:'a',text:'Done'}];
 assert.deepEqual(presentChatEntries(entries).map(e=>e.kind),['user_message','agent_progress','tool_call','agent_progress','tool_call','agent_text']);
 assert.equal(entries[1].kind,'agent_text','does not rewrite history');
 assert.equal(presentChatEntries(entries,{id:'a'}).at(-1).kind,'agent_progress');
});

test('continuation runs share one inspector without merging unrelated requests',()=>{
 const runs=[{id:'a',agent_id:'bot',payload:{kind:'user_request'}},{id:'b',agent_id:'bot',payload:{kind:'continue',parent_run_id:'a'}},{id:'c',agent_id:'bot',payload:{kind:'continue',parent_run_id:'b'}},{id:'d',agent_id:'bot',payload:{kind:'user_request',parent_run_id:'a'}}];
 const turns=chatTurnIds(runs);
 assert.deepEqual([...turns.values()],['a','a','a','d']);
 const entries=[{kind:'reasoning',run_id:'a'},{kind:'agent_text',run_id:'a',text:'Continuing'},{kind:'system_note',run_id:'a',text:'Step budget paused'},{kind:'tool_call',run_id:'b'},{kind:'tool_result'},{kind:'reasoning',run_id:'c'},{kind:'agent_text',run_id:'c',text:'Done'},{kind:'user_message',text:'Another request'}].map(e=>({...e,turn_id:turns.get(e.run_id)}));
 const groups=groupChatActivity(presentChatEntries(entries));
 assert.equal(groups[0].entries.length,6);
 assert.equal(groups[1].entries[0].text,'Done');
 assert.equal(groups[2].entries[0].kind,'user_message');
 assert.equal(groupChatActivity(presentChatEntries(entries.slice(0,-1),{id:'c',turn_id:'a'})).length,1);
});

test('final provider blocks are one reply, with failures and different results preserved',()=>{
 const entries=[{kind:'agent_text',run_id:'a',text:'First'},{kind:'agent_text',run_id:'a',text:'Second'},{kind:'run_failed',run_id:'a',error:'failed'},{kind:'agent_text',run_id:'b',text:'Other'},{kind:'agent_text',run_id:'b',result_id:'published',text:'Result'}];
 const presented=presentChatEntries(entries);
 assert.equal(presented.length,4);
 assert.equal(presented[0].text,'First\n\nSecond');
 assert.equal(presented[1].kind,'run_failed');
 assert.equal(entries[0].text,'First');
});
test('other runs and published results retain their answers',()=>{
 const entries=[{kind:'agent_text',run_id:'a',text:'Done'},{kind:'agent_text',run_id:'b',text:'Published',result_id:'result'},{kind:'tool_call',run_id:'b'},{kind:'reasoning',run_id:'b',text:'Thinking'}];
 assert.deepEqual(presentChatEntries(entries,{id:'b'}).map(e=>e.kind),entries.map(e=>e.kind));
});

test('one activity group contains all tool steps, with live reasoning and final replies outside',()=>{
 const entries=[{kind:'agent_progress',run_id:'a'},{kind:'tool_call',run_id:'a'},{kind:'tool_result'},{kind:'reasoning',run_id:'a'},{kind:'agent_progress',run_id:'a'},{kind:'tool_call',run_id:'a'},{kind:'reasoning',run_id:'a',live:true},{kind:'agent_text',run_id:'a'},{kind:'tool_call',run_id:'b'}];
 const groups=groupChatActivity(entries);
 assert.equal(groups[0].entries.length,7);
 assert.deepEqual(groups.map(g=>g.work),[true,false,true]);
 assert.equal(groups[2].run,'b');
});

test('a finished turn with only empty reasoning shows nothing', () => {
  assert.equal(hasVisibleWork([{kind:'reasoning', text:''}, {kind:'agent_progress', text:'step'}]), false);
  assert.equal(hasVisibleWork([{kind:'reasoning', text:'  \n'}]), false);
  assert.equal(hasVisibleWork([{kind:'reasoning', text:'weighing options'}]), true);
  assert.equal(hasVisibleWork([{kind:'reasoning', text:''}, {kind:'tool_call', name:'Read'}]), true);
});

test('room participation is one line per room in a bot\'s chat, never a reasoning fold', () => {
  const notes = [0, 1, 2].map(round => ({kind:'system_note', run_id:`run_${round}`, room_id:'room_a', text:`Spoke in room room_a (round ${round}).`}));
  const shown = presentChatEntries([{kind:'user_message', text:'hi'}, ...notes, {kind:'system_note', run_id:'run_9', room_id:'room_b', text:'x'}]);
  assert.deepEqual(shown.filter(e => e.kind === 'system_note').map(e => e.room_id), ['room_a', 'room_b']);
  assert.equal(groupChatActivity(shown).some(g => g.work), false);
});
