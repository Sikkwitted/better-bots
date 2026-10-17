import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, say } from './helpers.js';
import { MAX_TEXT_CHARS, MAX_ATTACHMENTS, MAX_CHAIN_DEPTH, PRIORITY_RATE_LIMIT } from '../src/services/message-service.js';

// Peer messaging reliability: delivery survives restart, IDs deduplicate, and
// acknowledgement loops are prevented.

function setup() {
  const made = makeHost({ script: () => [say('ok')] });
  made.host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  made.host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  return made;
}

function storedImage(host) {
  return host.attachments.save({ name: 'sample.png', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=' });
}

test('send returns an acknowledgement that does not pretend to be a reply', () => {
  const { host } = setup();
  const ack = host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'hello' });
  assert.equal(ack.acknowledged, true);
  assert.ok(ack.message_id);
  assert.match(ack.note, /not a reply/);
  assert.match(ack.note, /Do not wait or poll/);
  assert.equal(ack.text, undefined, 'there is no reply field to mistake for an answer');
});

test('an agent may not message itself, and unknown targets are rejected', () => {
  const { host } = setup();
  assert.throws(() => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_a', text: 'x' }), /may not message itself/);
  assert.throws(() => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_nope', text: 'x' }), /no agent or room/);
});

test('both sides get a visible transcript record', async () => {
  const { host } = setup();
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'the handoff' });
  assert.equal(host.transcripts.all('agent', 'agt_a').filter((e) => e.kind === 'peer_message_out').length, 1);
  await host.drain();
  assert.equal(host.transcripts.all('agent', 'agt_b').filter((e) => e.kind === 'peer_message_in').length, 1);
});

test('message size and attachments are bounded', () => {
  const { host } = setup();
  const attachments = Array.from({ length: MAX_ATTACHMENTS }, () => storedImage(host).id);
  const ack = host.deliverPeerMessage({
    sender_id: 'agt_a', target_id: 'agt_b',
    text: 'x'.repeat(MAX_TEXT_CHARS + 500),
    attachments,
  });
  const envelope = host.messages.get(ack.message_id);
  assert.equal(envelope.text.length, MAX_TEXT_CHARS);
  assert.equal(envelope.attachments.length, MAX_ATTACHMENTS);
  assert.equal(ack.capability_notes.length, 1);
  assert.throws(() => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'too many', attachments: [...attachments, storedImage(host).id] }), /at most four/);
});

test('group messages retain images and ignore priority', () => {
  const { host } = setup();
  const attachment = storedImage(host);
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'group' });
  const ack = host.deliverPeerMessage({
    sender_id: 'agt_a', target_id: room.id, text: 'group post',
    attachments: [attachment.id], priority: true, priority_reason: 'stop',
  });
  assert.equal(ack.priority, false);
  assert.deepEqual(host.messages.get(ack.message_id).attachments, [attachment]);
  assert.ok(ack.capability_notes.some((n) => /one-to-one only/.test(n)));
  assert.ok(host.audit.where((e) => e.type === 'message.priority_ignored_for_group').length === 1);
  assert.equal(host.transcripts.all('room', room.id).filter((e) => e.kind === 'room_message').length, 1);
});

test('priority requires one of a small set of declared reasons', () => {
  const { host } = setup();
  assert.throws(
    () => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'urgent', priority: true }),
    /priority requires one of/,
  );
  assert.throws(
    () => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'urgent', priority: true, priority_reason: 'because' }),
    /priority requires one of/,
  );
});

test('priority is rate limited per sender', () => {
  const { host } = setup();
  const acks = [];
  for (let i = 0; i < PRIORITY_RATE_LIMIT.max + 1; i += 1) {
    acks.push(host.deliverPeerMessage({
      sender_id: 'agt_a', target_id: 'agt_b', text: `urgent ${i}`,
      priority: true, priority_reason: 'safety',
    }));
  }
  assert.equal(acks.filter((a) => a.priority).length, PRIORITY_RATE_LIMIT.max);
  const last = acks.at(-1);
  assert.equal(last.priority, false);
  assert.ok(last.capability_notes.some((n) => /rate limit/.test(n)), 'the message still arrives, just not as priority');
  assert.ok(host.audit.where((e) => e.type === 'message.priority_rate_limited').length === 1);
});

test('priority goes to the front of the inbox', () => {
  const { host } = setup();
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'normal one' });
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'normal two' });
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'urgent', priority: true, priority_reason: 'stop' });
  assert.deepEqual(host.messages.pending('agt_b').map((m) => m.text), ['urgent', 'normal one', 'normal two']);
});

test('message IDs deduplicate a retried delivery', () => {
  const { host } = setup();
  const id = 'msg_fixed_for_retry';
  const first = host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'once', message_id: id });
  const retry = host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'once', message_id: id });
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(host.messages.pending('agt_b').length, 1, 'a retry does not create duplicate work');
});

test('automatic acknowledgement loops are prevented', () => {
  const { host } = setup();
  assert.throws(
    () => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'ack', is_acknowledgement: true }),
    /acknowledgement/,
  );
  assert.throws(
    () => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'pong', chain_depth: MAX_CHAIN_DEPTH + 1 }),
    /chain/,
  );
  assert.ok(host.audit.where((e) => e.type === 'message.ack_loop_blocked').length === 1);
  assert.ok(host.audit.where((e) => e.type === 'message.chain_depth_exceeded').length === 1);
});

test('a peer ping-pong terminates at the chain depth bound', async () => {
  let host;
  const script = (ctx) => {
    if (ctx.payload?.kind === 'agent_wake') {
      const other = ctx.agent_id === 'agt_a' ? 'agt_b' : 'agt_a';
      try {
        host.deliverPeerMessage({
          sender_id: ctx.agent_id, target_id: other, text: 'bouncing',
          chain_depth: (ctx.payload.chain_depth ?? 0) + 1,
        });
      } catch {
        return [say('chain stopped by the host')];
      }
    }
    return [say('ok')];
  };
  const made = makeHost({ script });
  host = made.host;
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });

  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'start' });
  await host.drain();

  assert.ok(host.audit.where((e) => e.type === 'message.chain_depth_exceeded').length >= 1);
  assert.ok(host.messages.allEnvelopes().length <= MAX_CHAIN_DEPTH + 2, 'the bounce is bounded');
});

test('a wake for several queued messages happens once, not once per message', async () => {
  const { host } = setup();
  for (let i = 0; i < 5; i += 1) {
    host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: `note ${i}` });
  }
  await host.drain();
  const wakes = host.scheduler.runHistory().filter((r) => r.agent_id === 'agt_b' && r.lane === 'agent' && r.event === 'started');
  assert.equal(wakes.length, 1);
  assert.equal(host.transcripts.all('agent', 'agt_b').filter((e) => e.kind === 'peer_message_in').length, 5);
});
