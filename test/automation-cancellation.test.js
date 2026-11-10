import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHost, reopenHost, makeGate, tmpDir, call, say } from './helpers.js';
import { readPublicPage } from '../src/tools/web-tool.js';
import { MCPClient } from '../src/tools/mcp-client.js';

function setup(script = () => [say('done')]) {
  const made = makeHost({ script });
  for (const id of ['agt_a', 'agt_b']) made.host.registry.create({ id, profile: { name: id } });
  const item = made.host.scheduleAutomation({ agent_id: 'agt_a', text: 'work', every_ms: 60000 });
  return { ...made, item };
}
const ledger = (host, id) => host.scheduler.durableRuns().find((r) => r.id === id);

test('queued cancellation is durable, idempotent, fenced against new descendants, and preserves other work', async () => {
  const { host, item, dir, clock } = setup();
  const [run] = host.tickAutomations();
  const other = host.scheduleAutomation({ agent_id: 'agt_b', text: 'other' });
  host.tickAutomations();
  const result = host.cancelAutomation(item.id);
  assert.deepEqual(result.cancellation.cancelled_runs, [run.id]);
  assert.deepEqual(host.cancelAutomation(item.id).cancellation, result.cancellation);
  assert.throws(() => host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'agent', payload: { automation_id: item.id } }), /cancelled/);
  const reopened = reopenHost({ dir, clock, script: () => [say('survived')] });
  reopened.host.recover();
  await reopened.host.drain();
  assert.equal(ledger(reopened.host, run.id).status, 'cancelled');
  assert.equal(reopened.adapter.calls.length, 1);
  assert.equal(reopened.adapter.calls[0].payload.automation_id, other.id);
});

test('active model abort uses only its request signal and tombstone exists before abort', async () => {
  const started = makeGate();
  const { host, item, dir } = setup(async function* ({ settings, payload }) {
    if (payload.kind !== 'automation') { yield say('user remains'); return; }
    started.release();
    await new Promise((resolve) => settings.signal.addEventListener('abort', () => {
      assert.equal(reopenHost({ dir }).host.scheduler.isAutomationCancelled(item.id), true);
      resolve();
    }, { once: true }));
    yield say('late forbidden answer');
  });
  const [run] = host.tickAutomations();
  const pumping = host.scheduler.pump('agt_a');
  await started.promise;
  host.scheduler.enqueue({ agent_id: 'agt_b', lane: 'user', payload: { kind: 'user', text: 'hello' } });
  assert.deepEqual(host.cancelAutomation(item.id).cancellation.stopping_runs, [run.id]);
  await pumping;
  await host.drain();
  assert.equal(ledger(host, run.id).status, 'cancelled');
  assert.ok(!host.transcripts.all('agent', 'agt_a').some((e) => e.text === 'late forbidden answer'));
  assert.ok(host.visibleResults().some((r) => r.text === 'user remains'));
});

test('noninterruptible action remains stopping until receipt; failure remains uncertain and never replays', async () => {
  const entered = makeGate(), release = makeGate();
  const { host, item, dir } = setup(() => [call('PendingEffect', {}), call('Forbidden', {})]);
  let effects = 0;
  host.tools.register({ name: 'PendingEffect', description: 'test', side_effect: 'test effect', permission: null, input_schema: { type: 'object' }, handler: async () => {
    effects++; entered.release(); await release.promise; throw new Error('outcome unavailable');
  } });
  host.tools.register({ name: 'Forbidden', description: 'test', side_effect: 'test effect', permission: null, input_schema: { type: 'object' }, handler: () => { effects++; } });
  const [run] = host.tickAutomations();
  const pumping = host.scheduler.pump('agt_a'); await entered.promise;
  const result = host.cancelAutomation(item.id).cancellation;
  assert.deepEqual(result.stopping_runs, [run.id]);
  assert.equal(result.reconciliation_required[0].checkpoint.tool, 'PendingEffect');
  release.release(); await pumping;
  assert.equal(ledger(host, run.id).status, 'recovery_required');
  assert.equal(effects, 1);
  const reopened = reopenHost({ dir }); reopened.host.recover(); await reopened.host.drain();
  assert.equal(reopened.adapter.calls.length, 0);
  assert.equal(ledger(reopened.host, run.id).status, 'recovery_required');
});

test('successful in-flight receipt is retained without completion publication or the next tool', async () => {
  const entered = makeGate(), release = makeGate();
  const { host, item } = setup(() => [call('Effect', {}), call('AssembleResult', { conclusion: 'forbidden' })]);
  host.tools.register({ name: 'Effect', description: 'test', side_effect: 'test effect', permission: null, input_schema: { type: 'object' }, handler: async () => {
    entered.release(); await release.promise; return { ok: true, receipt: 'committed' };
  } });
  const [run] = host.tickAutomations(); const pumping = host.scheduler.pump('agt_a'); await entered.promise;
  host.cancelAutomation(item.id); release.release(); await pumping;
  assert.equal(ledger(host, run.id).status, 'cancelled');
  assert.equal(ledger(host, run.id).checkpoint.record.result.receipt, 'committed');
  assert.ok(!host.results.readAll().some((r) => r.kind === 'lead_result'));
  assert.throws(() => host.assembleResult({ lead_agent_id: 'agt_a', conclusion: 'late', run_id: run.id }), /cancelled/);
});

test('peer handoffs carry lineage and cancellation leaves unrelated inbox messages usable', async () => {
  const { host, item } = setup(() => [call('SendToAgent', { target_id: 'agt_b', message: 'owned task' })]);
  host.tickAutomations(); await host.scheduler.pump('agt_a');
  const owned = host.messages.pending('agt_b')[0];
  assert.equal(owned.automation_id, item.id);
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'unrelated' });
  assert.equal(host.scheduler.pendingRuns('agt_b').length, 2);
  host.cancelAutomation(item.id); await host.scheduler.pump('agt_b');
  assert.equal(host.messages.get(owned.id).status, 'cancelled');
  assert.ok(!host.transcripts.all('agent', 'agt_b').some((e) => e.message_id === owned.id));
  assert.ok(host.transcripts.all('agent', 'agt_b').some((e) => e.text === 'unrelated'));
});

test('continuations and priority restarts retain automation ownership', async () => {
  const { host, adapter, item } = setup();
  let steps = 0; // each call returns something new: budget exhaustion, not a loop (LOOP_STOP_AFTER)
  host.tools.register({ name: 'Again', description: 'test', side_effect: 'test effect', permission: null, input_schema: { type: 'object' }, handler: () => ({ ok: true, step: ++steps }) });
  adapter.script = () => [call('Again', {})];
  const enqueue = host.scheduler.enqueue.bind(host.scheduler);
  let continuation;
  host.scheduler.enqueue = (args) => {
    const run = enqueue(args);
    if (args.payload.kind === 'continue') { continuation = run; host.cancelAutomation(item.id); }
    return run;
  };
  host.tickAutomations(); await host.drain();
  assert.equal(continuation.payload.automation_id, item.id);
  assert.ok(continuation.payload.parent_run_id);
  assert.equal(ledger(host, continuation.id).status, 'cancelled');

  const gate = makeGate(), entered = makeGate();
  const another = setup(async function* ({ settings }) { entered.release(); await gate.promise; settings.signal.throwIfAborted(); });
  another.host.tickAutomations(); const pumping = another.host.scheduler.pump('agt_a'); await entered.promise;
  another.host.scheduler.interrupt('agt_a', { reason: 'time_critical' });
  another.host.cancelAutomation(another.item.id); gate.release(); await pumping;
  assert.equal(another.host.scheduler.durableRuns().length, 1);
});

test('already completed runs and published results survive cancellation', async () => {
  const { host, item } = setup();
  const [run] = host.tickAutomations(); await host.drain();
  const packet = host.assembleResult({ lead_agent_id: 'agt_a', conclusion: 'done', run_id: run.id });
  host.cancelAutomation(item.id);
  assert.equal(ledger(host, run.id).status, 'completed');
  assert.ok(host.results.readAll().some((p) => p.id === packet.id));
});

for (const phase of ['tombstone', 'signalled', 'effect']) {
  test(`SIGKILL after ${phase}: restart fences execution and reconciles unfinished actions`, async () => {
    const dir = tmpDir('cancel-crash');
    const child = spawnSync(process.execPath, [new URL('./fixtures/crash-automation.mjs', import.meta.url).pathname, dir, phase]);
    assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
    const { host, adapter } = reopenHost({ dir }); host.recover(); await host.drain();
    assert.equal(adapter.calls.length, 0);
    assert.equal(host.tickAutomations().length, 0);
    const run = host.scheduler.durableRuns()[0];
    assert.equal(run.status, phase === 'effect' ? 'recovery_required' : 'cancelled');
    assert.equal(fs.existsSync(path.join(dir, 'effect')), phase === 'effect');
    assert.equal(host.automationCancellations()[0].requested, true);
  });
}

test('public reader and HTTP MCP requests receive scoped cancellation', async () => {
  for (const kind of ['web', 'mcp']) {
    const started = makeGate(), controller = new AbortController();
    const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); started.release();
    });
    const promise = kind === 'web'
      ? readPublicPage('https://8.8.8.8', { fetchImpl, signal: controller.signal })
      : new MCPClient({ transport: 'http', url: 'https://example.test' }, { fetchImpl }).callTool('work', {}, { signal: controller.signal });
    const rejected = assert.rejects(promise, /cancelled/);
    await started.promise; controller.abort(); await rejected;
  }
});

test('active sandbox shell is killed and cannot execute its delayed follow-up', { timeout: 10000 }, async () => {
  const { host, item } = setup(() => [call('SandboxRunCommand', { command: 'echo started > started; sleep 3; echo forbidden > late', timeout_ms: 9000 })]);
  const [run] = host.tickAutomations(); const pumping = host.scheduler.pump('agt_a');
  const marker = path.join(host.workspace, 'agents', 'agt_a', 'started');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(marker), 'real shell started');
  host.cancelAutomation(item.id); await pumping;
  assert.equal(ledger(host, run.id).checkpoint.record.result.cancelled, true);
  assert.equal(ledger(host, run.id).status, 'recovery_required');
  assert.equal(fs.existsSync(path.join(path.dirname(marker), 'late')), false);
});

test('cancellation while approval is awaited cannot start the tool', async () => {
  const { host, item } = setup(() => [call('LocalWriteFile', { path: '/tmp/never-write-gap4', content: 'forbidden' })]);
  host.approval_mode = 'wait';
  host.permissions.setStandingMode('local', 'ask'); // cards appear only where the person chose Ask
  const authorize = host.permissions.authorize.bind(host.permissions);
  const entered = makeGate();
  host.permissions.authorize = (args) => { const result = authorize(args); if (result.decision === 'ask') entered.release(); return result; };
  host.tickAutomations(); const pumping = host.scheduler.pump('agt_a');
  await entered.promise; host.cancelAutomation(item.id); await pumping;
  assert.ok(!host.audit.where((e) => e.type === 'tool.executed' && e.name === 'LocalWriteFile').length);
});

test('stdio cancellation targets one request without terminating the shared MCP server', async () => {
  const client = new MCPClient({ transport: 'stdio', command: process.execPath, args: ['-e', `
    const rl = require('node:readline').createInterface({input: process.stdin});
    let cancelled;
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'notifications/cancelled') { cancelled = m.params.requestId; return; }
      if (m.method === 'tools/call' && m.params.name === 'wait') return;
      if (m.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text: String(cancelled ?? 'ready')}]}})+'\\n');
    });
  `] });
  try {
    await client.connect();
    const controller = new AbortController();
    const waiting = client.callTool('wait', {}, { signal: controller.signal });
    const requestId = client.nextId - 1;
    const rejected = assert.rejects(waiting, /cancelled/);
    controller.abort(); await rejected;
    const result = await client.callTool('inspect');
    assert.match(JSON.stringify(result), new RegExp(String(requestId)));
    assert.equal(client.pending.size, 0);
    assert.ok(client.child);
  } finally { await client.close(); }
});

test('cancelling queued automation preserves an active user turn on the same agent', async () => {
  const entered = makeGate(), release = makeGate();
  let userSignal;
  const { host, item } = setup(async function* ({ settings }) {
    userSignal = settings.signal; entered.release(); await release.promise; yield say('user completed');
  });
  host.userRequest({ agent_id: 'agt_a', text: 'user work' });
  const pumping = host.scheduler.pump('agt_a'); await entered.promise;
  const [run] = host.tickAutomations(); host.cancelAutomation(item.id);
  assert.equal(userSignal.aborted, false);
  release.release(); await pumping;
  assert.equal(ledger(host, run.id).status, 'cancelled');
  assert.ok(host.visibleResults().some((r) => r.status === 'completed' && r.text === 'user completed'));
});
