import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, reopenHost, say, makeHost } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/crash-run.mjs', import.meta.url));
function killed(t, boundary) {
  const dir = tmpDir('crash-recovery');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fixture, dir, boundary], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  return dir;
}

for (const boundary of ['claimed', 'inbox_bound', 'before_transcript', 'transcript', 'delivery_committed']) {
  test(`SIGKILL after ${boundary}: recover the same run and deliver exactly once`, async (t) => {
    const dir = killed(t, boundary);
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'runs/queues.json')));
    const [before] = Object.values(ledger.runs);
    assert.equal(before.status, 'running');
    assert.equal(before.payload.kind, 'agent_wake');
    const { host, adapter } = reopenHost({ dir, script: () => [say('recovered')] });
    assert.equal(host.messages.get('msg_crash').status, boundary === 'delivery_committed' ? 'delivered' : 'queued');
    const recovery = host.recover();
    assert.equal(recovery.recovery_required.length, 0);
    assert.equal(recovery.queued_runs[0].run_id, before.id);
    host.recover();
    await host.drain();
    assert.equal(adapter.calls.length, 1);
    assert.equal(host.scheduler.durableRuns().find((r) => r.id === before.id).status, 'completed');
    assert.equal(host.messages.get('msg_crash').processing_run_id, before.id);
    assert.equal(host.transcripts.all('agent', 'agt_b').filter((e) => e.message_id === 'msg_crash' && e.kind === 'peer_message_in').length, 1);
    const { host: again, adapter: next } = reopenHost({ dir, script: () => [say('duplicate')] });
    again.recover();
    await again.drain();
    assert.equal(next.calls.length, 0);
  });
}

for (const boundary of ['execution_started', 'tool_pending', 'effect', 'tool_recorded']) {
  test(`SIGKILL after ${boundary}: preserve uncertain execution without replay`, async (t) => {
    const dir = killed(t, boundary);
    const { host, adapter } = reopenHost({ dir, script: () => [say('must not execute')] });
    const recovery = host.recover();
    assert.equal(recovery.recovery_required.length, 1);
    const run = recovery.recovery_required[0];
    assert.equal(run.payload.message_ids[0], 'msg_crash');
    assert.equal(host.status().recovery_required[0].id, run.id);
    assert.equal(host.explain(run.id).run.status, 'recovery_required');
    assert.equal(run.checkpoint.phase, boundary === 'effect' ? 'tool_pending' : boundary);
    if (boundary !== 'execution_started') assert.deepEqual(run.checkpoints.find((c) => c.phase === 'tool_pending').input, {});
    if (boundary === 'tool_recorded') assert.deepEqual(run.checkpoint.record.result, { ok: true });
    assert.equal(host.messages.get('msg_crash').processing_run_id, run.id);
    host.recover();
    await host.drain();
    assert.equal(adapter.calls.length, 0);
    assert.equal(host.transcripts.all('agent', 'agt_b').filter((e) => e.recovery_required).length, 1);
    const receipt = path.join(dir, 'effect.txt');
    assert.equal(fs.existsSync(receipt) ? fs.readFileSync(receipt, 'utf8') : '', ['effect', 'tool_recorded'].includes(boundary) ? 'effect\n' : '');
    const { host: again } = reopenHost({ dir });
    assert.equal(again.recover().recovery_required[0].id, run.id);
  });
}

test('SIGKILL after terminal state commit: completed run remains terminal without history finish', async (t) => {
  const dir = killed(t, 'completed');
  const { host, adapter } = reopenHost({ dir });
  assert.equal(host.recover().recovery_required.length, 0);
  await host.drain();
  assert.equal(adapter.calls.length, 0);
  assert.equal(host.scheduler.durableRuns()[0].status, 'completed');
  assert.equal(host.explain(host.scheduler.durableRuns()[0].id).run.status, 'completed');
  assert.equal(fs.readFileSync(path.join(dir, 'effect.txt'), 'utf8'), 'effect\n');
});

test('legacy pending runs migrate; legacy unfinished execution requires reconciliation', async (t) => {
  const { host, dir, clock } = makeHost();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const queued = host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'user', payload: { text: 'queued' } });
  host.scheduler.queues.write({ pending: { agt_a: [queued] } });
  host.scheduler.history.append({ ...queued, id: 'legacy_started', status: 'running', event: 'started' });
  const { host: reopened, adapter } = reopenHost({ dir, clock, script: () => [say('safe')] });
  const recovery = reopened.recover();
  assert.equal(recovery.recovery_required[0].id, 'legacy_started');
  await reopened.drain();
  assert.equal(adapter.calls.length, 1);
  assert.equal(reopened.scheduler.durableRuns().find((r) => r.id === queued.id).status, 'completed');
});


test('new messages behind a recovered bound batch get their own wake', async (t) => {
  const dir = killed(t, 'inbox_bound');
  const { host, adapter } = reopenHost({ dir, script: () => [say('handled')] });
  // A send committed just before the old process stopped, without its wake.
  host.messages.send({ sender_id: 'agt_a', target_id: 'agt_b', text: 'new work', message_id: 'msg_new' });
  host.recover();
  host.recover();
  assert.equal(host.scheduler.pendingRuns('agt_b').length, 2);
  await host.drain();
  assert.equal(adapter.calls.length, 2);
  assert.notEqual(host.messages.get('msg_new').processing_run_id, host.messages.get('msg_crash').processing_run_id);
  assert.equal(host.messages.pending('agt_b').length, 0);
  assert.deepEqual(adapter.calls.map((c) => c.payload.messages.map((m) => m.message_id)), [['msg_crash'], ['msg_new']]);
});


test('failure to persist execution checkpoint prevents model and tool execution', async (t) => {
  const { host, dir, adapter } = makeHost({ script: () => [say('must not run')] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'work' });
  const save = host.scheduler.save.bind(host.scheduler);
  host.scheduler.save = (record) => {
    if (record.status === 'running' && record.checkpoint?.phase === 'execution_started') throw new Error('disk unavailable');
    return save(record);
  };
  await host.drain();
  assert.equal(adapter.calls.length, 0);
  const durable = host.scheduler.durableRuns().find((r) => r.id === run.id);
  assert.equal(durable.status, 'failed');
  assert.equal(durable.error, 'disk unavailable');
});
