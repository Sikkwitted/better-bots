import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SharedFileService } from '../src/services/shared-file-service.js';
import { tmpDir } from './helpers.js';
const fixture = fileURLToPath(new URL('./fixtures/crash-shared-file.py', import.meta.url));
const worker = fileURLToPath(new URL('../src/services/shared-file-worker.py', import.meta.url));
function setup(t) {
  const dir = tmpDir('transaction-crash');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new SharedFileService({ workspace: path.join(dir, 'workspace'), state_dir: path.join(dir, 'transactions') });
  return { service, request: { workspace: service.workspace, state_dir: service.state_dir, actor: 'agt_a', path: 'shared/ledger.json', action: 'patch', operation_id: 'append-once', changes: [{ path: ['history'], expected: { exists: true, value: ['original'] }, value: ['original', 'once'] }] } };
}
for (const boundary of ['locked', 'prepared', 'staged', 'replaced', 'receipted']) {
  test(`SIGKILL at ${boundary}: recover complete content and retry exactly once`, async (t) => {
    const { service, request } = setup(t);
    const original = '{"history":["original"],"other":"preserve"}';
    await service.execute('agt_a', { action: 'write', path: request.path, content: original, expected_revision: 'missing', operation_id: 'initial' });
    const child = spawnSync(service.python, ['-B', fixture, worker, boundary], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const immediately = JSON.parse(fs.readFileSync(path.join(service.workspace, request.path)));
    assert.ok([1, 2].includes(immediately.history.length));
    assert.equal(immediately.other, 'preserve');
    const retry = await service.execute('agt_a', request);
    assert.equal(retry.ok, true);
    assert.equal(retry.duplicate, boundary !== 'locked');
    assert.equal((await service.execute('agt_a', request)).duplicate, true);
    const final = JSON.parse((await service.execute('agt_a', { action: 'read', path: request.path })).content);
    assert.deepEqual(final, { history: ['original', 'once'], other: 'preserve' });
  });
}

test('a live OS lock cannot be stolen and its holder dying releases it', async (t) => {
  const { service, request } = setup(t);
  await service.execute('agt_a', { action: 'write', path: request.path, content: '{"history":["original"]}', expected_revision: 'missing', operation_id: 'initial' });
  const holder = spawn(service.python, ['-B', fixture, worker, 'hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => holder.kill('SIGKILL'));
  holder.stdin.end(JSON.stringify(request));
  await once(holder.stdout, 'data');
  const blocked = await service.execute('agt_a', request);
  assert.equal(blocked.error, 'locked');
  assert.equal(holder.exitCode, null);
  const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited;
  assert.equal((await service.execute('agt_a', request)).ok, true);
});

test('recovery preserves an intervening administrative edit instead of replaying over it', async (t) => {
  const { service, request } = setup(t);
  await service.execute('agt_a', { action: 'write', path: request.path, content: '{"history":["original"]}', expected_revision: 'missing', operation_id: 'initial' });
  const child = spawnSync(service.python, ['-B', fixture, worker, 'prepared'], { input: JSON.stringify(request), encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL');
  const edited = '{"history":["manual edit"]}';
  fs.writeFileSync(path.join(service.workspace, request.path), edited);
  const retry = await service.execute('agt_a', request);
  assert.equal(retry.error, 'reconciliation_required');
  assert.equal(fs.readFileSync(path.join(service.workspace, request.path), 'utf8'), edited);
});
