import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SharedFileService } from '../src/services/shared-file-service.js';
import { makeHost, tmpDir } from './helpers.js';

function setup(t) {
  const dir = tmpDir('shared-transactions');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new SharedFileService({ workspace: path.join(dir, 'workspace'), state_dir: path.join(dir, 'transactions') });
  return { dir, service, transact: (input, actor = 'agt_a') => service.execute(actor, { path: 'shared/state.json', ...input }) };
}
const create = (content = '{}') => ({ action: 'write', content, expected_revision: 'missing', operation_id: 'create' });
const change = (key, value, previous, exists = true) => ({ path: [key], value, expected: { exists, ...(exists ? { value: previous } : {}) } });

test('concurrent processes preserve independent field updates and reject conflicting ones', async (t) => {
  const { transact } = setup(t);
  assert.equal((await transact(create('{"a":0,"b":0,"history":["keep"],"id":"stable"}'))).ok, true);
  const both = await Promise.all([
    transact({ action: 'patch', operation_id: 'a', changes: [change('a', 1, 0)] }),
    transact({ action: 'patch', operation_id: 'b', changes: [change('b', 2, 0)] }, 'agt_b'),
  ]);
  assert.ok(both.every((r) => r.ok));
  const conflicting = await Promise.all([
    transact({ action: 'patch', operation_id: 'a2', changes: [change('a', 2, 1)] }),
    transact({ action: 'patch', operation_id: 'a3', changes: [change('a', 3, 1)] }),
  ]);
  assert.equal(conflicting.filter((r) => r.ok).length, 1);
  assert.equal(conflicting.find((r) => !r.ok).error, 'conflict');
  const state = JSON.parse((await transact({ action: 'read' })).content);
  assert.equal(state.b, 2); assert.deepEqual(state.history, ['keep']); assert.equal(state.id, 'stable');
});

test('whole-file replacement requires a fresh revision and operation receipt', async (t) => {
  const { transact } = setup(t);
  const first = await transact(create());
  assert.equal((await transact({ action: 'write', content: '{}', operation_id: 'no-revision' })).error, 'revision_required');
  assert.equal((await transact({ action: 'write', content: '{}', expected_revision: first.revision })).error, 'operation_id_required');
  const next = { action: 'write', content: '{"new":1}', expected_revision: first.revision, operation_id: 'replace' };
  const commit = await transact(next);
  assert.equal(commit.ok, true);
  assert.equal((await transact({ ...next, operation_id: 'stale' })).error, 'conflict');
  assert.equal((await transact(next)).duplicate, true);
  assert.equal((await transact({ ...next, content: '{"different":1}' })).error, 'idempotency_conflict');
  assert.equal((await transact({ action: 'read' })).content, next.content);
});

test('existing content is preserved; malformed JSON and conflicting multi-field patches never reset it', async (t) => {
  const { service, transact } = setup(t);
  fs.mkdirSync(path.join(service.workspace, 'shared'));
  const existing = '{"first":1,"second":2}\n';
  fs.writeFileSync(path.join(service.workspace, 'shared/state.json'), existing);
  const before = await transact({ action: 'read' });
  assert.equal(before.content, existing);
  const bad = await transact({ action: 'patch', operation_id: 'bad', changes: [change('first', 3, 1), change('second', 4, 999)] });
  assert.equal(bad.error, 'conflict');
  assert.equal((await transact({ action: 'read' })).content, existing);
  assert.equal((await transact({ ...create('not JSON'), expected_revision: before.revision })).error, 'invalid_json');
  assert.equal((await transact({ action: 'read' })).content, existing);
});

test('ownership applies to paths, nested records, and whole-file replacements', async (t) => {
  const { transact } = setup(t);
  const original = '{"records":{"a":{"owner_agent_id":"agt_a","value":1},"b":{"owner_agent_id":"agt_b","value":2}}}';
  const first = await transact(create(original));
  assert.equal((await transact({ action: 'patch', operation_id: 'steal', changes: [{ path: ['records', 'b', 'value'], expected: { exists: true, value: 2 }, value: 3 }] })).error, 'not_yours');
  assert.equal((await transact({ action: 'write', content: '{}', operation_id: 'erase', expected_revision: first.revision })).ok, false);
  assert.equal((await transact({ ...create(), path: 'agents/agt_b/note.json' })).error, 'not_yours');
  assert.equal((await transact({ action: 'write', path: 'agents/agt_a/note.txt', content: 'mine', operation_id: 'mine' })).ok, true);
  assert.equal((await transact({ action: 'read' })).content, original);
});

test('symlinks, hardlinks, parent traversal, and case aliases cannot bypass a transaction boundary', async (t) => {
  const { service, transact } = setup(t);
  await transact(create());
  const shared = path.join(service.workspace, 'shared');
  fs.symlinkSync(shared, path.join(service.workspace, 'alias'));
  fs.symlinkSync(path.join(shared, 'state.json'), path.join(shared, 'symbol.json'));
  for (const name of ['alias/state.json', 'shared/symbol.json', 'shared/../shared/state.json', 'Shared/state.json']) {
    assert.equal((await transact({ ...create(), path: name })).ok, false, name);
  }
  fs.linkSync(path.join(shared, 'state.json'), path.join(shared, 'hard.json'));
  assert.equal((await transact({ action: 'read' })).error, 'unsafe_file_alias');
  assert.equal((await transact({ ...create(), path: 'shared/hard.json' })).error, 'unsafe_file_alias');
});

test('LocalWriteFile cannot replace sandbox state without its revision contract', async (t) => {
  const { host, dir } = makeHost();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agent = host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  await host.files.execute(agent.id, { path: 'shared/x.json', ...create() });
  const local = host.tools.get('LocalWriteFile');
  const result = await local.handler({ agent, input: { path: path.join(host.workspace, 'shared/x.json'), content: '{"bypass":1}' } });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(host.workspace, 'shared/x.json'), 'utf8'), '{}');
});

test('nested record ownership cannot be bypassed through an array or a non-json filename', async (t) => {
  const { transact } = setup(t);
  const content = '{"items":[{"record":{"owner_agent_id":"agt_b","value":1}}]}';
  const first = await transact({ ...create(content), path: 'shared/records.txt' });
  assert.equal(first.ok, true);
  for (const replacement of ['{}', 'not json']) {
    const result = await transact({ action: 'write', path: 'shared/records.txt', content: replacement, expected_revision: first.revision, operation_id: replacement });
    assert.equal(result.ok, false);
  }
  assert.equal((await transact({ action: 'read', path: 'shared/records.txt' })).content, content);
});
