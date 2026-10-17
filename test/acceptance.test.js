import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHost, reopenHost, makeGate, say, call } from './helpers.js';

// The fifteen acceptance tests, in order.

function twoAgents(host) {
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada', role: 'researcher' } });
  const b = host.registry.create({ id: 'agt_b', profile: { name: 'Bo', role: 'builder' } });
  return { a, b };
}

test('1. Agent A can message Agent B without waiting for B\'s answer', async () => {
  const { host } = makeHost({
    script: (ctx) => ctx.agent_id === 'agt_a'
      ? [call('SendToAgent', { target_id: 'agt_b', message: 'Goal: use pattern X' })]
      : [say('noted')],
  });
  twoAgents(host);

  host.userRequest({ agent_id: 'agt_a', text: 'brief the builder' });
  await host.drain();

  const sendResult = host.visibleResults().find((r) => r.agent_id === 'agt_a');
  assert.equal(sendResult.status, 'completed');

  // The send returned an acknowledgement, and it does not pretend to be a reply.
  const ack = host.audit.where((e) => e.type === 'message.sent')[0];
  assert.equal(ack.sender_id, 'agt_a');
  const envelope = host.messages.get(ack.message_id);
  assert.equal(envelope.status, 'delivered');
  assert.match(host.messages.allEnvelopes()[0].text, /Goal/);
});

test('2. B\'s reply arrives on a later turn and wakes A once', async () => {
  const { host } = makeHost({
    script: (ctx) => {
      if (ctx.agent_id === 'agt_a' && ctx.payload.kind === 'user_request') {
        return [call('SendToAgent', { target_id: 'agt_b', message: 'need the checkout facts' })];
      }
      if (ctx.agent_id === 'agt_b' && ctx.payload.kind === 'agent_wake') {
        return [call('SendToAgent', { target_id: 'agt_a', message: 'Evidence: three facts' })];
      }
      return [say('done')];
    },
  });
  twoAgents(host);

  host.userRequest({ agent_id: 'agt_a', text: 'ask the builder' });
  await host.drain();

  const wakesOfA = host.scheduler
    .runHistory()
    .filter((r) => r.agent_id === 'agt_a' && r.lane === 'agent' && r.event === 'started');
  assert.equal(wakesOfA.length, 1, 'A woke exactly once for the reply');

  const inbound = host.transcripts
    .all('agent', 'agt_a')
    .filter((e) => e.kind === 'peer_message_in');
  assert.equal(inbound.length, 1);
  assert.match(inbound[0].text, /three facts/);
});

test('3. Restarting the host does not lose a queued message', async () => {
  const { host, dir, clock } = makeHost({ script: () => [say('ok')] });
  twoAgents(host);

  // Queue a message but never drain: the recipient's wake is still pending.
  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'survive the restart' });
  assert.equal(host.messages.pending('agt_b').length, 1);

  // A new process, same directory.
  const { host: restarted } = reopenHost({ dir, clock, script: () => [say('after restart')] });
  const recovery = restarted.recover();
  assert.equal(restarted.messages.pending('agt_b').length, 1, 'the envelope is still queued');
  assert.ok(recovery.queued_runs.length + recovery.rearmed_wakes.length > 0);

  await restarted.drain();
  const inbound = restarted.transcripts.all('agent', 'agt_b').filter((e) => e.kind === 'peer_message_in');
  assert.equal(inbound.length, 1);
  assert.match(inbound[0].text, /survive the restart/);

  // And it does not wake a second time after another restart.
  const { host: again } = reopenHost({ dir, clock, script: () => [say('third')] });
  again.recover();
  await again.drain();
  const inboundAgain = again.transcripts.all('agent', 'agt_b').filter((e) => e.kind === 'peer_message_in');
  assert.equal(inboundAgain.length, 1, 'a delivered message never wakes the recipient twice');
});

test('4. A normal peer message does not interrupt an active run', async () => {
  const gate = makeGate();
  const { host } = makeHost({
    script: (ctx) => {
      if (ctx.agent_id === 'agt_b' && ctx.payload.kind === 'background_task') {
        return (async function* () {
          yield say('working');
          await gate.promise;
          yield say('finished the background task');
        })();
      }
      return [say('ok')];
    },
  });
  twoAgents(host);

  host.scheduler.enqueue({ agent_id: 'agt_b', lane: 'background', payload: { kind: 'background_task' } });
  const running = host.scheduler.pump('agt_b');
  await Promise.resolve();

  const ack = host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'fyi, no rush' });
  assert.equal(ack.priority, false);
  assert.equal(ack.interrupted_recipient, undefined, 'a normal message never interrupts');

  gate.release();
  await running;
  await host.drain();

  const bg = host.scheduler.runHistory().find((r) => r.payload?.kind === 'background_task' && r.event === 'finished');
  assert.equal(bg.status, 'completed', 'the background run finished normally');
});

test('5. A priority peer message can interrupt non-user work', async () => {
  const gate = makeGate();
  const { host } = makeHost({
    script: (ctx) => {
      if (ctx.agent_id === 'agt_b' && ctx.payload.kind === 'background_task') {
        return (async function* () {
          yield say('polishing the animation');
          await gate.promise;
          yield say('this should never be reached');
        })();
      }
      return [say('ok')];
    },
  });
  twoAgents(host);

  host.scheduler.enqueue({ agent_id: 'agt_b', lane: 'background', payload: { kind: 'background_task' } });
  const running = host.scheduler.pump('agt_b');
  await Promise.resolve();

  const ack = host.deliverPeerMessage({
    sender_id: 'agt_a', target_id: 'agt_b',
    text: 'Stop polishing the animation. Checkout is broken.',
    priority: true, priority_reason: 'supersede',
  });
  assert.equal(ack.priority, true);
  assert.equal(ack.interrupted_recipient, true);

  gate.release();
  await running;

  const finished = host.scheduler.runHistory().find((r) => r.payload?.kind === 'background_task' && r.event === 'finished');
  assert.equal(finished.status, 'interrupted');
  assert.equal(finished.interrupt_reason, 'supersede');
  // Superseded work does not resume blindly.
  assert.equal(finished.resume_policy, 'abandon');
  assert.equal(finished.partial_output_safe, false);
});

test('6. No peer message interrupts the user lane', async () => {
  const gate = makeGate();
  const { host } = makeHost({
    script: (ctx) => {
      if (ctx.agent_id === 'agt_b' && ctx.payload.kind === 'user_request') {
        return (async function* () {
          yield say('answering the person');
          await gate.promise;
          yield say('finished answering the person');
        })();
      }
      return [say('ok')];
    },
  });
  twoAgents(host);

  host.userRequest({ agent_id: 'agt_b', text: 'talk to me' });
  const running = host.scheduler.pump('agt_b');
  await Promise.resolve();

  const ack = host.deliverPeerMessage({
    sender_id: 'agt_a', target_id: 'agt_b', text: 'URGENT',
    priority: true, priority_reason: 'stop',
  });
  assert.equal(ack.interrupted_recipient, false);
  assert.match(ack.interrupt_note, /talking to the user/);

  gate.release();
  await running;

  const userRun = host.scheduler.runHistory().find((r) => r.lane === 'user' && r.event === 'finished');
  assert.equal(userRun.status, 'completed', 'the user turn was never preempted');
  assert.ok(host.audit.where((e) => e.type === 'run.interrupt_declined_user_lane').length === 1);

  // The priority message was queued, not lost.
  await host.drain();
  const inbound = host.transcripts.all('agent', 'agt_b').filter((e) => e.kind === 'peer_message_in');
  assert.equal(inbound.length, 1);
});

test('7. A room stops after its configured bounds', async () => {
  const { host } = makeHost({ script: () => [say('one'), say('two'), say('three')] });
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(host.registry.create({ profile: { name: `M${i}` } }).id);
  }
  const room = host.createRoom({ member_ids: ids, purpose: 'go or no-go' });
  const result = await host.runRoom(room.id, { request: 'ship it?' });

  assert.equal(result.stop_reason, 'message_cap');
  assert.equal(result.total_messages, host.rooms.limits.MAX_MESSAGES);
  for (const round of result.rounds) {
    for (const turn of round.turns) {
      assert.ok(turn.posted <= host.rooms.limits.MAX_PER_MEMBER_TURN, 'per-member-turn cap holds');
    }
  }
  assert.ok(result.rounds.length <= host.rooms.limits.MAX_ROUNDS);
});

test('8. An agent can pass without adding a visible message', async () => {
  const { host } = makeHost({
    script: (ctx) => (ctx.agent_id === 'agt_quiet' ? [say('(pass)')] : [say('here is my view')]),
  });
  host.registry.create({ id: 'agt_quiet', profile: { name: 'Quiet' } });
  host.registry.create({ id: 'agt_loud', profile: { name: 'Loud' } });
  const room = host.createRoom({ member_ids: ['agt_quiet', 'agt_loud'], purpose: 'review' });

  const result = await host.runRoom(room.id, { request: 'thoughts?' });
  const speakers = result.transcript.filter((m) => !m.system).map((m) => m.sender_id);
  assert.ok(!speakers.includes('agt_quiet'), 'pass messages are not displayed');
  assert.ok(speakers.includes('agt_loud'));
  assert.ok(host.audit.where((e) => e.type === 'room.member_passed').length > 0, 'the pass is still auditable');
});

test('9. Separate agents do not receive each other\'s private transcript by default', async () => {
  const seen = [];
  const { host } = makeHost({
    script: (ctx) => { seen.push({ agent: ctx.agent_id, messages: JSON.stringify(ctx.messages) }); return [say('ok')]; },
  });
  twoAgents(host);

  host.userRequest({ agent_id: 'agt_a', text: 'my private banking password is hunter2' });
  await host.drain();
  host.userRequest({ agent_id: 'agt_b', text: 'unrelated work' });
  await host.drain();

  const bPrompt = seen.find((s) => s.agent === 'agt_b');
  assert.ok(!bPrompt.messages.includes('hunter2'), "A's transcript never entered B's prompt");
  assert.equal(host.transcripts.all('agent', 'agt_b').filter((e) => e.text?.includes('hunter2')).length, 0);
});

test('10. Memory retrieval stays within its declared scope', async () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  twoAgents(host);

  host.memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', tier: 'profile', text: 'A prefers TypeScript' });
  host.memory.remember({ scope: 'project', owner_id: 'default', writer_agent_id: 'agt_a', tier: 'log', text: 'The project ships on Friday' });

  const forB = await host.memory.recall({ agent_id: 'agt_b', scopes: [{ scope: 'project', owner_id: 'default' }] });
  const texts = forB.facts.map((f) => f.text);
  assert.ok(!texts.includes('A prefers TypeScript'), 'agent-scoped memory did not leak');
  assert.ok(texts.includes('The project ships on Friday'), 'shared project scope is readable');

  // Asking for another agent's private scope is refused and audited.
  const stolen = await host.memory.recall({ agent_id: 'agt_b', scopes: [{ scope: 'agent', owner_id: 'agt_a' }] });
  assert.ok(!stolen.facts.some((f) => f.owner_id === 'agt_a'));
  assert.ok(host.audit.where((e) => e.type === 'memory.scope_blocked').length > 0);

  // An agent cannot write into another agent's private scope either.
  assert.throws(
    () => host.memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_b', text: 'forged' }),
    /scope-?d? memory is written by its owner only|scope_violation/i,
  );
});

test('11. Separate desktop windows do not imply separate file systems', async () => {
  const { host } = makeHost({
    script: (ctx) => {
      if (ctx.agent_id === 'agt_a') {
        return [call('OpenScreen', {}), call('SandboxWriteFile', { path: 'shared.txt', content: 'written by A', expected_revision: 'missing', operation_id: 'initial-write' })];
      }
      return [call('OpenScreen', {}), call('SandboxReadFile', { path: 'shared.txt' })];
    },
  });
  twoAgents(host);

  host.userRequest({ agent_id: 'agt_a', text: 'claim a screen and write a file' });
  await host.drain();
  host.userRequest({ agent_id: 'agt_b', text: 'claim a screen and read that file' });
  await host.drain();

  const windows = host.computer.assignments();
  assert.equal(windows.length, 2);
  assert.notEqual(windows[0].window_index, windows[1].window_index, 'the screens are separate');
  assert.equal(windows[0].computer_id, windows[1].computer_id, 'the computer is shared');

  const read = host.transcripts.all('agent', 'agt_b').find((e) => e.kind === 'tool_result' && e.name === 'SandboxReadFile');
  assert.equal(read.result.content, 'written by A', 'the file system is shared, and the design says so');

  const describe = host.computer.describe();
  assert.equal(describe.boundaries.find((b) => b.surface.startsWith('Files')).private, false);
  assert.match(describe.warning, /not imply a private file system/);
});

test('12. Allow once expires with its scope', async () => {
  const { host } = makeHost({
    script: () => [call('LocalReadFile', { path: '/etc/hosts' })],
  });
  twoAgents(host);

  host.userRequest({ agent_id: 'agt_a', text: 'read a local file' });
  await host.drain();

  const request = host.audit.where((e) => e.type === 'permission.asked').at(-1);
  assert.ok(request, 'the gate asked instead of acting');
  // The run that asked has already ended, so its scope was retired with it.
  assert.equal(host.permissions.getRequest(request.request_id).resolution, 'retired');

  const retired = host.audit.where((e) => e.type === 'permission.scope_retired');
  assert.ok(retired.length > 0, 'approvals retire at scope completion');
});

test('13. Never blocks the action', async () => {
  const { host } = makeHost({ script: () => [call('LocalReadFile', { path: '/etc/hosts' })] });
  twoAgents(host);

  host.permissions.setStandingMode('local', 'never', { actor: 'user' });
  host.userRequest({ agent_id: 'agt_a', text: 'read a local file' });
  await host.drain();

  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result');
  assert.equal(result.blocked, true);
  assert.equal(result.basis, 'standing_never');
  assert.equal(host.audit.where((e) => e.type === 'permission.asked').length, 0, 'Never is a real block, not a prompt');
});

test('14. A denied action is not immediately requested again', async () => {
  const { host } = makeHost({ script: () => [call('LocalReadFile', { path: '/etc/hosts' })] });
  twoAgents(host);

  const scope = 'scope_under_test';
  const first = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/etc/hosts', scope_id: scope });
  assert.equal(first.decision, 'ask');
  host.permissions.resolve(first.request.id, 'deny', { actor: 'user' });

  const second = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/etc/hosts', scope_id: scope });
  assert.equal(second.decision, 'blocked');
  assert.equal(second.basis, 'denied_earlier', 'the denial is remembered for this direction');

  // The denial retires with the scope, so it never becomes a permanent silent rule.
  host.permissions.retireScope(scope);
  const third = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/etc/hosts', scope_id: 'a_new_turn' });
  assert.equal(third.decision, 'ask');
});

test('15. Every side effect has an audit event', async () => {
  const { host } = makeHost({
    script: (ctx) => (ctx.agent_id === 'agt_a'
      ? [call('SandboxWriteFile', { path: 'note.txt', content: 'hello', expected_revision: 'missing', operation_id: 'initial-write' }), call('SendToAgent', { target_id: 'agt_b', message: 'wrote a note' })]
      : [say('ok')]),
  });
  twoAgents(host);

  host.userRequest({ agent_id: 'agt_a', text: 'do side effects' });
  await host.drain();

  const executed = host.audit.where((e) => e.type === 'tool.executed');
  const names = executed.map((e) => e.name);
  assert.ok(names.includes('SandboxWriteFile'));
  assert.ok(names.includes('SendToAgent'));
  for (const event of executed) {
    assert.ok(event.side_effect, 'every executed tool records its side effect');
    assert.ok(event.agent_id && event.run_id, 'the audit says who asked and in which run');
  }
  assert.ok(host.audit.where((e) => e.type === 'message.sent').length > 0);
  assert.ok(host.audit.where((e) => e.type === 'permission.allowed').length > 0);
});

// Fake computer isolation is avoided by ownership where needed
// and locks on shared resources — not pretending the computer is private.
test('12. An agent owns its own directory; shared paths are shared, and written under a lock', async () => {
  const { host } = makeHost({
    script: (ctx) => ctx.agent_id === 'agt_a'
      ? [call('SandboxWriteFile', { path: 'agents/agt_b/notes.txt', content: 'vandalism' }), call('SandboxWriteFile', { path: 'agents/agt_a/mine.txt', content: 'ok' })]
      : [call('SandboxWriteFile', { path: 'shared/board.txt', content: 'from B', expected_revision: 'missing', operation_id: 'initial-write' })],
  });
  twoAgents(host);
  host.userRequest({ agent_id: 'agt_a', text: 'write into B and into your own' });
  host.userRequest({ agent_id: 'agt_b', text: 'write to the shared board' });
  await host.drain();

  const results = (id) => host.transcripts.all('agent', id).filter((e) => e.kind === 'tool_result' && e.name === 'SandboxWriteFile').map((e) => e.result);
  const [intoB, own] = results('agt_a');
  assert.equal(intoB.ok, false);
  assert.equal(intoB.error, 'not_yours');
  assert.equal(intoB.error, 'not_yours');
  assert.equal(own.ok, true);
  assert.equal(own.shared, false);
  const [board] = results('agt_b');
  assert.equal(board.ok, true);
  assert.equal(board.shared, true, 'a path outside any agent directory is shared');
  assert.ok(!fs.existsSync(path.join(host.workspace, 'agents', 'agt_b', 'notes.txt')), 'the refused write never happened');
  assert.ok(!fs.existsSync(path.join(host.workspace, 'shared', 'board.txt.lock')), 'the lock is released after the write');

  // A stale replacement cannot clobber a committed version.
  const tool = host.tools.get('SandboxWriteFile');
  const blocked = await tool.handler({ agent: host.registry.get('agt_b'), input: {
    path: 'shared/board.txt', content: 'stale', expected_revision: 'missing', operation_id: 'stale-write',
  } });
  assert.equal(blocked.error, 'conflict');
  assert.equal(fs.readFileSync(path.join(host.workspace, 'shared', 'board.txt'), 'utf8'), 'from B');

});
