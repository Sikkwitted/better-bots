import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { draftStore } from '../web/draft-store.js';
import { ImageAttachmentDraft, captureComposerSubmission, requestForSubmission, restoreFailedText, attachmentQueueNote } from '../web/image-attachments.js';

// Exercise the shipped composer with unresolved API requests. No model or
// network is used, but image claims and recovery use the real draft class.
function composer({ selected = 'agt_a' } = {}) {
  const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function mode()'), source.indexOf('// -------------------------------------------------------------------- forms'));
  const nodes = new Map();
  const element = () => ({
    value: '', disabled: false, hidden: false, style: {}, dataset: {}, listeners: {}, children: [],
    addEventListener(name, fn) { this.listeners[name] = fn; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    focus() {}, click() {}, contains() { return false; },
    classList: { add() {}, remove() {} },
  });
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  node('input[name="mode"]:checked').value = 'user';
  const from = node('#peer-from');
  from.replaceChildren = function replaceChildren() { this.children = []; this.value = ''; };
  from.append = function append(...children) {
    this.children.push(...children);
    if (!this.value && children[0]?.value) this.value = children[0].value;
  };
  const requests = [];
  const revoked = [];
  const notices = [];
  const uploadImage = async (file) => ({ id: file.name, name: file.name, url: `/api/attachments/${file.name}` });
  const urls = { createObjectURL: (file) => `blob:${file.name}`, revokeObjectURL: (url) => revoked.push(url) };
  const initialImages = new ImageAttachmentDraft({
    upload: uploadImage, ...urls,
    onChange: () => vm.runInContext('renderImageDraft(); renderComposer();', context),
  });
  const context = vm.createContext({
    draftStore, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    window: { addEventListener() {} }, transcriptPage: { owner: null, before: null },
    state: {
      selected: 'agt_a', selectedKind: 'agent',
      agents: [{ id: 'agt_a', name: 'A' }, { id: 'agt_b', name: 'B' }, { id: 'agt_c', name: 'C' }],
      rooms: [{ id: 'room_a', purpose: 'Room A' }, { id: 'room_b', purpose: 'Room B' }],
    },
    $: node,
    document: { querySelector: node, querySelectorAll: () => [node('input[name="mode"]:checked')] },
    agentById: () => ({ name: 'A' }), el: element, renderEntry: (entry) => entry,
    imageDraft: initialImages, ImageAttachmentDraft, uploadImage, URL: urls,
    captureComposerSubmission, requestForSubmission, restoreFailedText, attachmentQueueNote,
    banner: (...args) => notices.push(args), setTimeout() {}, loadTranscript: async () => {},
    refresh: async () => vm.runInContext('renderComposer()', context),
    api: (method, route, body) => new Promise((resolve, reject) => requests.push({ method, route, body, resolve, reject })),
  });
  context.state.selected = selected;
  vm.runInContext(code, context);
  return {
    node, requests, context, revoked, notices,
    render() { vm.runInContext('renderComposer()', context); },
    select(kind, id) {
      context.state.selectedKind = kind;
      context.state.selected = id;
      this.render();
    },
    mode(value) {
      node('input[name="mode"]:checked').value = value;
      node('input[name="mode"]:checked').listeners.change();
    },
    sender(id) {
      node('#peer-from').value = id;
      node('#peer-from').listeners.change?.();
    },
    images() { return vm.runInContext('imageDraft', context); },
    addImage(name) { return this.images().addFiles([{ name, type: 'image/png', size: 12 }]); },
    submit(text = node('#input').value) {
      node('#input').value = text;
      return node('#composer').listeners.submit({ preventDefault() {} });
    },
  };
}

const roomResult = { result: { stop_reason: 'round_complete', total_messages: 2 } };

function assertDraft(ui, text, ids) {
  assert.equal(ui.node('#input').value, text);
  assert.deepEqual(ui.images().attachmentIds(), ids);
}

test('composer initializes and disables recipient controls before the first state refresh', async () => {
  const ui = composer({ selected: null });
  assert.ok(ui.images(), 'the shipped startup must initialize its draft');
  assert.equal(ui.node('#input').disabled, true);
  assert.equal(ui.node('#attach-images').disabled, true);
  assert.equal(ui.node('#composer button[type="submit"]').disabled, true);
  await ui.submit('No recipient yet');
  assert.equal(ui.requests.length, 0);
});

test('early image selection without a recipient is rejected safely and resets the picker', async () => {
  const ui = composer({ selected: null });
  const target = { value: 'early.png', files: [{ name: 'early.png', type: 'image/png', size: 12 }] };
  await ui.node('#image-picker').listeners.change({ target });
  assert.equal(target.value, '');
  assert.equal(ui.images().items.length, 0);
  assert.match(ui.notices.at(-1)[0], /select.*bot.*room/i);
});

test('typing and sending a follow-up remain available while the previous request is pending', async () => {
  const ui = composer();
  const first = ui.submit('First request');
  assert.equal(ui.node('#input').disabled, false, 'a pending turn must not lock the text field');
  assert.equal(ui.node('#composer button[type="submit"]').disabled, false, 'follow-ups can be queued');
  const second = ui.submit('Correction for the same agent');
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].route, '/api/ask');
  assert.equal(ui.requests[1].body.agent_id, 'agt_a');
  assert.equal(ui.requests[1].body.text, 'Correction for the same agent');
  ui.node('#input').value = 'Unsent next draft';
  ui.requests[0].resolve({});
  await first;
  assert.equal(ui.node('#input').value, 'Unsent next draft');
  ui.requests[1].resolve({});
  await second;
  assert.equal(ui.node('#input').value, 'Unsent next draft');
});

test('the composer still requires a selected recipient', async () => {
  const ui = composer();
  ui.context.state.selected = null;
  ui.render();
  assert.equal(ui.node('#input').disabled, true);
  assert.equal(ui.node('#composer button[type="submit"]').disabled, true);
  await ui.submit('No recipient');
  assert.equal(ui.requests.length, 0);
});

test('an image-stage rerender preserves the chosen peer sender', () => {
  const ui = composer();
  ui.mode('peer');
  ui.sender('agt_c');
  ui.render();
  assert.equal(ui.node('#peer-from').value, 'agt_c');
});

test('failure after A to B navigation preserves both recipients text and images for later recovery', async () => {
  const ui = composer();
  await ui.addImage('a.png');
  const sending = ui.submit('Failed A text');
  ui.select('agent', 'agt_b');
  ui.node('#input').value = 'B draft';
  await ui.addImage('b.png');
  ui.requests[0].reject(new Error('A failed'));
  await sending;

  assert.equal(ui.context.state.selected, 'agt_b', 'failure must not navigate back');
  assertDraft(ui, 'B draft', ['b.png']);
  assert.deepEqual(ui.revoked, [], 'failed previews must remain recoverable');
  ui.select('agent', 'agt_a');
  assertDraft(ui, 'Failed A text', ['a.png']);
  ui.select('agent', 'agt_b');
  assertDraft(ui, 'B draft', ['b.png']);
});

test('failed agent draft does not leak into a room even when recipient ids match', async () => {
  const ui = composer();
  await ui.addImage('agent.png');
  const sending = ui.submit('Agent text');
  ui.select('room', 'agt_a');
  ui.node('#input').value = 'Room draft';
  await ui.addImage('room.png');
  ui.requests[0].reject(new Error('Agent failed'));
  await sending;

  assertDraft(ui, 'Room draft', ['room.png']);
  ui.select('agent', 'agt_a');
  assertDraft(ui, 'Agent text', ['agent.png']);
});

test('failure recovery distinguishes user mode and each peer sender', async () => {
  const ui = composer();
  await ui.addImage('user.png');
  const userSend = ui.submit('User text');
  ui.mode('peer');
  ui.sender('agt_b');
  await ui.addImage('peer-b.png');
  const peerSend = ui.submit('Peer B text');
  assert.equal(ui.requests[1].route, '/api/send');
  assert.equal(ui.requests[1].body.sender_id, 'agt_b');
  ui.sender('agt_c');
  ui.node('#input').value = 'Peer C draft';
  await ui.addImage('peer-c.png');
  ui.requests[1].reject(new Error('Peer failed'));
  await peerSend;
  ui.requests[0].reject(new Error('User failed'));
  await userSend;

  assertDraft(ui, 'Peer C draft', ['peer-c.png']);
  ui.sender('agt_b');
  assertDraft(ui, 'Peer B text', ['peer-b.png']);
  ui.mode('user');
  assertDraft(ui, 'User text', ['user.png']);
  ui.mode('peer');
  ui.sender('agt_c');
  assertDraft(ui, 'Peer C draft', ['peer-c.png']);
});

test('same-context failure preserves newer text and images, and retry clears only the submitted draft', async () => {
  const ui = composer();
  await ui.addImage('failed.png');
  const sending = ui.submit('Failed text');
  ui.node('#input').value = 'Newer text';
  await ui.addImage('newer.png');
  ui.requests[0].reject(new Error('Send failed'));
  await sending;
  assertDraft(ui, 'Failed text\n\nNewer text', ['failed.png', 'newer.png']);

  const retry = ui.submit();
  assert.equal(ui.requests[1].body.text, 'Failed text\n\nNewer text');
  assert.deepEqual(ui.requests[1].body.attachments, ['failed.png', 'newer.png']);
  ui.node('#input').value = 'Third draft';
  await ui.addImage('third.png');
  ui.requests[1].resolve({});
  await retry;
  assertDraft(ui, 'Third draft', ['third.png']);
  assert.deepEqual(ui.revoked, ['blob:failed.png', 'blob:newer.png']);
});

test('out-of-order failures retain all original-context submissions beside a subsequent draft', async () => {
  const ui = composer();
  await ui.addImage('first.png');
  const first = ui.submit('First');
  await ui.addImage('second.png');
  const second = ui.submit('Second');
  ui.node('#input').value = 'Third';
  await ui.addImage('third.png');
  ui.select('agent', 'agt_b');
  ui.node('#input').value = 'B draft';
  ui.requests[1].reject(new Error('Second failed first'));
  await second;
  ui.requests[0].reject(new Error('First failed last'));
  await first;

  assertDraft(ui, 'B draft', []);
  ui.select('agent', 'agt_a');
  assertDraft(ui, 'First\n\nSecond\n\nThird', ['first.png', 'second.png', 'third.png']);
});

test('image-only failure remains recoverable while an out-of-order successful send clears its own previews', async () => {
  const ui = composer();
  await ui.addImage('failed.png');
  const first = ui.submit('');
  await ui.addImage('sent.png');
  const second = ui.submit('Sent');
  ui.select('agent', 'agt_b');
  ui.node('#input').value = 'B draft';
  await ui.addImage('b.png');
  ui.requests[1].resolve({});
  await second;
  ui.requests[0].reject(new Error('Image send failed'));
  await first;

  assertDraft(ui, 'B draft', ['b.png']);
  assert.deepEqual(ui.revoked, ['blob:sent.png']);
  ui.select('agent', 'agt_a');
  assertDraft(ui, '', ['failed.png']);
});

test('room render disables only sending while a round is pending', async () => {
  const ui = composer();
  ui.select('room', 'room_a');
  const sending = ui.submit('Start a round');
  assert.equal(ui.requests[0].route, '/api/rooms/say');
  assert.equal(ui.node('#input').disabled, false, 'the next room draft can still be typed');
  assert.equal(ui.node('#composer button[type="submit"]').disabled, true);
  ui.requests[0].resolve(roomResult);
  await sending;
  assert.equal(ui.node('#composer button[type="submit"]').disabled, false);
});

test('room submit guard cannot be bypassed by direct submit or switching rooms; agent follow-ups stay concurrent', async () => {
  const ui = composer();
  ui.select('room', 'room_a');
  const first = ui.submit('Room A round');
  await ui.addImage('next-room.png');
  const duplicate = ui.submit('Next room draft');
  assert.equal(ui.requests.length, 1, 'a direct submit must not POST a duplicate room round');
  await duplicate;
  assertDraft(ui, 'Next room draft', ['next-room.png']);

  ui.select('room', 'room_b');
  assert.equal(ui.node('#composer button[type="submit"]').disabled, false);
  const otherRoom = ui.submit('Room B round');
  assert.equal(ui.requests[1].body.room_id, 'room_b');
  ui.select('room', 'room_a');
  assert.equal(ui.node('#composer button[type="submit"]').disabled, true);
  await ui.submit();
  assert.equal(ui.requests.length, 2, 'returning to the pending room must not bypass its guard');

  ui.select('agent', 'agt_a');
  const ask = ui.submit('Agent turn');
  const followUp = ui.submit('Agent follow-up');
  assert.equal(ui.requests.length, 4);
  assert.deepEqual(ui.requests.slice(2).map((request) => request.route), ['/api/ask', '/api/ask']);
  ui.requests[0].resolve(roomResult);
  await first;
  ui.select('room', 'room_a');
  assert.equal(ui.node('#composer button[type="submit"]').disabled, false);
  assertDraft(ui, 'Next room draft', ['next-room.png']);
  ui.select('room', 'room_b');
  assert.equal(ui.node('#composer button[type="submit"]').disabled, true, 'A completion must not unlock B');
  ui.requests[1].resolve(roomResult);
  ui.requests[2].resolve({});
  ui.requests[3].resolve({});
  await Promise.all([otherRoom, ask, followUp]);
});

test('failed room round releases the captured room guard and retains its draft after navigation', async () => {
  const ui = composer();
  ui.select('room', 'room_a');
  await ui.addImage('room-a.png');
  const sending = ui.submit('Failed room round');
  ui.select('room', 'room_b');
  ui.node('#input').value = 'B room draft';
  ui.requests[0].reject(new Error('Room failed'));
  await sending;
  assertDraft(ui, 'B room draft', []);

  ui.select('room', 'room_a');
  assert.equal(ui.node('#composer button[type="submit"]').disabled, false);
  assertDraft(ui, 'Failed room round', ['room-a.png']);
  const retry = ui.submit();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.node('#composer button[type="submit"]').disabled, true);
  ui.requests[1].resolve(roomResult);
  await retry;
  assertDraft(ui, '', []);
});
