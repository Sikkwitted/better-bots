import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MemoryService } from '../src/services/memory-service.js';
import { SqliteEngine, ftsQuery, redactSecrets } from '../src/services/sqlite-engine.js';
import { engineFromEnv, HindsightEngine } from '../src/services/memory-engine.js';
import { AuditLog } from '../src/core/audit.js';
import { fixedClock } from '../src/core/clock.js';
import { tmpDir } from './helpers.js';

function service(dir = tmpDir()) {
  const clock = fixedClock();
  const audit = new AuditLog({ file: path.join(dir, 'audit.jsonl'), clock });
  const engine = SqliteEngine.open({ file: path.join(dir, 'memory', 'memory.sqlite') });
  return { memory: new MemoryService({ dir, clock, audit, engine }), engine, audit, dir };
}

test('SQLite is the default engine and needs nothing installed; Hindsight only when named', () => {
  const dir = tmpDir();
  assert.equal(engineFromEnv({}, { dir })?.name, 'sqlite');
  assert.ok(engineFromEnv({ HINDSIGHT_URL: 'http://127.0.0.1:8888' }, { dir }) instanceof HindsightEngine);
  assert.equal(engineFromEnv({ BETTER_BOTS_MEMORY_ENGINE: 'local' }, { dir }), null);
  assert.equal(engineFromEnv({ BETTER_BOTS_MEMORY_ENGINE: 'sqlite', HINDSIGHT_URL: 'http://x' }, { dir })?.name, 'sqlite');
  assert.throws(() => engineFromEnv({ BETTER_BOTS_MEMORY_ENGINE: 'hindsight' }, { dir }), /needs HINDSIGHT_URL/);
});

test('recall matches word forms, not only exact spelling, and reports the engine', async () => {
  const { memory } = service();
  memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'Bo owns the TLS certificate renewal for the website' });
  memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'The office plants are watered on Fridays' });
  await memory.flush();
  const recall = await memory.recall({ agent_id: 'agt_a', query: 'who is renewing the certificates?' });
  assert.equal(recall.engine, 'sqlite');
  assert.match(recall.facts[0].text, /TLS certificate renewal/);
});

test('one agent never recalls another agent\'s private memory through the engine', async () => {
  const { memory } = service();
  memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'Ada private launch codename is Bluebird' });
  await memory.flush();
  const recall = await memory.recall({ agent_id: 'agt_b', query: 'launch codename Bluebird' });
  assert.ok(!recall.facts.some((f) => /Bluebird/.test(f.text)));
  const searched = await memory.search({ agent_id: 'agt_b', scope: 'agent', owner_id: 'agt_b', query: 'Bluebird' });
  assert.equal(searched.length, 0);
});

test('retained exchanges are searchable too, and saving the same document twice keeps one copy', async () => {
  const { memory, engine } = service();
  memory.retainExchange({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', content: 'Alex asked for the quarterly invoice to go to Dana', context: 'exchange', ref: { run_id: 'run_1' } });
  await memory.flush();
  await engine.retain('agent-agt_a', { content: 'again', document_id: 'same' });
  await engine.retain('agent-agt_a', { content: 'again', document_id: 'same' });
  const hits = await engine.recall('agent-agt_a', { query: 'invoice Dana' });
  assert.match(hits[0].text, /quarterly invoice/);
  assert.equal((await engine.recall('agent-agt_a', { query: 'again' })).length, 1);
});

test('secrets are redacted before they are stored', async () => {
  const { engine } = service();
  await engine.retain('user-user', { content: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123', document_id: 'd' });
  const [hit] = await engine.recall('user-user', { query: 'my key' });
  assert.doesNotMatch(hit.text, /sk-ant-|ghp_/);
  assert.equal(redactSecrets('password: hunter2hunter2'), '[redacted]');
});

test('any typed query is safe: punctuation and FTS operators never become syntax errors', async () => {
  const { engine } = service();
  await engine.retain('agent-x', { content: 'plain words here', document_id: 'd' });
  for (const q of ['"unbalanced', 'NEAR( AND OR NOT *', 'col:value', '', '?!']) await engine.recall('agent-x', { query: q });
  assert.equal(ftsQuery('the and of'), null);
  assert.equal(ftsQuery('Words, words!'), '"words"');
});

test('the engine survives a reopen: memory lives in the data folder', async () => {
  const dir = tmpDir();
  const first = service(dir);
  first.memory.remember({ scope: 'project', owner_id: 'default', writer_agent_id: 'agt_a', text: 'Deploys happen on Tuesdays' });
  await first.memory.flush();
  first.engine.close();
  const second = service(dir);
  const recall = await second.memory.recall({ agent_id: 'agt_a', scopes: [{ scope: 'project', owner_id: 'default' }], query: 'when do deploys happen' });
  assert.ok(recall.facts.some((f) => /Tuesdays/.test(f.text)));
});

test('an async engine never has more than two extraction jobs outstanding at once', async () => {
  const { MAX_IN_FLIGHT } = await import('../src/services/memory-retention.js');
  const dir = tmpDir();
  const clock = fixedClock();
  const audit = new AuditLog({ file: path.join(dir, 'audit.jsonl'), clock });
  let done = false;
  let dispatched = 0;
  const engine = {
    name: 'fake-async', supportsAsyncRetention: true,
    async ensureBank() { return true; },
    async retain(bank, item) { dispatched += 1; return { success: true, async: true, operation_id: item.operation_id }; },
    async retentionStatus(bank, id) { return { status: done ? 'completed' : 'pending', operation_id: id }; },
    async recall() { return []; },
  };
  const memory = new MemoryService({ dir, clock, audit, engine });
  for (let i = 0; i < 6; i += 1) memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: `fact ${i}` });
  await memory.flush();
  assert.equal(MAX_IN_FLIGHT, 2);
  assert.equal(dispatched, 2, 'the backlog waits instead of flooding the engine model');
  done = true;
  for (let i = 0; i < 6; i += 1) { clock.advance(120_000); await memory.retention.kick(); }
  assert.equal(dispatched, 6);
  assert.equal(memory.retention.status().unfinished.length, 0);
});

test('a host on SQLite memory reports healthy, not degraded, even when memory is required', async () => {
  const { checkedHealthSnapshot } = await import('../src/core/health.js');
  const { makeHost } = await import('./helpers.js');
  const { host, dir } = makeHost();
  host.memory.engine = SqliteEngine.open({ file: path.join(dir, 'memory', 'memory.sqlite') });
  host.memoryRequired = true;
  const snapshot = await checkedHealthSnapshot({ host });
  assert.deepEqual(snapshot.dependencies.memory, { required: true, configured: true, healthy: true });
  assert.ok(!snapshot.signals.state.some((e) => /memory_engine/.test(e.type)));
});
