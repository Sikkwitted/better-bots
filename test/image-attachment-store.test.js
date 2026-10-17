import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImageAttachmentStore } from '../src/services/image-attachment-store.js';
import { HostError } from '../src/core/util.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';
const WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=';
const input = (data = PNG, media_type = 'image/png') => ({ name: 'screen.png', media_type, data });
const code = (expected) => (error) => error instanceof HostError && error.code === expected;

function setup(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-attachments-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'attachments');
  return { dir, store: new ImageAttachmentStore({ dir }) };
}

test('image bytes and public metadata survive a new store instance', (t) => {
  const { dir, store } = setup(t);
  const attachment = store.save(input());
  assert.match(attachment.id, /^img_[a-f0-9]{32}$/);
  assert.deepEqual(attachment, {
    id: attachment.id, name: 'screen.png', media_type: 'image/png',
    size: Buffer.from(PNG, 'base64').length, url: `/api/attachments/${attachment.id}`,
  });
  const reopened = new ImageAttachmentStore({ dir });
  assert.deepEqual(reopened.resolve([attachment.id]), [attachment]);
  assert.deepEqual(reopened.read(attachment.id), { attachment, buffer: Buffer.from(PNG, 'base64') });
  assert.deepEqual(reopened.image(attachment.id), { media_type: 'image/png', data: PNG });
  assert.deepEqual(reopened.resolve(), []);
});

test('GIF uploads are retained with their declared matching type', (t) => {
  const { store } = setup(t);
  const attachment = store.save({ name: 'pixel.gif', media_type: 'image/gif', data: GIF });
  assert.deepEqual(store.image(attachment.id), { media_type: 'image/gif', data: GIF });
});

test('JPEG and WebP files round-trip with their original bytes', (t) => {
  const { store } = setup(t);
  for (const [data, media_type] of [[JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) {
    const attachment = store.save(input(data, media_type));
    assert.deepEqual(store.image(attachment.id), { media_type, data });
  }
});

test('signature-only JPEG and empty WebP containers are rejected', (t) => {
  const { store } = setup(t);
  assert.throws(() => store.save(input('/9j/2Q==', 'image/jpeg')), code('invalid_attachment'));
  const emptyWebp = Buffer.from('524946460c000000574542505650382000000000', 'hex');
  assert.throws(() => store.save(input(emptyWebp.toString('base64'), 'image/webp')), code('invalid_attachment'));
});

test('malformed base64, MIME mismatches and forbidden formats never create attachments', (t) => {
  const { dir, store } = setup(t);
  for (const upload of [
    input(''), input('not-base64!'), input(`${PNG}\n`), input(`data:image/png;base64,${PNG}`),
    input(PNG.replace(/=$/, '')), input('Zh=='), input(PNG, 'image/jpeg'),
    input(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'), 'image/svg+xml'),
    input(Buffer.from('%PDF-1.7').toString('base64'), 'application/pdf'),
    input(Buffer.from('plain text').toString('base64')), input(PNG.slice(0, 32)),
    { ...input(), name: '../outside.png' }, { ...input(), name: 'bad\nname.png' },
    { ...input(), name: 'x'.repeat(256) }, { ...input(), data: 123 }, null,
  ]) assert.throws(() => store.save(upload), code('invalid_attachment'));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an image above five MiB is rejected before it can be stored', (t) => {
  const { dir, store } = setup(t);
  const data = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => store.save(input(data)), code('attachment_too_large'));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('resolve validates the complete ID list and never drops a missing attachment', (t) => {
  const { store } = setup(t);
  const { id } = store.save(input());
  assert.equal(store.resolve([id, id, id, id]).length, 4);
  assert.throws(() => store.resolve([id, id, id, id, id]), code('invalid_attachment'));
  for (const ids of [null, id, {}, [null], [123], [id, '../outside'], [id, '']]) {
    assert.throws(() => store.resolve(ids), code('invalid_attachment'));
  }
  assert.throws(() => store.resolve([id, `img_${'0'.repeat(32)}`]), code('attachment_not_found'));
});

test('read and provider hydration reject missing, path-like and malformed IDs', (t) => {
  const { store } = setup(t);
  for (const id of ['../outside', '/etc/passwd', '..%2foutside', 'img_bad', '', null, 7]) {
    assert.throws(() => store.read(id), code('invalid_attachment'));
    assert.throws(() => store.image(id), code('invalid_attachment'));
  }
  assert.throws(() => store.read(`img_${'0'.repeat(32)}`), code('attachment_not_found'));
});

test('stored content is private and incomplete temporary records are never published', (t) => {
  const { dir, store } = setup(t);
  const { id } = store.save(input());
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir), [id]);
  const record = path.join(dir, id);
  assert.equal(fs.statSync(record).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(record)) {
    assert.equal(fs.statSync(path.join(record, file)).mode & 0o777, 0o600);
  }
});

test('corrupt stored metadata or bytes cannot be resolved or sent to a provider', (t) => {
  const { dir, store } = setup(t);
  const first = store.save(input());
  fs.writeFileSync(path.join(dir, first.id, 'image.bin'), 'broken');
  assert.throws(() => store.resolve([first.id]), code('invalid_attachment'));
  const second = store.save(input());
  fs.writeFileSync(path.join(dir, second.id, 'metadata.json'), JSON.stringify({ ...second, id: '../outside' }));
  assert.throws(() => store.image(second.id), code('invalid_attachment'));
});

test('attachment directories and payload files cannot redirect reads through symlinks', (t) => {
  const { dir, store } = setup(t);
  const { id } = store.save(input());
  const linked = `img_${'1'.repeat(32)}`;
  fs.symlinkSync(path.join(dir, id), path.join(dir, linked));
  assert.throws(() => store.read(linked), code('invalid_attachment'));
  const imageFile = path.join(dir, id, 'image.bin');
  const outside = path.join(path.dirname(dir), 'outside.png');
  fs.writeFileSync(outside, Buffer.from(PNG, 'base64'));
  fs.rmSync(imageFile);
  fs.symlinkSync(outside, imageFile);
  assert.throws(() => store.read(id), code('invalid_attachment'));
});
