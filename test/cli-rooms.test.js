import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';

const cli = new URL('../src/cli.js', import.meta.url).pathname;

test('a CLI room keeps its outcome with its members unless --shared asks for project memory', () => {
  const dir = tmpDir('cli-rooms');
  // No provider: the offline stand-in answers, so nothing is spent.
  const env = { PATH: process.env.PATH, HOME: dir, BETTER_BOTS_DIR: dir, BETTER_BOTS_MEMORY_ENGINE: 'local' };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run('create', 'Ada'); run('create', 'Bo');
  run('room', 'default room', 'Ada', 'Bo');
  run('room', 'shared room', 'Ada', 'Bo', '--shared');
  run('room', 'forgotten room', 'Ada', 'Bo', '--forget');
  run('room', 'sealed room', 'Ada', 'Bo', '--room-only');
  const rooms = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'rooms', 'rooms.json'), 'utf8')).rooms);
  const memory = Object.fromEntries(rooms.map((r) => [r.purpose, r.memory]));
  assert.deepEqual(memory, { 'default room': 'members', 'shared room': 'project', 'forgotten room': 'none', 'sealed room': 'room' });
  assert.match(run('help'), /--shared/);
});
