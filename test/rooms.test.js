import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, say } from './helpers.js';
import { rotateStart, ROOM_LIMITS } from '../src/services/room-orchestrator.js';

// A group stops at every configured bound.

function members(host, n) {
  return Array.from({ length: n }, (_, i) =>
    host.registry.create({ id: `agt_m${i}`, profile: { name: `M${i}` } }).id);
}

test('maximum members is enforced', () => {
  const { host } = makeHost({ script: () => [say('hi')] });
  const ids = members(host, ROOM_LIMITS.MAX_MEMBERS + 1);
  assert.throws(() => host.createRoom({ member_ids: ids, purpose: 'too big' }), /room holds at most 12/);
  assert.doesNotThrow(() => host.createRoom({ member_ids: ids.slice(0, 6), purpose: 'ok' }));
});

test('a no-message round ends the meeting', async () => {
  const { host } = makeHost({ script: () => [say('(pass)')] });
  const ids = members(host, 3);
  const room = host.createRoom({ member_ids: ids, purpose: 'nothing to add' });
  const result = await host.runRoom(room.id, { request: 'anything?' });

  assert.equal(result.stop_reason, 'no_new_messages');
  assert.equal(result.total_messages, 0);
  assert.equal(result.rounds.length, 1, 'it stopped after the first silent round');
});

test('rounds are capped even when members keep talking', async () => {
  const { host } = makeHost({ script: () => [say('a point')] });
  const ids = members(host, 2);
  const room = host.createRoom({ member_ids: ids, purpose: 'bounded chat' });
  const result = await host.runRoom(room.id, { request: 'discuss' });

  assert.equal(result.stop_reason, 'rounds_complete');
  assert.equal(result.rounds.length, ROOM_LIMITS.MAX_ROUNDS);
  assert.equal(result.total_messages, 6); // 2 members x 1 message x 3 rounds
});

test('a one-member room (the fresh-context verifier) runs exactly one round per request', async () => {
  const { host } = makeHost({ script: () => [say('Verdict: holds up.')] });
  const ids = members(host, 1);
  const room = host.createRoom({ member_ids: ids, purpose: 'verify' });
  const result = await host.runRoom(room.id, { request: 'check this' });

  assert.equal(result.stop_reason, 'rounds_complete');
  assert.equal(result.rounds.length, 1);
  assert.equal(result.total_messages, 1);
  assert.equal(host.adapter.calls.length, 1, 'one model call when it answers');
  await host.runRoom(room.id, { request: 'and this' });
  assert.equal(host.adapter.calls.length, 2, 'each new request gets one more');
});

test('per-member-turn cap trims an over-eager member', async () => {
  const { host } = makeHost({ script: () => [say('one'), say('two'), say('three'), say('four')] });
  const ids = members(host, 1);
  const room = host.createRoom({ member_ids: ids, purpose: 'verbose' });
  const result = await host.runRoom(room.id, { request: 'go' });

  for (const round of result.rounds) {
    for (const turn of round.turns) {
      assert.equal(turn.posted, ROOM_LIMITS.MAX_PER_MEMBER_TURN);
    }
  }
});

test('the starting speaker rotates by round', () => {
  assert.deepEqual(rotateStart(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(rotateStart(['a', 'b', 'c'], 1), ['b', 'c', 'a']);
  assert.deepEqual(rotateStart(['a', 'b', 'c'], 2), ['c', 'a', 'b']);
  assert.deepEqual(rotateStart([], 1), []);
});

test('mentions narrow the responders', async () => {
  const { host } = makeHost({ script: () => [say('my view')] });
  const ids = members(host, 3);
  const room = host.createRoom({ member_ids: ids, purpose: 'targeted' });
  const result = await host.runRoom(room.id, { request: '@M1 only you please' });

  assert.deepEqual(result.rounds[0].speakers, ['agt_m1']);
  assert.ok(host.audit.where((e) => e.type === 'room.mentions_resolved').length > 0);
});

test('a superseded request stops the room', async () => {
  const { host } = makeHost({ script: () => [say('still talking')] });
  const ids = members(host, 2);
  const room = host.createRoom({ member_ids: ids, purpose: 'will be superseded' });

  let turns = 0;
  const result = await host.runRoom(room.id, {
    request: 'discuss',
    isSuperseded: () => { turns += 1; return turns > 2; },
  });
  assert.equal(result.stop_reason, 'superseded');
});

test('a stale epoch cancels outdated room work', async () => {
  let host;
  const script = (ctx) => {
    if (ctx.payload?.kind === 'room_turn' && ctx.payload.round === 0 && ctx.agent_id === 'agt_m0') {
      host.rooms.supersede(ctx.payload.room_id, 'the request changed');
    }
    return [say('a point')];
  };
  const made = makeHost({ script });
  host = made.host;

  const ids = members(host, 2);
  const room = host.createRoom({ member_ids: ids, purpose: 'epoch test' });
  const result = await host.runRoom(room.id, { request: 'discuss' });

  assert.equal(result.stop_reason, 'stale_epoch');
  assert.ok(host.audit.where((e) => e.type === 'room.superseded').length === 1);
});

test('room history supplied to members is hard-limited', async () => {
  const { host } = makeHost({ script: () => [say('a'), say('b')] });
  const ids = members(host, 3);
  const room = host.createRoom({ member_ids: ids, purpose: 'history bound' });
  for (let i = 0; i < 40; i += 1) {
    host.transcripts.append('room', room.id, { kind: 'room_message', sender_id: ids[0], text: `filler ${i}` });
  }
  assert.equal(host.rooms.history(room.id).length, ROOM_LIMITS.HISTORY_MESSAGES);
});

test('the room transcript is separate from every member transcript', async () => {
  const { host } = makeHost({ script: () => [say('room-only content')] });
  const ids = members(host, 2);
  const room = host.createRoom({ member_ids: ids, purpose: 'separation' });
  await host.runRoom(room.id, { request: 'go' });

  const roomText = host.transcripts.all('room', room.id).map((e) => e.text).join(' ');
  assert.match(roomText, /room-only content/);
  const memberText = host.transcripts.all('agent', ids[0]).map((e) => e.text).join(' ');
  assert.ok(!memberText.includes('room-only content'), 'room posts do not land in a private transcript');
  assert.match(memberText, /Spoke in room/);
});

test('a group can be deleted, explicitly, and its members are untouched', () => {
  const { host } = makeHost();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const b = host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  const room = host.createRoom({ member_ids: [a.id, b.id], purpose: 'scratch' });
  assert.throws(() => host.rooms.delete(room.id), /confirm/);
  const removed = host.rooms.delete(room.id, { confirm: true, actor: 'user' });
  assert.equal(removed.id, room.id);
  assert.equal(host.rooms.list().length, 0);
  assert.equal(host.registry.list().length, 2, 'the members are still here');
  assert.ok(host.audit.where((e) => e.type === 'room.deleted' && e.room_id === room.id).length === 1);
  assert.throws(() => host.rooms.delete(room.id, { confirm: true }), /room_not_found|unknown room/);
});

test('groups can be renamed and pinned; pinned groups list first', () => {
  const { host } = makeHost();
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  const one = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'one' });
  const two = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'two' });
  host.rooms.update(two.id, { pinned_at: host.clock.iso() });
  host.rooms.update(one.id, { purpose: 'first, renamed' });
  const rooms = host.status().rooms;
  assert.deepEqual(rooms.map((r) => r.purpose), ['two', 'first, renamed']);
  assert.equal(rooms[0].pinned, true);
  assert.equal(rooms[1].pinned, false);
  host.rooms.update(two.id, { pinned_at: null });
  assert.equal(host.status().rooms[0].purpose, 'first, renamed');
  assert.throws(() => host.rooms.update(one.id, { purpose: '  ' }), /invalid_name|needs a name/);
});
