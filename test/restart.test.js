import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, reopenHost, say, call } from './helpers.js';

// Restart recovery does not lose queued work.

function twoAgents(host) {
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
}

test('agents, profiles, and transcripts survive a restart', () => {
  const { host, dir, clock } = makeHost({ script: () => [say('ok')] });
  twoAgents(host);
  host.transcripts.append('agent', 'agt_a', { kind: 'user_message', text: 'remember me' });

  const { host: restarted } = reopenHost({ dir, clock });
  assert.equal(restarted.registry.list().length, 2);
  assert.equal(restarted.registry.get('agt_a').profile.name, 'Ada');
  assert.equal(restarted.transcripts.all('agent', 'agt_a')[0].text, 'remember me');
});

test('a queued run survives a restart and then executes', async () => {
  const { host, dir, clock } = makeHost({ script: () => [say('ok')] });
  twoAgents(host);
  const run = host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'automation', payload: { kind: 'automation', name: 'nightly', text: 'sweep' } });
  assert.equal(host.scheduler.pendingRuns('agt_a').length, 1);

  const { host: restarted } = reopenHost({ dir, clock, script: () => [say('ran after restart')] });
  const recovery = restarted.recover();
  assert.equal(recovery.queued_runs.length, 1);
  assert.equal(recovery.queued_runs[0].run_id, run.id);

  await restarted.drain();
  const result = restarted.visibleResults().find((r) => r.run_id === run.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'ran after restart');
});

test('memory and permissions survive a restart', () => {
  const { host, dir, clock } = makeHost({ script: () => [say('ok')] });
  twoAgents(host);
  host.memory.remember({ scope: 'project', owner_id: 'default', writer_agent_id: 'agt_a', text: 'ships on Friday' });
  host.permissions.setStandingMode('local', 'never', { actor: 'user' });

  const { host: restarted } = reopenHost({ dir, clock });
  assert.equal(restarted.memory.factsIn('project', 'default')[0].text, 'ships on Friday');
  assert.equal(restarted.permissions.standingMode('local'), 'never');
});

test('a desktop assignment survives a restart and keeps its owner token', () => {
  const { host, dir, clock } = makeHost({ script: () => [say('ok')] });
  twoAgents(host);
  const assigned = host.computer.assignWindow('agt_a').assignment;

  const { host: restarted } = reopenHost({ dir, clock });
  assert.equal(restarted.computer.verifyOwner('agt_a', assigned.window_index, assigned.owner_token), true);
  assert.equal(restarted.computer.verifyOwner('agt_b', assigned.window_index, assigned.owner_token), false);
});

test('a queued peer wake survives repeated reopening without duplicate execution', async () => {
  const { host, dir, clock } = makeHost({ script: () => [say('ok')] });
  twoAgents(host);
  // Queued-work recovery; actual process-crash boundaries are tested in crash-recovery.test.js.
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'work item' });

  const { host: restarted } = reopenHost({ dir, clock, script: () => [say('handled once')] });
  restarted.recover();
  await restarted.drain();

  const handled = restarted.visibleResults().filter((r) => r.agent_id === 'agt_b' && r.text === 'handled once');
  assert.equal(handled.length, 1, 'the queued work ran exactly once');

  // A third open finds nothing left to do.
  const { host: third } = reopenHost({ dir, clock, script: () => [say('should not run')] });
  third.recover();
  await third.drain();
  assert.equal(third.visibleResults().filter((r) => r.text === 'should not run').length, 0);
});

test('a room and its transcript survive a restart', async () => {
  const { host, dir, clock } = makeHost({ script: () => [say('a point')] });
  twoAgents(host);
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'durable room' });
  await host.runRoom(room.id, { request: 'discuss' });

  const { host: restarted } = reopenHost({ dir, clock });
  assert.equal(restarted.rooms.get(room.id).purpose, 'durable room');
  assert.ok(restarted.rooms.history(room.id).length > 0);
});
