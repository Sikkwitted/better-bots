import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host.js';
import { hydrateImageMessages } from '../src/context.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';
import { tmpDir, oneStep, say, reopenHost } from './helpers.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const upload = { name: 'sample.png', media_type: 'image/png', data: PNG };
const reply = 'Please tell me what you would like to do next.';
const images = (call) => call.messages.flatMap((m) => m.images ?? []);
const logs = (host, id) => host.memory.factsIn('agent', id).filter((f) => f.source === 'turn_log');

class FakeEngine {
  retained = [];
  async retain(bank, item) { this.retained.push({ bank, item }); return { success: true }; }
  async recall() { return []; }
}

function setup({ engine = null, script = () => [say(reply)] } = {}) {
  const dir = tmpDir('image-recovery');
  const adapter = new ScriptedAdapter(oneStep(script));
  const host = new Host({ dir, adapter, clock: fixedClock(), memory_engine: engine });
  for (const [id, name] of [['agt_a', 'Ada'], ['agt_b', 'Bo']]) host.registry.create({ id, profile: { name } });
  return { host, adapter, dir };
}

for (const code of ['ENOENT', 'EACCES']) {
  test(`${code} historical image after restart does not block later text turns or leak private context`, async () => {
    const original = setup();
    const attachment = original.host.attachments.save(upload);
    original.host.userRequest({ agent_id: 'agt_a', attachments: [attachment.id] });
    await original.host.drain();
    const privateImage = original.host.attachments.save({ ...upload, name: 'private-bo.png' });
    original.host.transcripts.append('agent', 'agt_b', { kind: 'user_message', text: 'private Bo history', attachments: [privateImage] });
    const room = original.host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'private room' });
    original.host.transcripts.append('room', room.id, { kind: 'room_message', sender_id: 'user', text: 'room-only history', attachments: [privateImage] });

    const { host, adapter } = reopenHost({ dir: original.dir, script: () => [say(reply)] });
    const reads = [];
    host.attachments.image = (id) => {
      reads.push(id);
      throw Object.assign(new Error(`${code}: /private/secret-image.bin secret-token ${PNG}`), { code });
    };
    for (const text of ['Hello without an image.', 'Another text-only request.']) {
      const run = host.userRequest({ agent_id: 'agt_a', text });
      await host.drain();
      assert.equal(host.turnResult(run.id)?.status, 'completed', 'accepted turn has a visible successful result');
      assert.equal(host.turnResult(run.id).text, reply);
      assert.deepEqual(images(adapter.calls.at(-1)), []);
      const prompt = JSON.stringify(adapter.calls.at(-1).messages);
      assert.match(prompt, /image.*unavailable|unavailable.*image/i);
      assert.doesNotMatch(prompt, /private Bo history|private-bo|room-only history|secret-token|secret-image|ENOENT|EACCES/);
    }
    assert.deepEqual(reads, [attachment.id, attachment.id], 'only the requesting agent\'s recorded attachment is read');
    const durable = JSON.stringify([host.transcripts.all('agent', 'agt_a'), host.visibleResults(), host.audit.where(() => true)]);
    assert.ok(!durable.includes(PNG));
    assert.doesNotMatch(durable, /secret-token|secret-image/);
  });
}

test('an image lost after submission validation is honestly unavailable, not a silent failed run', async () => {
  const { host, adapter } = setup();
  const attachment = host.attachments.save(upload);
  const run = host.userRequest({ agent_id: 'agt_a', attachments: [attachment.id] });
  host.attachments.image = () => { throw new Error('private storage failure'); };
  await host.drain();
  assert.equal(host.turnResult(run.id)?.status, 'completed');
  assert.equal(host.turnResult(run.id).text, reply);
  assert.deepEqual(images(adapter.calls[0]), []);
  assert.match(adapter.calls[0].messages.at(-1).content, /image.*unavailable|unavailable.*image/i);
  assert.doesNotMatch(JSON.stringify(adapter.calls[0].messages), /private storage failure/);
});

for (const memory of ['none', 'members']) test(`unavailable room history respects ${memory} memory and never imports private chat`, async () => {
  const { host, adapter } = setup();
  const attachment = host.attachments.save(upload);
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'review', memory });
  host.transcripts.append('room', room.id, { kind: 'room_message', sender_id: 'user', text: '', attachments: [attachment] });
  host.transcripts.append('agent', 'agt_a', { kind: 'user_message', text: 'private one-to-one note' });
  host.attachments.image = () => { throw new Error('private storage failure'); };
  await host.sayInRoom(room.id, { text: 'Discuss next steps without the picture.' });
  assert.ok(adapter.calls.length >= 2);
  for (const call of adapter.calls) {
    assert.deepEqual(images(call), []);
    if (memory === 'members') assert.match(JSON.stringify(call.messages), /image.*unavailable|unavailable.*image/i);
    else assert.doesNotMatch(JSON.stringify(call.messages), /image.*unavailable|unavailable.*image/i);
    assert.doesNotMatch(JSON.stringify(call.messages), /private storage failure|private one-to-one note/);
  }
});

test('hydration skips only the unreadable image and leaves healthy provider-neutral images intact', () => {
  const messages = [{ role: 'user', content: 'Compare', attachments: [{ id: 'missing', name: 'missing.png' }, { id: 'healthy', name: 'healthy.png' }] }];
  const before = structuredClone(messages);
  const hydrated = hydrateImageMessages(messages, {
    image(id) {
      if (id === 'missing') throw new Error('do not expose me');
      return { media_type: 'image/png', data: PNG };
    },
  });
  assert.deepEqual(hydrated[0].images, [{ media_type: 'image/png', data: PNG }]);
  assert.match(hydrated[0].content, /missing.png.*unavailable/i);
  assert.doesNotMatch(hydrated[0].content, /do not expose me/);
  assert.ok(!hydrated[0].content.includes(PNG));
  assert.equal(hydrated[0].attachments, undefined);
  assert.deepEqual(messages, before);
});

test('unreadable new image submissions are still rejected before transcripts or runs are written', async () => {
  const { host, adapter } = setup();
  const attachment = host.attachments.save(upload);
  host.attachments.read = () => { throw new Error('unreadable attachment'); };
  assert.throws(() => host.userRequest({ agent_id: 'agt_a', attachments: [attachment.id] }), /unreadable attachment/);
  assert.throws(() => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', attachments: [attachment.id] }), /unreadable attachment/);
  assert.throws(() => host.userRequest({ agent_id: 'agt_a', attachments: ['invalid-id'] }));
  assert.throws(() => host.userRequest({ agent_id: 'agt_a', attachments: ['img_' + 'a'.repeat(32)] }));
  await host.drain();
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(host.transcripts.all('agent', 'agt_a'), []);
  assert.deepEqual(host.transcripts.all('agent', 'agt_b'), []);
  assert.deepEqual(host.visibleResults(), []);
});

for (const kind of ['user', 'peer']) {
  const sendImage = (host) => {
    const attachment = host.attachments.save(upload);
    if (kind === 'user') host.userRequest({ agent_id: 'agt_a', attachments: [attachment.id] });
    else host.deliverPeerMessage({ sender_id: 'agt_b', target_id: 'agt_a', attachments: [attachment.id] });
  };

  test(`successful image-only ${kind} turn is retained once in its own memory engine bank`, async () => {
    const engine = new FakeEngine();
    const { host } = setup({ engine });
    sendImage(host);
    await host.drain();
    await host.memory.flush();
    assert.equal(engine.retained.length, 1);
    const { bank, item } = engine.retained[0];
    assert.equal(bank, 'agent-agt_a');
    assert.equal(item.metadata.source, 'exchange');
    assert.equal(item.metadata.writer_agent_id, 'agt_a');
    assert.equal(item.context, kind === 'user' ? 'conversation with the user' : 'messages from teammates');
    assert.match(item.content, /1 image attachment/i);
    assert.match(item.content, /contents not recorded/i);
    assert.ok(item.content.includes(reply));
    if (kind === 'peer') assert.match(item.content, /Bo \(teammate\) to Ada:/);
    assert.ok(!JSON.stringify(engine.retained).includes(PNG));
    assert.deepEqual(host.memory.factsIn('project', 'default'), []);
    assert.deepEqual(host.memory.factsIn('agent', 'agt_b'), []);
  });

  test(`successful image-only ${kind} turn leaves a durable text log without an engine`, async () => {
    const { host, dir } = setup();
    sendImage(host);
    await host.drain();
    const kept = logs(host, 'agt_a');
    assert.equal(kept.length, 1);
    assert.match(kept[0].text, /1 image attachment/i);
    assert.match(kept[0].text, /contents not recorded/i);
    assert.ok(kept[0].text.includes(reply));
    if (kind === 'peer') assert.match(kept[0].text, /Bo \(teammate\)/);
    assert.ok(!JSON.stringify(kept).includes(PNG));
    const reopened = reopenHost({ dir }).host;
    assert.deepEqual(logs(reopened, 'agt_a'), kept);
    assert.deepEqual(logs(reopened, 'agt_b'), []);
  });
}

test('text-only user and peer requests keep their existing exchange and log formats', async () => {
  const engine = new FakeEngine();
  const { host } = setup({ engine });
  host.userRequest({ agent_id: 'agt_a', text: 'What next?' });
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'Please advise.' });
  await host.drain();
  await host.memory.flush();
  assert.equal(engine.retained.length, 2);
  assert.equal(engine.retained.find((r) => r.bank === 'agent-agt_a').item.content, `The user asked Ada: What next?\nAda answered: ${reply}`);
  assert.equal(engine.retained.find((r) => r.bank === 'agent-agt_b').item.content, `Ada (teammate) to Bo: Please advise.\nBo responded: ${reply}`);
  assert.equal(logs(host, 'agt_a')[0].text, `${host.clock.iso().slice(0, 10)} asked: What next? | answered: ${reply}`);
  assert.deepEqual(logs(host, 'agt_b'), [], 'ordinary text-only wakes retain the existing logging policy');
});

test('failed image-only turns are not retained as successful exchanges or logs', async () => {
  const engine = new FakeEngine();
  const { host } = setup({ engine, script: () => { throw new Error('offline provider failure'); } });
  const attachment = host.attachments.save(upload);
  const run = host.userRequest({ agent_id: 'agt_a', attachments: [attachment.id] });
  await host.drain();
  await host.memory.flush();
  assert.equal(host.turnResult(run.id).status, 'failed');
  assert.equal(engine.retained.length, 0);
  assert.deepEqual(logs(host, 'agt_a'), []);
});
