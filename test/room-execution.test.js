import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeHost, makeGate, say } from './helpers.js';

function setup(t, script) {
  const fixture = makeHost({ script });
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  for (const id of ['agt_a', 'agt_b']) fixture.host.registry.create({ id, profile: { name: id } });
  return fixture;
}

const posted = (host, id) => host.rooms.history(id).filter((e) => ['agt_a', 'agt_b'].includes(e.sender_id));

test('room context includes canonical instructions and enabled workflows, excludes all private context', async (t) => {
  const { host, adapter } = setup(t, () => [say('(pass)')]);
  // User-provided instructions; the harness needs no bundled prompts.
  const canonical = [
    'General policy: distinguish facts from assumptions.',
    'Workspace policy: cite the evidence used for a recommendation.',
    'Role policy: check claims before reporting the conclusion.',
  ].join('\n\n');
  host.registry.updateProfile('agt_a', { description: canonical });
  const enabled = host.workflows.importMarkdown({ name: 'Room evidence rule', text: 'ENABLED_POLICY: report evidence before conclusions.' });
  host.workflows.enableFor(enabled.id, 'agt_a');
  host.workflows.importMarkdown({ name: 'Not granted', text: 'DISABLED_POLICY' });
  for (const id of ['agt_a', 'agt_b']) {
    host.transcripts.append('agent', id, { kind: 'user_message', text: `PRIVATE_CHAT_${id}` });
    host.memory.remember({ scope: 'agent', owner_id: id, writer_agent_id: id, text: `PRIVATE_MEMORY_${id}` });
  }
  host.memory.recall = () => { throw new Error('room must not read memory'); };
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'review evidence', memory: 'members' });
  for (let i = 0; i < 40; i += 1) host.transcripts.append('room', room.id, { kind: 'room_message', sender_id: 'user', text: `SHARED_HISTORY_${i}` });
  await host.runRoom(room.id, { request: 'review' });
  const input = adapter.calls.find((c) => c.agent_id === 'agt_a');
  assert.ok(input.settings.system.includes(canonical));
  assert.match(input.settings.system, /ENABLED_POLICY/);
  assert.match(input.settings.system, /Today is/);
  assert.match(input.settings.system, /review evidence/);
  assert.doesNotMatch(JSON.stringify(adapter.calls), /PRIVATE_CHAT|PRIVATE_MEMORY|DISABLED_POLICY/);
  assert.deepEqual(input.tools, []);
  assert.equal(input.messages.length, host.rooms.limits.HISTORY_MESSAGES + 1);
  assert.doesNotMatch(JSON.stringify(input.messages), /SHARED_HISTORY_0\"/);
  assert.match(JSON.stringify(input.messages), /SHARED_HISTORY_39/);
  assert.doesNotMatch(adapter.calls.find((c) => c.agent_id === 'agt_b').settings.system, /ENABLED_POLICY/);
  assert.ok(input.settings.run_id);
  assert.ok(input.settings.signal instanceof AbortSignal);
});

test('turning room memory off hides previous judgments from model context while preserving the visible transcript and current rounds', async (t) => {
  const { host, adapter } = setup(t, ({ payload }) => [say(
    payload.epoch === 2 ? 'EARLIER_JUDGMENT'
      : payload.epoch === 3 ? `CURRENT_ROUND_${payload.round}`
        : payload.epoch === 4 ? 'NEW_MEMORY_JUDGMENT' : 'FOLLOWUP_JUDGMENT',
  )]);
  // Two members: a lone member gets one round per request, and this checks later rounds too.
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'independent evaluation', memory: 'members' });
  await host.sayInRoom(room.id, { text: 'Judge the first case.' });
  host.rooms.update(room.id, { memory: 'none' });
  await host.sayInRoom(room.id, { text: 'Judge the second case independently.' });

  const nextCalls = adapter.calls.filter((call) => call.payload.epoch === 3);
  assert.equal(nextCalls.length, 6);
  assert.doesNotMatch(JSON.stringify(nextCalls[0].messages), /EARLIER_JUDGMENT|Judge the first case/);
  assert.match(JSON.stringify(nextCalls[0].messages), /Judge the second case independently/);
  assert.match(JSON.stringify(nextCalls[1].messages), /CURRENT_ROUND_0/, 'members still see earlier rounds of this request');
  assert.match(JSON.stringify(host.transcripts.all('room', room.id)), /EARLIER_JUDGMENT/, 'the transcript is not erased');
  assert.equal(host.rooms.get(room.id).memory, 'none');

  host.rooms.update(room.id, { memory: 'members' });
  await host.sayInRoom(room.id, { text: 'Start a new remembered evaluation.' });
  const resumed = adapter.calls.find((call) => call.payload.epoch === 4 && call.payload.round === 0);
  assert.doesNotMatch(JSON.stringify(resumed.messages), /EARLIER_JUDGMENT|CURRENT_ROUND_/, 're-enabling memory does not resurrect old judgments');
  await host.sayInRoom(room.id, { text: 'Continue this new evaluation.' });
  const followup = adapter.calls.find((call) => call.payload.epoch === 5 && call.payload.round === 0);
  assert.match(JSON.stringify(followup.messages), /NEW_MEMORY_JUDGMENT/, 'later remembered requests see the new era');
  assert.doesNotMatch(JSON.stringify(followup.messages), /EARLIER_JUDGMENT|CURRENT_ROUND_/);
  assert.match(JSON.stringify(host.transcripts.all('room', room.id)), /EARLIER_JUDGMENT|CURRENT_ROUND_0/, 'all eras stay readable to the user');
});

test('switching a shared room to members-only starts a new context era', async (t) => {
  const { host, adapter } = setup(t, ({ payload }) => [say(payload.epoch === 2 ? 'OLD_SHARED_JUDGMENT' : 'NEW_PRIVATE_JUDGMENT')]);
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'legacy review', memory: 'project' });
  await host.sayInRoom(room.id, { text: 'Shared first pass.' });
  host.rooms.update(room.id, { memory: 'members' });
  await host.sayInRoom(room.id, { text: 'Private second pass.' });
  const privateCall = adapter.calls.find((call) => call.payload.epoch === 3 && call.payload.round === 0);
  assert.doesNotMatch(JSON.stringify(privateCall.messages), /OLD_SHARED_JUDGMENT|Shared first pass/);
  assert.match(JSON.stringify(privateCall.messages), /Private second pass/);
  assert.match(JSON.stringify(host.transcripts.all('room', room.id)), /OLD_SHARED_JUDGMENT/);
});

test('room memory cannot change during an active discussion', async (t) => {
  const started = makeGate(), release = makeGate();
  const { host } = setup(t, () => (async function* () { started.release(); await release.promise; yield say('(pass)'); })());
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'active evaluation', memory: 'members' });
  const meeting = host.runRoom(room.id, { request: 'Judge this case.' });
  await started.promise;
  assert.throws(() => host.rooms.update(room.id, { memory: 'none' }), /room_active|discussion to finish/);
  assert.equal(host.rooms.get(room.id).memory, 'members');
  release.release();
  await meeting;
  assert.equal(host.rooms.update(room.id, { memory: 'none' }).memory, 'none');
});

test('room waits behind active and queued user turns, with one active model per agent', async (t) => {
  const started = makeGate();
  const release = makeGate();
  const order = [];
  let active = 0, maximum = 0;
  const { host } = setup(t, (ctx) => (async function* () {
    active += 1; maximum = Math.max(maximum, active);
    order.push(ctx.payload.kind);
    if (order.length === 1) { started.release(); await release.promise; }
    yield say(ctx.payload.kind === 'room_turn' ? '(pass)' : 'user reply');
    active -= 1;
  })());
  host.userRequest({ agent_id: 'agt_a', text: 'first' });
  const first = host.scheduler.pump('agt_a');
  await started.promise;
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'wait' });
  const meeting = host.runRoom(room.id, { request: 'room request' });
  host.userRequest({ agent_id: 'agt_a', text: 'second' });
  assert.equal(host.scheduler.activeRun('agt_a').lane, 'user');
  assert.deepEqual(order, ['user_request']);
  release.release();
  await Promise.all([first, meeting]);
  assert.equal(maximum, 1);
  assert.deepEqual(order, ['user_request', 'user_request', 'room_turn']);
});

test('user turn arriving during a room turn executes before the next room contribution', async (t) => {
  const started = makeGate(), release = makeGate();
  const order = [];
  let active = 0, maximum = 0;
  const { host } = setup(t, (ctx) => (async function* () {
    // agt_b keeps the meeting to more than one round; only agt_a's lane is observed.
    if (ctx.agent_id !== 'agt_a') { yield say('(pass)'); return; }
    active += 1; maximum = Math.max(maximum, active); order.push(ctx.payload.kind);
    if (order.length === 1) { started.release(); await release.promise; }
    yield say(ctx.payload.kind === 'room_turn' && ctx.payload.round > 0 ? '(pass)' : 'contribution');
    active -= 1;
  })());
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'priority' });
  const meeting = host.runRoom(room.id, { request: 'go' });
  await started.promise;
  host.userRequest({ agent_id: 'agt_a', text: 'user needs attention' });
  assert.deepEqual(order, ['room_turn']);
  release.release();
  await meeting;
  assert.deepEqual(order, ['room_turn', 'user_request', 'room_turn']);
  assert.equal(maximum, 1);
});

test('stopping queued room work cancels it without interrupting the active user', async (t) => {
  const started = makeGate(), release = makeGate();
  let userSignal;
  const { host, adapter } = setup(t, () => (async function* () {
    started.release(); await release.promise; yield say('user finished');
  })());
  host.userRequest({ agent_id: 'agt_a', text: 'user work' });
  const first = host.scheduler.pump('agt_a');
  await started.promise;
  userSignal = host.scheduler.active.get('agt_a').signal;
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'cancel queued' });
  const meeting = host.runRoom(room.id, { request: 'never execute' });
  host.stopRoom(room.id);
  const result = await meeting;
  assert.equal(result.stop_reason, 'stale_epoch');
  assert.equal(userSignal.aborted, false);
  assert.equal(host.scheduler.pendingRuns('agt_a').length, 0);
  release.release(); await first;
  assert.equal(adapter.calls.length, 1);
  assert.equal(posted(host, room.id).length, 0);
  const run = host.scheduler.durableRuns().find((r) => r.payload.kind === 'room_turn');
  assert.equal(run.status, 'interrupted');
  assert.equal(run.resume_policy, 'abandon');
});

for (const action of ['stop', 'supersede', 'delete']) {
  test(`${action} signals an active room turn; stale output never publishes or enters memory`, async (t) => {
    const started = makeGate();
    let signal;
    const { host } = setup(t, (ctx) => (async function* () {
      signal = ctx.settings.signal;
      started.release();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      yield say('STALE_OUTPUT');
    })());
    const retained = [];
    host.memory.retainExchange = (entry) => retained.push(entry);
    const room = host.createRoom({ member_ids: ['agt_a'], purpose: action });
    const meeting = host.runRoom(room.id, { request: 'old request' });
    await started.promise;
    if (action === 'stop') host.stopRoom(room.id);
    else if (action === 'supersede') host.rooms.supersede(room.id);
    else host.rooms.delete(room.id, { confirm: true });
    assert.equal(signal.aborted, true);
    const result = await meeting;
    assert.equal(result.stop_reason, 'stale_epoch');
    assert.doesNotMatch(JSON.stringify(host.transcripts.all('room', room.id)), /STALE_OUTPUT/);
    assert.equal(retained.length, 0);
  });
}

test('new discussion supersedes active output and retains only current contributions', async (t) => {
  const started = makeGate();
  const { host } = setup(t, (ctx) => (async function* () {
    if (ctx.payload.request === 'old') {
      started.release();
      await new Promise((resolve) => ctx.settings.signal.addEventListener('abort', resolve, { once: true }));
      yield say('STALE_OUTPUT');
    } else yield say(ctx.payload.round === 0 ? 'CURRENT_OUTPUT' : '(pass)');
  })());
  const retained = [];
  host.memory.retainExchange = (entry) => retained.push(entry);
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'new request' });
  const old = host.runRoom(room.id, { request: 'old' });
  await started.promise;
  const fresh = host.runRoom(room.id, { request: 'new' });
  const [before, after] = await Promise.all([old, fresh]);
  assert.equal(before.stop_reason, 'stale_epoch');
  assert.equal(after.total_messages, 1);
  assert.equal(retained.length, 1);
  assert.match(retained[0].content, /CURRENT_OUTPUT/);
  assert.doesNotMatch(retained[0].content, /STALE_OUTPUT/);
});

test('superseding between model completion and publication rejects the durable candidate', async (t) => {
  const { host } = setup(t, () => [say('TOO_LATE')]);
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'commit race' });
  const save = host.scheduler.save.bind(host.scheduler);
  host.scheduler.save = (run) => {
    save(run);
    if (run.payload.kind === 'room_turn' && run.status === 'completed') host.rooms.supersede(room.id);
  };
  const retained = [];
  host.memory.retainExchange = (entry) => retained.push(entry);
  const result = await host.runRoom(room.id, { request: 'go' });
  assert.equal(result.stop_reason, 'stale_epoch');
  assert.equal(posted(host, room.id).length, 0);
  assert.equal(retained.length, 0);
});

test('a superseded callback is checked when queued work starts, before calling the model', async (t) => {
  const started = makeGate(), release = makeGate();
  const { host, adapter } = setup(t, () => (async function* () {
    started.release(); await release.promise; yield say('user reply');
  })());
  host.userRequest({ agent_id: 'agt_a', text: 'busy' });
  const user = host.scheduler.pump('agt_a');
  await started.promise;
  let superseded = false;
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'callback cancellation' });
  const meeting = host.runRoom(room.id, { request: 'outdated', isSuperseded: () => superseded });
  superseded = true;
  release.release();
  const [, result] = await Promise.all([user, meeting]);
  assert.equal(result.stop_reason, 'superseded');
  assert.equal(adapter.calls.length, 1);
  assert.equal(posted(host, room.id).length, 0);
});

test('two rooms sharing an agent serialize contributions without exceeding either budget', async (t) => {
  const started = makeGate(), release = makeGate();
  let active = 0, maximum = 0, first = true;
  const { host } = setup(t, () => (async function* () {
    active += 1; maximum = Math.max(maximum, active);
    if (first) { first = false; started.release(); await release.promise; }
    yield say('one'); yield say('two'); yield say('discard three');
    active -= 1;
  })());
  const one = host.createRoom({ member_ids: ['agt_a'], purpose: 'one' });
  const two = host.createRoom({ member_ids: ['agt_a'], purpose: 'two' });
  const firstMeeting = host.runRoom(one.id, { request: 'one' });
  await started.promise;
  const secondMeeting = host.runRoom(two.id, { request: 'two' });
  assert.equal(host.scheduler.pendingRuns('agt_a').length, 1);
  release.release();
  const results = await Promise.all([firstMeeting, secondMeeting]);
  assert.equal(maximum, 1);
  // A lone member speaks one round per request: two replies kept, the third discarded.
  assert.deepEqual(results.map((r) => r.total_messages), [2, 2]);
  assert.ok(results.every((r) => r.rounds.length === 1 && r.rounds.every((round) => round.turns.every((turn) => turn.posted === 2))));
});

test('a paused room member reports the blocker instead of leaving the room active forever', async (t) => {
  const {host,adapter}=setup(t,()=>[say('must not run')]);
  host.updateDesk({name:'',enabled:false});
  const room=host.createRoom({member_ids:['agt_a','agt_b'],purpose:'Paused members',memory:'none'});
  const meeting=host.sayInRoom(room.id,{text:'Review this'});
  let timer;
  try {
    const result=await Promise.race([meeting,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),500);})]);
    assert.ok(result,'paused member must not hang a room');
    assert.equal(result.stop_reason,'member_paused');
    assert.equal(host.rooms.get(room.id).discussion.status,'member_paused');
    assert.ok(host.rooms.history(room.id).some(m=>/desk is paused/.test(m.text)));
    assert.equal(adapter.calls.length,0);
    assert.equal(host.scheduler.pendingRuns('agt_a').length,0);
  } finally {clearTimeout(timer);host.stopRoom(room.id);await meeting;}
});
