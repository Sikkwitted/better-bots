import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ImageAttachmentDraft,
  MAX_IMAGE_BYTES,
  captureComposerSubmission,
  requestForSubmission,
  restoreFailedText,
  attachmentQueueNote,
  renderAttachmentGallery,
} from '../web/image-attachments.js';

function file(name, type = 'image/png', size = 12) {
  return { name, type, size, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
}

test('image uploads are sequential and expose only completed attachment ids', async () => {
  const releases = [];
  const calls = [];
  const draft = new ImageAttachmentDraft({
    createObjectURL: (f) => `blob:${f.name}`,
    revokeObjectURL() {},
    upload: (f) => new Promise((resolve) => {
      calls.push(f.name);
      releases.push(() => resolve({ id: `id-${f.name}`, name: f.name, media_type: f.type, size: f.size, url: `/api/attachments/id-${f.name}` }));
    }),
  });

  const adding = draft.addFiles([file('one.png'), file('two.png')]);
  await Promise.resolve();
  assert.deepEqual(calls, ['one.png']);
  assert.equal(draft.hasPending(), true);
  assert.deepEqual(draft.attachmentIds(), []);

  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['one.png', 'two.png']);
  releases[1]();
  await adding;
  assert.equal(draft.hasPending(), false);
  assert.deepEqual(draft.attachmentIds(), ['id-one.png', 'id-two.png']);
});

test('the draft accepts four supported images and rejects excess, unsupported, and oversized files', async () => {
  const draft = new ImageAttachmentDraft({
    createObjectURL: (f) => `blob:${f.name}`,
    revokeObjectURL() {},
    upload: async (f) => ({ id: f.name, name: f.name, media_type: f.type, size: f.size, url: `/api/attachments/${f.name}` }),
  });

  const result = await draft.addFiles([
    file('a.png', 'image/png'),
    file('b.jpg', 'image/jpeg'),
    file('c.webp', 'image/webp'),
    file('d.gif', 'image/gif'),
    file('e.png', 'image/png'),
    file('bad.svg', 'image/svg+xml'),
    file('huge.png', 'image/png', MAX_IMAGE_BYTES + 1),
  ]);

  assert.equal(draft.items.length, 4);
  assert.deepEqual(draft.items.map((item) => item.file.name), ['a.png', 'b.jpg', 'c.webp', 'd.gif']);
  assert.match(result.errors.join('\n'), /four images/i);
  assert.match(result.errors.join('\n'), /SVG|supported/i);
  assert.match(result.errors.join('\n'), /5 MiB/i);
});

test('a failed upload remains removable and retryable', async () => {
  let attempts = 0;
  const revoked = [];
  const draft = new ImageAttachmentDraft({
    createObjectURL: (f) => `blob:${f.name}`,
    revokeObjectURL: (url) => revoked.push(url),
    upload: async (f) => {
      attempts += 1;
      if (attempts === 1) throw new Error('network down');
      return { id: 'retry-id', name: f.name, media_type: f.type, size: f.size, url: '/api/attachments/retry-id' };
    },
  });

  await draft.addFiles([file('recover.png')]);
  assert.equal(draft.items[0].status, 'error');
  assert.match(draft.items[0].error, /network down/);
  assert.equal(revoked.length, 0);

  await draft.retry(draft.items[0].key);
  assert.equal(draft.items[0].status, 'uploaded');
  assert.deepEqual(draft.attachmentIds(), ['retry-id']);

  draft.remove(draft.items[0].key);
  assert.deepEqual(revoked, ['blob:recover.png']);
  assert.equal(draft.items.length, 0);
});

test('successful send clears only its uploaded previews and leaves later selections intact', async () => {
  const revoked = [];
  const draft = new ImageAttachmentDraft({
    createObjectURL: (f) => `blob:${f.name}`,
    revokeObjectURL: (url) => revoked.push(url),
    upload: async (f) => ({ id: f.name, name: f.name, media_type: f.type, size: f.size, url: `/api/attachments/${f.name}` }),
  });
  await draft.addFiles([file('sent.png')]);
  const sentIds = draft.attachmentIds();
  assert.deepEqual(draft.claim(sentIds), sentIds);
  assert.deepEqual(draft.attachmentIds(), [], 'claimed images cannot be reused by a follow-up send');
  await draft.addFiles([file('later.png')]);

  draft.clearSent(sentIds);
  assert.deepEqual(draft.attachmentIds(), ['later.png']);
  assert.deepEqual(revoked, ['blob:sent.png']);
});

test('a failed send restores only its claimed images beside any newer draft', async () => {
  const draft = new ImageAttachmentDraft({
    createObjectURL: (f) => `blob:${f.name}`,
    revokeObjectURL() {},
    upload: async (f) => ({ id: f.name, name: f.name, media_type: f.type, size: f.size, url: `/api/attachments/${f.name}` }),
  });
  await draft.addFiles([file('first.png')]);
  const firstIds = draft.attachmentIds();
  draft.claim(firstIds);
  await draft.addFiles([file('later.png')]);

  assert.deepEqual(draft.attachmentIds(), ['later.png']);
  draft.restoreClaim(firstIds);
  assert.deepEqual(draft.attachmentIds(), ['first.png', 'later.png']);
});

test('failed recovery keeps eight previews but sends them four at a time', async () => {
  const draft = new ImageAttachmentDraft({
    createObjectURL: (f) => `blob:${f.name}`,
    revokeObjectURL() {},
    upload: async (f) => ({ id: f.name, name: f.name, media_type: f.type, size: f.size, url: `/api/attachments/${f.name}` }),
  });
  await draft.addFiles(['a', 'b', 'c', 'd'].map((name) => file(`${name}.png`)));
  const first = draft.attachmentIds();
  draft.claim(first);
  await draft.addFiles(['e', 'f', 'g', 'h'].map((name) => file(`${name}.png`)));
  draft.restoreClaim(first);

  assert.equal(draft.items.length, 8, 'failed recovery retains every preview');
  assert.equal(attachmentQueueNote(draft.readyCount()), 'The next 4 images will be sent. 4 will remain for the following message.');
  assert.deepEqual(draft.attachmentIds(), first, 'only the next four are exposed to a send');
  draft.claim(first);
  draft.clearSent(first);
  assert.deepEqual(draft.attachmentIds(), ['e.png', 'f.png', 'g.png', 'h.png']);
});

test('submission captures recipient and mode and includes attachment ids for every route', () => {
  const selected = captureComposerSubmission({
    selectedKind: 'agent', selectedId: 'agt_a', mode: 'peer', senderId: 'agt_b',
    priorityReason: 'stop', text: '', attachmentIds: ['img_1'],
  });
  const peerRequest = requestForSubmission(selected);
  assert.deepEqual(peerRequest, {
    route: '/api/send',
    body: { sender_id: 'agt_b', target_id: 'agt_a', text: '', priority_reason: 'stop', attachments: ['img_1'] },
  });

  assert.deepEqual(requestForSubmission(captureComposerSubmission({
    selectedKind: 'agent', selectedId: 'agt_a', mode: 'user', text: 'look', attachmentIds: ['img_2'],
  })), { route: '/api/ask', body: { agent_id: 'agt_a', text: 'look', attachments: ['img_2'] } });

  assert.deepEqual(requestForSubmission(captureComposerSubmission({
    selectedKind: 'room', selectedId: 'room_a', mode: 'user', text: '', attachmentIds: ['img_3'],
  })), { route: '/api/rooms/say', body: { room_id: 'room_a', text: '', attachments: ['img_3'] } });
});

test('a failed send restores its text without discarding text typed during the request', () => {
  assert.equal(restoreFailedText('Original draft', ''), 'Original draft');
  assert.equal(restoreFailedText('Original draft', 'New follow-up'), 'Original draft\n\nNew follow-up');
  assert.equal(restoreFailedText('', 'New follow-up'), 'New follow-up');
});

test('transcript attachment gallery uses server URLs and accessible image names', () => {
  const made = [];
  const documentRef = {
    createElement(tag) {
      const node = { tag, children: [], append(...children) { this.children.push(...children); } };
      made.push(node);
      return node;
    },
  };
  const gallery = renderAttachmentGallery([
    { id: 'img_1', name: 'diagram.png', media_type: 'image/png', url: '/api/attachments/img_1' },
  ], documentRef);

  assert.equal(gallery.className, 'message-attachments');
  assert.equal(gallery.children[0].tag, 'a');
  assert.equal(gallery.children[0].href, '/api/attachments/img_1');
  assert.equal(gallery.children[0].children[0].src, '/api/attachments/img_1');
  assert.equal(gallery.children[0].children[0].alt, 'diagram.png');
});
