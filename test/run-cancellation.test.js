import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHost, reopenHost, makeGate, tmpDir, call, say } from './helpers.js';
import { createServer } from '../src/server.js';

const ledger = (host, id) => host.scheduler.durableRuns().find((r) => r.id === id);
function setup(script) {
  const made = makeHost({ script });
  made.host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  return made;
}

test('queued run and its continuation chain cancel durably without cancelling unrelated requests', async () => {
  const { host, dir } = setup(() => [say('other')]);
  const root = host.userRequest({ agent_id: 'agt_a', text: 'cancel me' });
  const child = host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'user', payload: { kind: 'continue', parent_run_id: root.id } });
  const other = host.userRequest({ agent_id: 'agt_a', text: 'keep me' });
  assert.throws(() => host.scheduler.cancelRun(root.id, { actor: 'agent' }), /only the user/);
  const cancelled = host.scheduler.cancelRun(child.id);
  assert.equal(cancelled.root_run_id, root.id);
  assert.deepEqual(cancelled.runs.map((r) => r.status), ['cancelled', 'cancelled']);
  assert.deepEqual(host.scheduler.cancelRun(root.id).runs, cancelled.runs);
  assert.throws(() => host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'user', payload: { kind: 'continue', parent_run_id: child.id } }), /cancelled/);
  const reopened = reopenHost({ dir }); reopened.host.recover(); await reopened.host.drain();
  assert.equal(reopened.adapter.calls.length, 1);
  assert.equal(ledger(reopened.host, other.id).status, 'completed');
  assert.equal(ledger(reopened.host, root.id).status, 'cancelled');
});

test('user stop aborts only its stream; peer stop still cannot interrupt the user', async () => {
  const started = makeGate();
  const { host, dir } = setup(async function* ({ settings }) {
    started.release();
    await new Promise((resolve) => settings.signal.addEventListener('abort', () => {
      assert.equal(reopenHost({ dir }).host.scheduler.isRunCancelled(ledger(host, settings.run_id)), true);
      resolve();
    }, { once: true }));
    yield say('late forbidden text');
  });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'go' });
  const pumping = host.scheduler.pump('agt_a'); await started.promise;
  assert.equal(host.scheduler.interrupt('agt_a', { reason: 'stop' }).why, 'user_lane_protected');
  assert.equal(host.scheduler.cancelRun(run.id).runs[0].status, 'cancelling');
  await pumping;
  assert.equal(ledger(host, run.id).status, 'cancelled');
  assert.ok(!host.transcripts.all('agent', 'agt_a').some((e) => e.text === 'late forbidden text'));
});

test('stopping at real continuation admission fences the automatic follow-up', async () => {
  const { host, adapter, dir } = setup();
  let steps = 0; // each call returns something new: budget exhaustion, not a loop (LOOP_STOP_AFTER)
  host.tools.register({ name: 'Again', description: 'fixture', side_effect: 'fixture', permission: null,
    input_schema: { type: 'object' }, handler: () => ({ ok: true, step: ++steps }) });
  adapter.script = () => [call('Again', {})];
  const enqueue = host.scheduler.enqueue.bind(host.scheduler);
  let child;
  host.scheduler.enqueue = (args) => {
    const next = enqueue(args);
    if (args.payload.kind === 'continue') { child = next; host.scheduler.cancelRun(next.id); }
    return next;
  };
  const run = host.userRequest({ agent_id: 'agt_a', text: 'work' });
  await host.drain();
  assert.ok(child);
  assert.equal(ledger(host, run.id).status, 'cancelled');
  assert.equal(ledger(host, child.id).status, 'cancelled');
  const reopened = reopenHost({ dir }); reopened.host.recover(); await reopened.host.drain();
  assert.equal(reopened.adapter.calls.length, 0);
});

for (const success of [true, false]) {
  test(`stop during an effect preserves ${success ? 'successful receipt' : 'uncertainty'} and prevents the next action`, async () => {
    const entered = makeGate(), release = makeGate();
    const { host, dir } = setup(() => [call('Effect', {}), call('Forbidden', {})]);
    let effects = 0;
    host.tools.register({ name: 'Effect', description: 'test effect', side_effect: 'test effect', permission: null, input_schema: { type: 'object' }, side_effect: 'test', handler: async () => {
      effects++; entered.release(); await release.promise;
      if (!success) throw new Error('unknown outcome');
      return { ok: true, receipt: 'committed' };
    } });
    host.tools.register({ name: 'Forbidden', description: 'test effect', side_effect: 'test effect', permission: null, input_schema: { type: 'object' }, handler: () => { effects++; } });
    const run = host.userRequest({ agent_id: 'agt_a', text: 'go' });
    const pumping = host.scheduler.pump('agt_a'); await entered.promise;
    host.scheduler.cancelRun(run.id); release.release(); await pumping;
    assert.equal(effects, 1);
    assert.equal(ledger(host, run.id).status, success ? 'cancelled' : 'recovery_required');
    if (success) assert.equal(ledger(host, run.id).checkpoint.record.result.receipt, 'committed');
    else {
      const item = host.reconciliation.list().find((i) => i.id === run.id);
      assert.ok(item);
      assert.throws(() => host.reconciliation.resolve({ kind: 'run', id: run.id, expected_revision: item.revision,
        outcome: 'confirmed_not_executed', evidence: 'operator checked', request_id: 'retry' }), /cancelled run/);
    }
    assert.throws(() => host.assembleResult({ lead_agent_id: 'agt_a', run_id: run.id, conclusion: 'late' }), /cancelled/);
    const reopened = reopenHost({ dir }); reopened.host.recover(); await reopened.host.drain();
    assert.equal(reopened.adapter.calls.length, 0);
  });
}

test('cancellation while approval is pending cannot dispatch the action', async () => {
  const { host } = setup(() => [call('LocalWriteFile', { path: '/tmp/forbidden-cancel-probe', content: 'no' })]);
  host.approval_mode = 'wait';
  host.permissions.setStandingMode('local', 'ask'); // cards appear only where the person chose Ask
  const entered = makeGate();
  const authorize = host.permissions.authorize.bind(host.permissions);
  host.permissions.authorize = (args) => { const r = authorize(args); if (r.decision === 'ask') entered.release(); return r; };
  const run = host.userRequest({ agent_id: 'agt_a', text: 'go' });
  const pumping = host.scheduler.pump('agt_a'); await entered.promise;
  host.scheduler.cancelRun(run.id); await pumping;
  assert.equal(ledger(host, run.id).status, 'cancelled');
  assert.equal(host.permissions.pendingRequests().length, 0);
  assert.equal(host.audit.where((e) => e.type === 'tool.executed').length, 0);
});

test('real sandbox process abort prevents its delayed write', { timeout: 15000 }, async () => {
  const { host } = setup(() => [call('SandboxRunCommand', { command: 'echo ready > started; sleep 5; echo no > late', timeout_ms: 10000 })]);
  const run = host.userRequest({ agent_id: 'agt_a', text: 'go' });
  const pumping = host.scheduler.pump('agt_a');
  const marker = path.join(host.workspace, 'agents', 'agt_a', 'started');
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(marker), 'real shell must start');
  host.scheduler.cancelRun(run.id); await pumping;
  assert.equal(ledger(host, run.id).checkpoint.record.result.cancelled, true);
  assert.equal(ledger(host, run.id).status, 'recovery_required');
  assert.equal(fs.existsSync(path.join(path.dirname(marker), 'late')), false);
});

for (const agentStop of [false, true]) {
test(`HTTP ${agentStop ? 'agent Stop' : 'run cancellation'} exposes stopping and final cancellation`, async () => {
  const entered = makeGate();
  const { host } = setup(async function* ({ settings }) {
    entered.release(); await new Promise((r) => settings.signal.addEventListener('abort', r, { once: true }));
  });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'go' });
  const pumping = host.scheduler.pump('agt_a'); await entered.promise;
  const server = createServer({ host, live: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${agentStop ? '/api/agents/stop' : '/api/runs/cancel'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(agentStop ? { agent_id: 'agt_a' } : { run_id: run.id }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal((agentStop ? result.cancellations[0] : result).runs[0].status, 'cancelling');
    await pumping;
    assert.equal(host.status().agents[0].last_cancellation, 'cancelled');
  } finally { await new Promise((r) => server.close(r)); }
});
}

for (const phase of ['tombstone', 'signalled', 'effect']) {
  test(`SIGKILL after ${phase}: user cancellation survives restart`, async () => {
    const dir = tmpDir('run-cancel-crash');
    const child = spawnSync(process.execPath, [new URL('./fixtures/crash-user-cancel.mjs', import.meta.url).pathname, dir, phase]);
    assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
    const { host, adapter } = reopenHost({ dir }); host.recover(); host.recover(); await host.drain();
    assert.equal(adapter.calls.length, 0);
    assert.equal(host.scheduler.durableRuns()[0].status, phase === 'effect' ? 'recovery_required' : 'cancelled');
  });
}


test('stop does not reread the entire ledger once per historical run', () => {
  const { host } = setup();
  const run = host.userRequest({ agent_id: 'agt_a', text: 'stop' });
  host.scheduler.queues.update(state => {
    for (let i = 0; i < 200; i++) state.runs[`old_${i}`] = {
      id: `old_${i}`, agent_id: 'agt_a', status: 'completed', payload: {},
    };
    return state;
  });
  const read = host.scheduler.queues.read.bind(host.scheduler.queues);
  let reads = 0;
  host.scheduler.queues.read = () => { reads++; return read(); };
  const result = host.scheduler.cancelRun(run.id);
  assert.equal(result.requested, true);
  assert.equal(result.runs[0].status, 'cancelled');
  assert.ok(reads < 30, `Stop performed ${reads} full ledger reads`);
});


test('agent Stop finds current and queued work on the server without a client run snapshot', () => {
  const { host } = setup();
  host.registry.create({ id: 'agt_b', profile: { name: 'Other' } });
  const first = host.userRequest({ agent_id: 'agt_a', text: 'first' });
  const latest = host.userRequest({ agent_id: 'agt_a', text: 'new since refresh' });
  const other = host.userRequest({ agent_id: 'agt_b', text: 'unrelated' });
  host.scheduler.cancelAgent('agt_a');
  assert.equal(ledger(host, first.id).status, 'cancelled');
  assert.equal(ledger(host, latest.id).status, 'cancelled');
  assert.equal(ledger(host, other.id).status, 'queued');
});
