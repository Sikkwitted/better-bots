import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { makeHost, reopenHost, say } from './helpers.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const upload = { name: 'sample.png', media_type: 'image/png', data: PNG };
const images = (call) => call.messages.flatMap((m) => m.images ?? []);
function setup() {
  const made = makeHost({ script: () => [say('image received')] });
  made.host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  made.host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  return made;
}

test('image-only user request reaches the model once and survives restart without logging base64', async () => {
  const { host, adapter, dir } = setup();
  const attachment = host.attachments.save(upload);
  const run = host.userRequest({ agent_id: 'agt_a', attachments: [attachment.id] });
  await host.drain();
  assert.deepEqual(images(adapter.calls[0]), [{ media_type: 'image/png', data: PNG }]);
  assert.match(adapter.calls[0].messages.at(-1).content, new RegExp(attachment.id));
  assert.equal(host.turnResult(run.id).text, 'image received');
  const transcript = host.transcripts.all('agent', 'agt_a');
  assert.deepEqual(transcript.find((e) => e.kind === 'user_message').attachments, [attachment]);
  assert.ok(!JSON.stringify(transcript).includes(PNG));
  assert.ok(!fs.readFileSync(path.join(dir, 'runs', 'runs.jsonl'), 'utf8').includes(PNG));
  const reopened = reopenHost({ dir, script: () => [say('still visible')] });
  reopened.host.userRequest({ agent_id: 'agt_a', text: 'What about the picture above?' });
  await reopened.host.drain();
  assert.deepEqual(images(reopened.adapter.calls[0]), [{ media_type: 'image/png', data: PNG }]);
});

test('invalid or missing images cannot create a phantom message or queued run', () => {
  const { host } = setup();
  for (const attachments of [['bad-id'], ['img_' + 'a'.repeat(32)], 'not-an-array']) {
    assert.throws(() => host.userRequest({ agent_id: 'agt_a', text: 'hello', attachments }));
  }
  assert.equal(host.transcripts.all('agent', 'agt_a').length, 0);
});

test('peer image wakes and group member turns receive real image data', async () => {
  const { host, adapter } = setup();
  const attachment = host.attachments.save(upload);
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'See this', attachments: [attachment.id] });
  await host.drain();
  assert.deepEqual(images(adapter.calls[0]), [{ media_type: 'image/png', data: PNG }]);
  assert.deepEqual(host.transcripts.all('agent', 'agt_a')[0].attachments, [attachment]);
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'image review' });
  const before = adapter.calls.length;
  await host.sayInRoom(room.id, { attachments: [attachment.id] });
  assert.ok(adapter.calls.length > before);
  for (const call of adapter.calls.slice(before)) assert.deepEqual(images(call), [{ media_type: 'image/png', data: PNG }]);
  assert.deepEqual(host.transcripts.all('room', room.id).find((e) => e.sender_id === 'user').attachments, [attachment]);
});

test('recent image history is bounded and current attachments are included first', async () => {
  const { host, adapter } = setup();
  const all = Array.from({ length: 7 }, (_, i) => host.attachments.save({ ...upload, name: `${i}.png` }));
  for (const attachment of all.slice(0, 3)) host.transcripts.append('agent', 'agt_a', { kind: 'user_message', text: 'older', attachments: [attachment] });
  host.userRequest({ agent_id: 'agt_a', text: 'compare these four', attachments: all.slice(3).map((a) => a.id) });
  await host.drain();
  assert.equal(images(adapter.calls[0]).length, 4);
  assert.equal(adapter.calls[0].messages.at(-1).images.length, 4);
});

test('coalesced peer wake gives newest images priority over older attachments', async () => {
  const { host, adapter } = setup();
  const older = Array.from({ length: 4 }, () => host.attachments.save(upload).id);
  const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const newer = Array.from({ length: 4 }, () => host.attachments.save({ name: 'latest.gif', media_type: 'image/gif', data: gif }).id);
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'old version', attachments: older });
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'use these instead', attachments: newer });
  await host.drain();
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(images(adapter.calls[0]), Array.from({ length: 4 }, () => ({ media_type: 'image/gif', data: gif })));
});

test('authenticated HTTP upload, download and ask preserve bytes; upload limits do not enlarge ordinary routes', async () => {
  const { host, adapter } = setup();
  const server = createServer({ host, live: false, token: 'image-test-token' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, auth = true) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer image-test-token' } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/attachments/images', upload, false)).status, 401);
    const saved = await post('/api/attachments/images', upload);
    assert.equal(saved.status, 200);
    const { attachment } = await saved.json();
    assert.equal((await fetch(base + attachment.url)).status, 401);
    const downloaded = await fetch(base + attachment.url, { headers: { Authorization: 'Bearer image-test-token' } });
    assert.equal(downloaded.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), Buffer.from(PNG, 'base64'));
    const asked = await post('/api/ask', { agent_id: 'agt_a', attachments: [attachment.id] });
    assert.equal(asked.status, 200);
    assert.deepEqual(images(adapter.calls[0]), [{ media_type: 'image/png', data: PNG }]);
    assert.equal((await post('/api/ask', { agent_id: 'agt_a', text: 'x'.repeat(1_000_001) })).status, 413);
    assert.equal((await post('/api/attachments/images', { ...upload, data: 'A'.repeat(7 * 1024 * 1024) })).status, 413);
    assert.equal((await post('/api/ask', { agent_id: 'agt_a', attachments: ['img_' + 'b'.repeat(32)] })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
