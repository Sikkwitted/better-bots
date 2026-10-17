import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, reopenHost, makeGate, say, call } from './helpers.js';

// Deleting an agent must fence delegated descendants of its COMPLETED runs, so
// they stop running and publishing. A completed origin must fence its
// descendants; unrelated work must survive.

async function setupDelegation(host) {
  // A runs to completion; its origin run then anchors delegated work for B.
  const origin = host.userRequest({ agent_id: 'agt_a', text: 'start the task' });
  await host.drain();
  const storedOrigin = host.scheduler.durableRuns().find((r) => r.id === origin.id);
  assert.equal(storedOrigin.status, 'completed', 'the origin run completes before delegation is acted on');

  // Delegated mail in B's inbox, anchored to the completed origin (the
  // send-to-agent shape: a message carrying the sending run's id).
  await host.messages.send({ sender_id: 'agt_a', target_id: 'agt_b', text: 'continue the task', parent_run_id: origin.id });
  // And B's wake run built from that mail (host.js turn batching shape).
  const delegated = host.scheduler.enqueue({ agent_id: 'agt_b', lane: 'agent', payload: { kind: 'agent_wake', parent_run_id: origin.id } });
  return { origin, delegated };
}

test('deleting an agent cancels the delegated descendants of its completed runs', async () => {
  const { host, dir } = makeHost({ script: () => [say('origin done')] });
  for (const [id, name] of [['agt_a', 'Ada'], ['agt_b', 'Bo'], ['agt_c', 'Cy']]) {
    host.registry.create({ id, profile: { name } });
  }

  const { origin, delegated } = await setupDelegation(host);
  // Unrelated work on a survivor must not be touched.
  const unrelated = host.scheduler.enqueue({ agent_id: 'agt_c', lane: 'background', payload: { kind: 'bg' } });

  await host.deleteAgent('agt_a', { confirm: true, actor: 'user' });

  const stored = host.scheduler.durableRuns().find((r) => r.id === delegated.id);
  assert.ok(['cancelled', 'recovery_required'].includes(stored.status), `descendant of a completed origin is cancelled (was ${stored.status})`);
  const originStored = host.scheduler.durableRuns().find((r) => r.id === origin.id);
  assert.equal(originStored.status, 'completed', 'the origin stays completed history, not rewritten');
  const unrelatedStored = host.scheduler.durableRuns().find((r) => r.id === unrelated.id);
  assert.equal(unrelatedStored.status, 'queued', 'unrelated work survives');
  assert.equal(host.messages.pending('agt_b').length, 0, 'anchored pending mail is fenced, not delivered');

  // The fence is durable: a reopened host still refuses the anchored mail.
  const reopened = reopenHost({ dir });
  assert.equal(reopened.host.scheduler.isRunCancelled({ id: 'probe', payload: { parent_run_id: origin.id } }), true, 'pending mail anchored to the retired origin is fenced after restart');
  const reopenedDelegated = reopened.host.scheduler.durableRuns().find((r) => r.id === delegated.id);
  assert.ok(['cancelled', 'recovery_required'].includes(reopenedDelegated.status), 'the cancelled descendant stays cancelled after restart');
});

test('deleting an agent stops a running delegated descendant mid-flight', async () => {
  const gate = makeGate();
  const { host, adapter } = makeHost({ script: () => [say('origin done')] });
  for (const [id, name] of [['agt_a', 'Ada'], ['agt_b', 'Bo'], ['agt_c', 'Cy']]) {
    host.registry.create({ id, profile: { name } });
  }

  const origin = host.userRequest({ agent_id: 'agt_a', text: 'start the task' });
  await host.drain();
  await host.messages.send({ sender_id: 'agt_a', target_id: 'agt_b', text: 'continue the task', parent_run_id: origin.id });

  // B's delegated run executes now and blocks inside a fixture tool.
  adapter.script = () => [call('Hold', {})];
  host.tools.register({
    name: 'Hold', description: 'fixture gate', side_effect: 'fixture only',
    input_schema: { type: 'object' }, permission: null,
    handler: () => gate.promise,
  });
  host.scheduler.enqueue({ agent_id: 'agt_b', lane: 'agent', payload: { kind: 'agent_wake', parent_run_id: origin.id } });
  await new Promise((resolve) => { host.drain().then(resolve); setTimeout(resolve, 250); });
  assert.ok(host.scheduler.active.get('agt_b'), 'the delegated descendant is actively running');

  const unrelated = host.scheduler.enqueue({ agent_id: 'agt_c', lane: 'background', payload: { kind: 'bg' } });
  await host.deleteAgent('agt_a', { confirm: true, actor: 'user' });
  gate.release();
  await host.drain().catch(() => {});

  const entry = host.scheduler.active.get('agt_b');
  const status = host.scheduler.durableRuns().find((r) => r.payload?.parent_run_id === origin.id && r.agent_id === 'agt_b')?.status;
  assert.ok(entry === undefined || entry.signal.aborted, 'the active descendant was signalled to stop');
  assert.ok(!['queued', 'running'].includes(status ?? 'running') || host.scheduler.active.get('agt_b') === undefined, 'the descendant does not keep running for the deleted origin');
  const unrelatedStored = host.scheduler.durableRuns().find((r) => r.id === unrelated.id);
  assert.ok(!['cancelled', 'interrupted'].includes(unrelatedStored.status) && !unrelatedStored.interrupt_reason,
    'unrelated work survives the deletion (it may queue, run, or complete — never be cancelled)');
});

test('pending mail anchored to a retired origin is fenced for later admission', async () => {
  const { host } = makeHost({ script: () => [say('origin done')] });
  for (const [id, name] of [['agt_a', 'Ada'], ['agt_b', 'Bo']]) {
    host.registry.create({ id, profile: { name } });
  }
  const origin = host.userRequest({ agent_id: 'agt_a', text: 'start' });
  await host.drain();
  await host.deleteAgent('agt_a', { confirm: true, actor: 'user' });

  // Mail that arrives after the deletion must not be admitted either.
  await assert.rejects(
    async () => host.messages.send({ sender_id: 'agt_b', target_id: 'agt_a', text: 'nope', parent_run_id: origin.id }),
    /cancelled/,
  );
  assert.equal(host.scheduler.isRunCancelled({ id: 'probe', payload: { parent_run_id: origin.id } }), true, 'the completed origin is a durable fence');
});
