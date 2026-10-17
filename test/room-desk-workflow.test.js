import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, say } from './helpers.js';

// A desk's orchestrator hands work to a verifier sitting alone in a room. These
// tests pin both halves of that loop: the verdict comes back to the bot that
// asked, and a room-only room keeps its discussion out of its members' desk memory.

const VERDICT = 'FAIL: the total does not match the sources.';

function desk({ memory = 'none', verdict = VERDICT } = {}) {
  const woken = [];
  const made = makeHost({
    script: (ctx) => {
      if (ctx.payload?.kind === 'agent_wake') { woken.push(...ctx.payload.messages); return [say('Noted.')]; }
      return [say(ctx.agent_id === 'verifier' ? verdict : '(pass)')];
    },
  });
  made.host.registry.create({ id: 'tor', profile: { name: 'Tor' } });
  made.host.registry.create({ id: 'verifier', profile: { name: 'Vera' } });
  const room = made.host.createRoom({ member_ids: ['verifier'], purpose: 'Verify the report', memory });
  const ask = (text, sender_id = 'tor') => made.host.deliverPeerMessage({ sender_id, target_id: room.id, text });
  return { ...made, room, woken, ask };
}

test("a room's answer reaches the bot that posted the request, on a later wake", async () => {
  const { host, room, woken, ask } = desk();
  ask('Check the consolidated report against the check: totals match sources.');
  await host.startRoomDiscussion(room.id);
  await host.drain();

  assert.equal(woken.length, 1, 'the asker is woken once with the room outcome');
  assert.equal(woken[0].sender_id, room.id);
  assert.match(woken[0].text, /Verify the report/);
  assert.match(woken[0].text, /Vera: FAIL: the total does not match the sources\./);
  const replies = host.messages.allEnvelopes().filter((m) => m.sender_id === room.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].target_id, 'tor');
  assert.ok(!host.transcripts.all('agent', 'verifier').some((e) => e.kind === 'peer_message_out'), 'nothing is written to the verifier desk chat');
});

test('a room that finishes without a reply still tells the asker, and a repeat completion delivers once', async () => {
  const { host, room, woken, ask } = desk({ verdict: '(pass)' });
  ask('Anything to add?');
  await host.startRoomDiscussion(room.id);
  await host.drain();
  assert.equal(woken.length, 1);
  assert.match(woken[0].text, /no member had anything to add/i);

  // Resume after a crash replays the completion hook; the reply is not sent twice.
  const current = host.rooms.get(room.id);
  host.rooms.onBeforeComplete(room.id, { epoch: current.epoch, stop_reason: 'no_new_messages', total_messages: 0, transcript: host.rooms.history(room.id) });
  await host.drain();
  assert.equal(host.messages.allEnvelopes().filter((m) => m.sender_id === room.id).length, 1);
  assert.equal(woken.length, 1);
});

test('a member who posts to its own room is not sent the outcome at its desk', async () => {
  const { host, room, woken, ask } = desk({ memory: 'room' });
  ask('Review your last call.', 'verifier');
  await host.startRoomDiscussion(room.id);
  await host.drain();
  assert.equal(woken.length, 0);
  assert.equal(host.messages.allEnvelopes().filter((m) => m.sender_id === room.id).length, 0);
});

test("a room-only room keeps its history for the room and out of every member's desk memory", async () => {
  const { host, room, adapter, ask } = desk({ memory: 'room' });
  const retained = [];
  const retainExchange = host.memory.retainExchange.bind(host.memory);
  host.memory.retainExchange = (intent) => { retained.push(intent); return retainExchange(intent); };

  ask('First report: totals match sources?');
  await host.startRoomDiscussion(room.id);
  await host.drain();
  ask('Second report: totals match sources?');
  await host.startRoomDiscussion(room.id);
  await host.drain();
  await host.memory.flush();

  assert.deepEqual(retained.filter((r) => r.ref?.room_id === room.id), [], 'nothing from the room is saved to any memory');
  const hits = await host.memory.search({ agent_id: 'verifier', scope: 'agent', owner_id: 'verifier', query: 'total sources' });
  assert.equal(hits.length, 0, "the verifier's desk self recalls nothing from the room");

  const secondTurn = adapter.calls.filter((c) => c.agent_id === 'verifier' && c.payload?.kind === 'room_turn').at(-1);
  assert.match(JSON.stringify(secondTurn.messages), /First report/, 'the room still remembers its own earlier request');
  assert.equal(host.rooms.get(room.id).memory, 'room');
});

test('members-only rooms still save the outcome to each member, so the room-only check above can see a leak', async () => {
  const { host, room, ask } = desk({ memory: 'members' });
  const retained = [];
  const retainExchange = host.memory.retainExchange.bind(host.memory);
  host.memory.retainExchange = (intent) => { retained.push(intent); return retainExchange(intent); };
  ask('Totals match sources?');
  await host.startRoomDiscussion(room.id);
  await host.drain();
  assert.deepEqual(retained.filter((r) => r.ref?.room_id === room.id).map((r) => [r.scope, r.owner_id]), [['agent', 'verifier']]);
  await host.memory.flush();
  const hits = await host.memory.search({ agent_id: 'verifier', scope: 'agent', owner_id: 'verifier', query: 'total sources' });
  assert.equal(hits.length, 1, "the verifier's desk self recalls a members-only meeting");
});
