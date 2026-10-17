import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, reopenHost, say, makeGate } from './helpers.js';

// The sender is also woken later with the room's outcome; `seen` counts room turns only.
function setup(script = () => [say('(pass)')]) {
  const made = makeHost({ script });
  made.host.registry.create({ id: 'sender' });
  made.host.registry.create({ id: 'member' });
  const room = made.host.createRoom({ member_ids: ['member'], purpose: 'Editorial review', memory: 'none' });
  return { ...made, room, send: (text, extra = {}) => made.host.deliverPeerMessage({ sender_id: 'sender', target_id: room.id, text, wake_room: true, ...extra }) };
}

test('a user-dispatched peer room message wakes a bounded discussion exactly once', async () => {
  const seen = [];
  const { host, room, send } = setup(ctx => { if (ctx.payload.kind === 'room_turn') seen.push(ctx.payload.request); return [say('(pass)')]; });
  const ack = send('Review the outline.', { message_id: 'outline' });
  assert.equal(ack.dispatch_status, 'queued');
  await host.drain();
  assert.deepEqual(seen, ['Review the outline.']);
  assert.equal(host.messages.get(ack.message_id).status, 'delivered');
  assert.equal(host.rooms.get(room.id).discussion.peer_message_id, ack.message_id);
  assert.equal(send('Review the outline.', { message_id: 'outline' }).duplicate, true);
  await host.drain();
  assert.equal(seen.length, 1);
});

test('agent room posts stay passive until the user starts the discussion', async () => {
  const seen = [];
  const { host, room, send } = setup(ctx => { if (ctx.payload.kind === 'room_turn') seen.push(ctx.payload.request); return [say('(pass)')]; });
  const ack = send('Review this outline', { wake_room: false });
  assert.equal(ack.dispatch_status, 'posted');
  await host.drain(); assert.deepEqual(seen, []);
  await host.startRoomDiscussion(room.id);
  assert.deepEqual(seen, ['Review this outline']);
  assert.equal((await host.startRoomDiscussion(room.id)).already_started, true);
  assert.equal(seen.length, 1);
});

test('starting a room does not wait for an unrelated active agent', async () => {
  const held = makeGate(), entered = makeGate(), memberStarted = makeGate();
  const { host, room, send } = setup(ctx => (async function* () {
    if (ctx.agent_id === 'unrelated') { entered.release(); await held.promise; }
    else memberStarted.release();
    yield say('(pass)');
  })());
  host.registry.create({ id: 'unrelated' });
  host.userRequest({ agent_id: 'unrelated', text: 'Wait here' });
  const draining = host.drain();
  let discussion, timer;
  try {
    await entered.promise;
    send('Review independently', { wake_room: false });
    discussion = host.startRoomDiscussion(room.id);
    await Promise.race([memberStarted.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Room waited for an unrelated agent')), 5000);
    })]);
    assert.ok(host.scheduler.activeRun('unrelated'));
    assert.equal(host.rooms.get(room.id).discussion.request, 'Review independently');
  } finally {
    clearTimeout(timer); held.release();
    await Promise.all([draining, discussion]);
    await host.close();
  }
});

test('an isolated room receives only the explicitly selected peer post and current discussion', async () => {
  const { host, room, adapter, send } = setup();
  host.transcripts.append('room', room.id, { kind: 'room_message', sender_id: 'sender', text: 'Previous private judgment' });
  const ack = send('Current outline', { wake_room: false });
  await host.startRoomDiscussion(room.id);
  const current = host.rooms.get(room.id);
  const context = host.rooms.contextHistory(current, current.epoch);
  assert.ok(context.some(entry => entry.message_id === ack.message_id));
  assert.ok(!context.some(entry => entry.text === 'Previous private judgment'));
  assert.ok(adapter.calls.length > 0);
});

test('multiple peer room messages are processed in order without superseding each other', async () => {
  const seen = [];
  const { host, send } = setup(ctx => { if (ctx.payload.kind === 'room_turn') seen.push(ctx.payload.request); return [say('(pass)')]; });
  send('First outline'); send('Second outline');
  await host.drain();
  assert.deepEqual(seen, ['First outline', 'Second outline']);
});

test('a queued peer room wake survives restart', async () => {
  const { host, dir, send } = setup();
  send('Saved outline');
  await host.close();
  const seen = [];
  const { host: again } = reopenHost({ dir, script: ctx => { if (ctx.payload.kind === 'room_turn') seen.push(ctx.payload.request); return [say('(pass)')]; } });
  again.recover(); await again.drain();
  assert.deepEqual(seen, ['Saved outline']);
  await again.close();
});

test('binding repair does not replay an already completed discussion', async () => {
  const { host, room, send } = setup();
  const ack = send('Saved outline');
  await host.runRoom(room.id, { request: 'Saved outline', peer_message_id: ack.message_id });
  const epoch = host.rooms.get(room.id).epoch;
  await host.drain();
  assert.equal(host.rooms.get(room.id).epoch, epoch);
  assert.equal(host.messages.get(ack.message_id).room_wake_pending, false);
});

test('peer room mail waits for an existing discussion instead of interrupting it', async () => {
  const gate = makeGate();
  const seen = [];
  const { host, room, send } = setup(ctx => (async function* () {
    seen.push(ctx.payload.request);
    if (ctx.payload.request === 'Current discussion') await gate.promise;
    yield say('(pass)');
  })());
  const current = host.runRoom(room.id, { request: 'Current discussion' });
  send('Next discussion');
  const drained = host.drain();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['Current discussion']);
  gate.release(); await current; await drained;
  assert.deepEqual(seen, ['Current discussion', 'Next discussion']);
});

test('cancelled peer room mail never starts a discussion', async () => {
  const { host, room, send } = setup(() => assert.fail('cancelled mail ran'));
  send('Cancelled outline', { automation_id: 'cancelled' });
  host.messages.isAutomationCancelled = id => id === 'cancelled';
  await host.drain();
  assert.equal(host.rooms.get(room.id).discussion, undefined);
});

test('stopping a room cancels its queued peer discussions', async () => {
  const { host, room, send } = setup(() => assert.fail('stopped room ran'));
  const ack = send('Queued outline');
  host.stopRoom(room.id);
  await host.drain();
  assert.equal(host.messages.get(ack.message_id).status, 'cancelled');
  assert.equal(host.messages.pendingRooms().length, 0);
});
