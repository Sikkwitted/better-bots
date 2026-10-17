import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireInstanceLock, InstanceLockError } from '../src/core/instance-lock.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bb-lock-'));

test('a second host on the same folder is refused; the first keeps its lock', () => {
  const dir = tmp();
  const release = acquireInstanceLock(dir, { pid: 111, alive: () => true });
  assert.throws(() => acquireInstanceLock(dir, { pid: 222, alive: () => true }), (error) => error instanceof InstanceLockError && /already running/.test(error.message) && /BETTER_BOTS_DIR/.test(error.message));
  assert.equal(fs.readFileSync(path.join(dir, '.better-bots.lock'), 'utf8'), '111');
  release();
  assert.equal(fs.existsSync(path.join(dir, '.better-bots.lock')), false);
});

test('a different folder is never affected', () => {
  const a = acquireInstanceLock(tmp(), { pid: 111, alive: () => true });
  const b = acquireInstanceLock(tmp(), { pid: 222, alive: () => true });
  a(); b();
});

test('a lock left by a crashed host is taken over', () => {
  const dir = tmp();
  acquireInstanceLock(dir, { pid: 111, alive: () => true }); // never released: the host "crashed"
  const release = acquireInstanceLock(dir, { pid: 222, alive: () => false });
  assert.equal(fs.readFileSync(path.join(dir, '.better-bots.lock'), 'utf8'), '222');
  release();
});

test('releasing never removes a lock a newer host has taken', () => {
  const dir = tmp();
  const first = acquireInstanceLock(dir, { pid: 111, alive: () => true });
  fs.writeFileSync(path.join(dir, '.better-bots.lock'), '222');
  first();
  assert.equal(fs.readFileSync(path.join(dir, '.better-bots.lock'), 'utf8'), '222');
});

test('the real server refuses a second start on the same folder before changing anything', async () => {
  const dir = tmp();
  const env = { ...process.env, BETTER_BOTS_DIR: dir, BETTER_BOTS_DESKTOP: 'placeholder', BETTER_BOTS_CODEX_AUTH_FILE: '/nonexistent/auth.json' };
  const start = (port) => spawn(process.execPath, ['src/server.js'], { env: { ...env, BETTER_BOTS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const first = start(47311);
  await new Promise((resolve, reject) => { first.stdout.on('data', (chunk) => { if (String(chunk).includes('store')) resolve(); }); first.on('exit', () => reject(new Error('first exited'))); setTimeout(() => reject(new Error('first never started')), 15000); });
  try {
    const second = start(47312);
    let err = ''; second.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((resolve) => second.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(err, /already running/);
    const audit = fs.existsSync(path.join(dir, 'audit.jsonl')) ? fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8') : '';
    assert.equal((audit.match(/host\.recovered/g) ?? []).length <= 1, true, 'the refused host ran no second recovery');
    // A different folder starts fine alongside the first.
    const other = spawn(process.execPath, ['src/server.js'], { env: { ...env, BETTER_BOTS_DIR: tmp(), BETTER_BOTS_PORT: '47313' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { other.stdout.on('data', (chunk) => { if (String(chunk).includes('store')) resolve(); }); other.on('exit', () => reject(new Error('other exited'))); setTimeout(() => reject(new Error('other never started')), 15000); });
    other.kill('SIGTERM');
  } finally { first.kill('SIGTERM'); }
  await new Promise((resolve) => first.on('exit', resolve));
  assert.equal(fs.existsSync(path.join(dir, '.better-bots.lock')), false, 'a clean shutdown releases the lock');
});
