import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHost, reopenHost, makeGate, say, call } from './helpers.js';
import { ComputerService } from '../src/services/computer-service.js';
import { XvfbDesktop } from '../src/services/desktop-backend.js';
import { DockerDesktop } from '../src/services/docker-desktop.js';

function setup(script = () => [say('done')]) {
  const made = makeHost({ script, window_count: 1 });
  for (const id of ['agt_a', 'agt_b', 'agt_c']) made.host.registry.create({ id, profile: { name: id } });
  return made;
}
const ledger = (host, id) => host.scheduler.durableRuns().find(r => r.id === id);

test('cancellation follows real handoff, fences grandchildren and survives restart', async () => {
  const { host, dir } = setup(ctx => ctx.agent_id === 'agt_a' ? [call('SendToAgent', { target_id: 'agt_b', message: 'work' })] : [say('child')]);
  const root = host.userRequest({ agent_id: 'agt_a', text: 'delegate' });
  await host.scheduler.pump('agt_a');
  const child = host.scheduler.pendingRuns('agt_b')[0];
  assert.equal(child.payload.parent_run_id, root.id);
  const grand = host.deliverPeerMessage({ sender_id: 'agt_b', target_id: 'agt_c', text: 'grandchild', parent_run_id: child.id, coordination_id: root.id });
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'unrelated' });
  host.scheduler.cancelRun(root.id);
  assert.equal(ledger(host, child.id).status, 'cancelled');
  assert.equal(host.messages.get(grand.message_id).status, 'cancelled');
  assert.throws(() => host.deliverPeerMessage({ sender_id: 'agt_b', target_id: 'agt_c', parent_run_id: child.id, text: 'late' }), /cancelled/);
  const reopened = reopenHost({ dir }); reopened.host.recover(); await reopened.host.drain();
  assert.deepEqual(reopened.adapter.calls.map(c => c.payload.messages.map(m => m.text)), [['unrelated']]);
});

test('active delegated turn is aborted by parent cancellation without stopping another user', async () => {
  const entered = makeGate();
  const { host } = setup(async function* (ctx) {
    if (ctx.agent_id === 'agt_b') {
      entered.release();
      await new Promise(resolve => ctx.settings.signal.addEventListener('abort', resolve, { once: true }));
      yield say('forbidden');
    } else yield say('unrelated user');
  });
  const root = host.userRequest({ agent_id: 'agt_a', text: 'root' });
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'work', parent_run_id: root.id });
  const pumping = host.scheduler.pump('agt_b'); await entered.promise;
  const unrelated = host.userRequest({ agent_id: 'agt_c', text: 'keep' });
  host.scheduler.cancelRun(root.id); await pumping; await host.drain();
  assert.equal(host.scheduler.durableRuns().find(r => r.agent_id === 'agt_b').status, 'cancelled');
  assert.equal(ledger(host, unrelated.id).status, 'completed');
  assert.ok(!host.transcripts.all('agent', 'agt_b').some(e => e.text === 'forbidden'));
});

test('recovery fences mail committed before wake admission and repairs legacy unbound wakes', async () => {
  const { host, dir } = setup();
  const root = host.userRequest({ agent_id: 'agt_a', text: 'root' });
  host.messages.send({ sender_id: 'agt_a', target_id: 'agt_b', text: 'cancelled', parent_run_id: root.id });
  host.scheduler.enqueue({ agent_id: 'agt_b', lane: 'agent', payload: { kind: 'agent_wake' }, dedupe_key: 'old-wake' });
  // Simulate the durable cancellation commit preceding envelope cleanup.
  host.scheduler.onCancellation = () => {};
  host.scheduler.cancelRun(root.id);
  const reopened = reopenHost({ dir }); reopened.host.recover(); await reopened.host.drain();
  assert.equal(reopened.adapter.calls.length, 0);
  assert.equal(reopened.host.messages.pending('agt_b').length, 0);
});

test('coalesced priority promotes only its owner and survives save and restart', async () => {
  const { host, dir } = setup();
  const send = (text, coordination_id, priority = false) => host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text, coordination_id, priority, priority_reason: priority ? 'stop' : null });
  send('normal', 'normal'); send('later', 'later'); send('urgent', 'later', true);
  const promoted = host.scheduler.pendingRuns('agt_b').find(r => r.payload.coordination_id === 'later');
  assert.equal(promoted.priority, true);
  host.scheduler.save(promoted);
  host.scheduler.save({ ...promoted, priority: false }); // stale pre-promotion snapshot
  const reopened = reopenHost({ dir }); reopened.host.recover(); await reopened.host.drain();
  assert.deepEqual(reopened.adapter.calls.map(c => c.payload.messages.map(m => m.text)), [['urgent', 'later'], ['normal']]);
});

test('legacy mixed bound batch keeps live mail and excludes cancelled transcript instructions after restart', async () => {
  const { host, dir } = setup();
  const dead = host.userRequest({ agent_id: 'agt_a', text: 'dead parent' });
  const live = host.userRequest({ agent_id: 'agt_c', text: 'live parent' });
  const a = host.messages.send({ sender_id: 'agt_a', target_id: 'agt_b', text: 'REVOKED INSTRUCTION', parent_run_id: dead.id });
  const b = host.messages.send({ sender_id: 'agt_c', target_id: 'agt_b', text: 'LIVE INSTRUCTION', parent_run_id: live.id });
  const old = host.scheduler.enqueue({ agent_id: 'agt_b', lane: 'agent', payload: { kind: 'agent_wake', message_ids: [a.message_id, b.message_id] } });
  host.messages.drainInbox('agt_b', old.id, old.payload.message_ids);
  host.scheduler.checkpoint(old, 'inbox_bound');
  host.scheduler.cancelRun(dead.id);
  const reopened = reopenHost({ dir }); reopened.host.recover(); reopened.host.recover(); await reopened.host.drain();
  const calls = reopened.adapter.calls.filter(c => c.agent_id === 'agt_b');
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0].messages), /LIVE INSTRUCTION/);
  assert.doesNotMatch(JSON.stringify(calls[0].messages), /REVOKED INSTRUCTION/);
  assert.ok(reopened.host.transcripts.all('agent', 'agt_b').some(e => e.text === 'REVOKED INSTRUCTION'));
  const wake = reopened.host.scheduler.durableRuns().find(r => r.agent_id === 'agt_b' && r.id !== old.id);
  assert.equal(wake.payload.parent_run_id, live.id);
});

test('deleted sender instructions stay in audit history but do not return in a user prompt', async () => {
  const { host, adapter } = setup();
  const ack = host.messages.send({ sender_id: 'agt_a', target_id: 'agt_b', text: 'DELETED SENDER COMMAND' });
  host.messages.drainInbox('agt_b', 'old-delivery', [ack.message_id]);
  await host.deleteAgent('agt_a', { confirm: true });
  host.userRequest({ agent_id: 'agt_b', text: 'new request' }); await host.drain();
  assert.doesNotMatch(JSON.stringify(adapter.calls.at(-1).messages), /DELETED SENDER COMMAND/);
  assert.ok(host.transcripts.all('agent', 'agt_b').some(e => e.text === 'DELETED SENDER COMMAND'));
});

test('deleting room members preserves history, handles empty rooms and is idempotent', async () => {
  const { host, dir } = setup();
  const automation = host.scheduleAutomation({ agent_id: 'agt_b', name: 'obsolete', text: 'work later', every_ms: 60_000 });
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b', 'agt_c'], purpose: 'group', memory: 'none' });
  host.transcripts.append('room', room.id, { kind: 'room_message', sender_id: 'agt_b', text: 'historic' });
  assert.throws(() => host.registry.delete('agt_b'), /confirm/);
  for (const id of ['agt_b', 'agt_a', 'agt_c']) {
    await host.deleteAgent(id, { confirm: true });
    assert.ok(!host.rooms.get(room.id).member_ids.includes(id));
    const result = await host.sayInRoom(room.id, { text: 'hello' });
    assert.equal(result.stop_reason, id === 'agt_c' ? 'no_members' : 'rounds_complete');
  }
  await host.deleteAgent('agt_c', { confirm: true });
  assert.equal(host.scheduler.isAutomationCancelled(automation.id), true);
  assert.equal(host.automations.read().items[automation.id], undefined);
  assert.ok(host.transcripts.all('room', room.id).some(e => e.text === 'historic'));
  const reopened = reopenHost({ dir }); reopened.host.recover();
  assert.deepEqual(reopened.host.rooms.get(room.id).member_ids, []);
  assert.throws(() => reopened.host.registry.create({ id: 'agt_b' }), /cannot be reused/);
});

test('deletion invalidates active room publication and recovery repairs partial deletion', async () => {
  const entered = makeGate(), finish = makeGate();
  const { host, dir } = setup(async function* () { entered.release(); await finish.promise; yield say('stale room reply'); });
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'group', memory: 'none' });
  const running = host.sayInRoom(room.id, { text: 'go' }); await entered.promise;
  await host.deleteAgent('agt_b', { confirm: true }); finish.release();
  await running;
  assert.ok(!host.transcripts.all('room', room.id).some(e => e.text === 'stale room reply'));
  host.registry.onDelete = () => {}; // crash immediately after the registry commit
  host.registry.delete('agt_a', { confirm: true });
  const reopened = reopenHost({ dir }); reopened.host.recover();
  assert.deepEqual(reopened.host.rooms.get(room.id).member_ids, []);
});

test('release reserves the slot through an in-flight action and cleanup; stale queued actions never run', async () => {
  const { host } = setup();
  const entered = makeGate(), finish = makeGate(), cleanup = makeGate(); let effects = 0;
  host.computer.backend = { vncUrl: () => 'fake:', async perform() { entered.release(); await finish.promise; effects++; return { performed: true }; }, release: () => cleanup.promise };
  const a = host.computer.assignWindow('agt_a').assignment;
  const args = { window_index: a.window_index, owner_token: a.owner_token, action: 'click' };
  const active = assert.rejects(host.computer.performWindowAction('agt_a', args), /assignment changed/);
  await entered.promise;
  const queued = assert.rejects(host.computer.performWindowAction('agt_a', args), /does not own/);
  const released = host.computer.releaseWindow('agt_a');
  assert.equal(host.computer.assignWindow('agt_b').ok, false);
  finish.release(); await active; await queued;
  assert.equal(host.computer.assignWindow('agt_b').ok, false);
  cleanup.release(); await released;
  const b = host.computer.assignWindow('agt_b').assignment;
  assert.equal(b.window_index, a.window_index); assert.notEqual(b.owner_token, a.owner_token);
  assert.equal(effects, 1);
});

test('failed cleanup remains unavailable through restart until explicit recovery succeeds', async () => {
  const { host, dir, clock } = setup();
  host.computer.backend = { vncUrl: () => 'fake:', release: async () => { throw new Error('cleanup failed'); } };
  host.computer.assignWindow('agt_a');
  const result = await host.deleteAgent('agt_a', { confirm: true });
  assert.equal(result.cleanup_pending, true); assert.equal(result.status, 'cleanup_pending');
  assert.equal(host.computer.assignWindow('agt_b').ok, false);
  const computer = new ComputerService({ dir, clock, audit: host.audit, window_count: 1, backend: { vncUrl: () => 'fake:', release: async () => {} } });
  assert.equal(computer.assignWindow('agt_b').ok, false);
  await computer.recoverReleases();
  assert.equal(computer.assignWindow('agt_b').ok, true);
});

test('an owner cannot acquire a second slot while its prior generation is releasing', async () => {
  const { host } = setup(); const cleanup = makeGate();
  host.computer.window_count = 2;
  host.computer.backend = { vncUrl: () => 'fake:', release: () => cleanup.promise };
  host.computer.assignWindow('agt_a');
  const releasing = host.computer.releaseWindow('agt_a');
  assert.equal(host.computer.assignWindow('agt_a').reason, 'screen_releasing');
  assert.equal(host.computer.assignWindow('agt_b').ok, true);
  cleanup.release(); await releasing;
  assert.equal(host.computer.assignWindow('agt_a').ok, true);
});

test('readyWindow participates in the release barrier and cannot publish stale ownership', async () => {
  const { host } = setup(); const entered = makeGate(), finish = makeGate(); let released = false;
  host.computer.backend = { vncUrl: () => 'fake:', async ensureMonitor() { entered.release(); await finish.promise; return { real: true }; }, release() { released = true; } };
  host.computer.assignWindow('agt_a');
  const ready = assert.rejects(host.computer.readyWindow('agt_a'), /assignment changed/);
  await entered.promise;
  const release = host.computer.releaseWindow('agt_a');
  assert.equal(host.computer.assignWindow('agt_b').ok, false); assert.equal(released, false);
  finish.release(); await ready; await release;
  assert.equal(host.computer.assignWindow('agt_b').ok, true);
});

test('Xvfb cleanup removes previous profile while same-owner opens reuse it (fake processes)', async () => {
  const { dir } = setup();
  const backend = new XvfbDesktop({ dir, spawn: () => ({ on() {}, kill() {} }), execFile: async (_,args) => {
    if(args[0]==='search'&&!backend.monitors.get(0)?.browser) throw new Error('No browser window yet');
    return {stdout:'123'};
  }, sleep: async () => {}, isolation: { kind: 'bwrap', bwrap: '/fake/bwrap' } });
  backend.monitors.set(0, { ready: true, processes: [] });
  await backend.perform(0, 'open_url', { url: 'https://example.test' });
  const marker = path.join(dir, 'computer/monitors/0/home/browser-profile/marker');
  fs.writeFileSync(marker, 'old owner');
  await backend.perform(0, 'open_url', { url: 'https://example.test/again' });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'old owner');
  await backend.release(0);
  assert.equal(fs.existsSync(marker), false); assert.equal(backend.monitors.has(0), false);
});

test('Docker cleanup contract waits for serialized work and removes owned container (mock commands)', async () => {
  const { dir } = setup();
  const backend = new DockerDesktop({ dir, workspace: path.join(dir, 'workspace'), docker: '/never-execute' });
  const entered = makeGate(), finish = makeGate(); const commands = [];
  backend.command = async args => {
    commands.push(args);
    if (args[0] === 'ps') return { stdout: 'container' };
    if (args[0] === 'inspect') return { stdout: JSON.stringify([{ Config: { Labels: { 'better-bots.owner': backend.owner } } }]) };
    return { stdout: '' };
  };
  const work = backend.serial(0, async () => { entered.release(); await finish.promise; });
  await entered.promise;
  const release = backend.release(0); await Promise.resolve();
  assert.equal(commands.length, 0);
  finish.release(); await work; await release;
  assert.ok(commands.some(args => args[0] === 'rm' && args[1] === '-f'));
});

test('host reconciles repeated call usage, preserves provenance and records unknown calls', async () => {
  const { host, adapter } = setup();
  const frame = (call_id, output_tokens, provenance) => ({ type: 'usage', usage: { call_id, call: { output_tokens }, provenance, authoritative: true } });
  adapter.stream = async function* () {
    yield frame('call-1', 2, 'estimated'); yield frame('call-1', 3, 'provider_reported');
    yield frame('call-1', 3, 'provider_reported'); yield frame('call-1', 99, 'estimated');
    yield say('done');
  };
  const run = host.userRequest({ agent_id: 'agt_a', text: 'go' }); await host.drain();
  const usage = host.turnResult(run.id).usage;
  assert.equal(usage.output_tokens, 3); assert.equal(usage.calls, 1);
  assert.equal(usage.provenance, 'provider_reported'); assert.equal(usage.authoritative, false);
  assert.deepEqual(ledger(host, run.id).usage, usage);
  adapter.stream = async function* () { yield say('no measurement'); };
  const unknown = host.userRequest({ agent_id: 'agt_a', text: 'again' }); await host.drain();
  assert.equal(host.turnResult(unknown.id).usage.provenance, 'unknown');
  assert.equal(host.usageSince().agt_a.provenance, 'mixed');
  assert.equal(host.status().agents.find(a => a.id === 'agt_a').usage_24h.authoritative, false);
});

test('room usage is deduplicated on its run and included once in daily provenance totals', async () => {
  const { host, adapter, dir } = setup();
  adapter.stream = async function* (_messages, _tools, settings) {
    const usage = { call_id: settings.run_id, call: { input_tokens: 5, output_tokens: 3 }, provenance: 'estimated', authoritative: false };
    yield { type: 'usage', usage }; yield { type: 'usage', usage }; yield say('(pass)');
  };
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'one pass', memory: 'none' });
  await host.sayInRoom(room.id, { text: 'review' });
  const run = host.scheduler.durableRuns().find(r => r.payload.kind === 'room_turn');
  assert.equal(run.usage.calls, 1); assert.equal(run.usage.output_tokens, 3);
  assert.equal(host.usageSince().agt_a.output_tokens, 3);
  assert.equal(host.usageSince().agt_a.provenance, 'estimated');
  const reopened = reopenHost({ dir }); reopened.host.recover();
  assert.equal(reopened.host.usageSince().agt_a.output_tokens, 3);
  assert.equal(reopened.host.usageSince().agt_a.authoritative, false);
});
