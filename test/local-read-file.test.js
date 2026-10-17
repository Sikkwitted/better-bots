import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localTools } from '../src/tools/computer-tools.js';
import { tmpDir } from './helpers.js';

// LocalReadFile reads the host machine outside the sandbox. It must never read
// the data folder, even through a link, and must not hang the host on a file
// that never ends.

function setup() {
  const root = tmpDir('local-read');
  const dataDir = path.join(root, 'data');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dataDir); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(dataDir, 'providers-secrets.json'), '{"keys":{"x":"secret"}}');
  fs.writeFileSync(path.join(outside, 'notes.txt'), 'hello');
  const read = localTools({ dataDir }).find((t) => t.name === 'LocalReadFile');
  return { root, dataDir, outside, read: (p) => read.handler({ input: { path: p } }) };
}

test('reads an ordinary file outside the data folder', () => {
  const { outside, read } = setup();
  assert.deepEqual(read(path.join(outside, 'notes.txt')), { ok: true, path: path.join(outside, 'notes.txt'), content: 'hello' });
});

test('refuses the data folder directly and through a symlink', () => {
  const { dataDir, outside, read } = setup();
  assert.equal(read(path.join(dataDir, 'providers-secrets.json')).error, 'host_data_protected');
  const link = path.join(outside, 'innocent.txt');
  fs.symlinkSync(path.join(dataDir, 'providers-secrets.json'), link);
  assert.equal(read(link).error, 'host_data_protected');
});

test('refuses devices and directories instead of reading them forever', () => {
  const { outside, read } = setup();
  if (fs.existsSync('/dev/zero')) assert.equal(read('/dev/zero').error, 'not_a_file');
  assert.equal(read(outside).error, 'not_a_file');
});

test('refuses files over the size cap', () => {
  const { outside, read } = setup();
  const big = path.join(outside, 'big.log');
  fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
  assert.equal(read(big).error, 'file_too_large');
});
