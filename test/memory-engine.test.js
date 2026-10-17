import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { HindsightEngine } from '../src/services/memory-engine.js';
import { buildContext, renderMessages } from '../src/context.js';
import { tmpDir, oneStep, say } from './helpers.js';
import { fixedClock } from '../src/core/clock.js';

// The engine (Hindsight) sits behind MemoryService. These tests drive the
// service with a fake that records every bank it is asked about, so the two
// promises — no cross-contamination, no forgetting — are checked through the
// engine path, not assumed of it.

class FakeEngine {
  constructor() {
    this.name = 'fake';
    this.retained = [];   // { bank, item }
    this.recalled = [];   // { bank, query }
    this.ensured = [];    // { bank, opts }
    this.canned = new Map(); // bank -> results
    this.standing = new Map(); // bank -> text
    this.fail = false;
  }
  static bankId(scope, ownerId) { return HindsightEngine.bankId(scope, ownerId); }
  async ensureBank(bank, opts) { this.ensured.push({ bank, opts }); return true; }
  async standingKnowledge(bank) { return this.standing.has(bank) ? { text: this.standing.get(bank), refreshed_at: '2026-09-03T03:40:00Z' } : null; }
  async retain(bank, item) {
    if (this.fail) throw new Error('engine down');
    this.retained.push({ bank, item });
    return { success: true };
  }
  async recall(bank, { query }) {
    if (this.fail) throw new Error('engine down');
    this.recalled.push({ bank, query });
    return this.canned.get(bank) ?? [];
  }
  seed(bank, results) { this.canned.set(bank, results); }
}

function setup({ script = () => [] } = {}) {
  const engine = new FakeEngine();
  const host = new Host({ dir: tmpDir(), adapter: new ScriptedAdapter(oneStep(script)), clock: fixedClock(), memory_engine: engine });
  return { host, engine };
}

const result = (text, metadata = {}, extra = {}) => ({ id: `h_${Math.random().toString(36).slice(2, 8)}`, text, metadata, type: 'world', mentioned_at: '2026-09-01T00:00:00Z', ...extra });

test('every fact is retained into the bank for its scope, with tier, writer, and source riding along', async () => {
  const { host, engine } = setup();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.memory.remember({ scope: 'agent', owner_id: a.id, writer_agent_id: a.id, tier: 'note', text: 'the button hex is #6d28d9' });
  host.memory.remember({ scope: 'project', owner_id: 'default', writer_agent_id: a.id, tier: 'log', text: 'We ship on Fridays.' });
  await host.memory.flush();

  assert.deepEqual(engine.retained.map((r) => r.bank), ['agent-agt_a', 'project-default']);
  const [note, decision] = engine.retained.map((r) => r.item);
  assert.equal(note.metadata.tier, 'note');
  assert.equal(note.metadata.writer_agent_id, 'agt_a');
  assert.equal(decision.metadata.source, 'turn');
  assert.match(note.metadata.fact_id, /^mem/);
  assert.ok(note.timestamp, 'the fact carries when it was learned');

  // The scope rule is enforced before the engine ever hears about it.
  assert.throws(
    () => host.memory.remember({ scope: 'agent', owner_id: 'agt_b', writer_agent_id: a.id, tier: 'log', text: 'x' }),
    /scope_violation|owner only/,
  );
  await host.memory.flush();
  assert.equal(engine.retained.length, 2, 'nothing was retained for the refused write');
});

test('recall asks the engine only for banks this agent may read — never another agent\'s bank', async () => {
  const { host, engine } = setup();
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  engine.seed('agent-agt_a', [result('Ada privately noted the vault code.')]);
  engine.seed('agent-agt_b', [result('Bo privately noted his own plan.')]);
  engine.seed('project-default', [result('The team ships on Fridays.')]);

  const out = await host.memory.recall({
    agent_id: 'agt_b',
    // A caller trying to smuggle in Ada's private scope alongside the shared one.
    scopes: [{ scope: 'project', owner_id: 'default' }, { scope: 'agent', owner_id: 'agt_a' }],
    query: 'what do we know',
  });

  assert.deepEqual(engine.recalled.map((r) => r.bank).sort(), ['agent-agt_b', 'project-default'], 'agent-agt_a was never queried');
  assert.ok(out.facts.some((f) => /Fridays/.test(f.text)));
  assert.ok(out.facts.some((f) => /Bo privately/.test(f.text)));
  assert.ok(!out.facts.some((f) => /vault/.test(f.text)), 'Ada\'s private fact does not appear');
  assert.ok(host.audit.where((e) => e.type === 'memory.scope_blocked' && e.owner_id === 'agt_a').length === 1, 'and the attempt is audited');
  assert.equal(out.engine, 'fake');
});

test('engine results become facts the envelope understands; profile stays first; notes stay out; the current run is skipped', async () => {
  const { host, engine } = setup();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.memory.remember({ scope: 'agent', owner_id: a.id, writer_agent_id: a.id, tier: 'profile', text: 'Ada is the release manager.' });
  engine.seed('agent-agt_a', [
    result('The launch is on Friday, September 4, 2026.', { tier: 'log', run_id: 'run_old' }, { occurred_start: '2026-09-04T00:00:00Z' }),
    result('Filed detail: the button hex is #6d28d9.', { tier: 'note' }),
    result('Just now: the user asked about the launch date.', { tier: 'log', run_id: 'run_now' }),
  ]);

  const out = await host.memory.recall({ agent_id: a.id, query: 'when do we ship', exclude_runs: new Set(['run_now']) });
  assert.equal(out.facts[0].tier, 'profile', 'profile facts keep first claim on the budget');
  assert.match(out.facts[0].text, /release manager/);
  assert.match(out.facts[1].text, /September 4/);
  assert.equal(out.facts[1].when, '2026-09-04T00:00:00Z', 'the engine\'s resolved date comes through');
  assert.equal(out.facts.length, 2, 'the note and the in-window exchange are held back');
  assert.equal(out.already_in_prompt, 1);

  // The explicit read includes notes: that is what the tier is for.
  const found = await host.memory.search({ agent_id: a.id, scopes: [{ scope: 'agent', owner_id: a.id }], query: 'button colour' });
  assert.ok(found.some((f) => f.tier === 'note' && /#6d28d9/.test(f.text)));
});

test('an engine outage costs ranking quality, never a turn: local fallback, audited', async () => {
  const { host, engine } = setup();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.memory.remember({ scope: 'agent', owner_id: a.id, writer_agent_id: a.id, tier: 'log', text: 'The staging certificate expires in October.' });
  await host.memory.flush();
  engine.fail = true;

  const out = await host.memory.recall({ agent_id: a.id, query: 'certificate' });
  assert.equal(out.engine, 'local');
  assert.ok(out.facts.some((f) => /certificate/.test(f.text)), 'the JSONL copy still answers');
  assert.equal(host.audit.where((e) => e.type === 'memory.engine_fallback').length, 1);

  // A write during the outage is kept on disk and the failure is recorded, not thrown.
  host.memory.remember({ scope: 'agent', owner_id: a.id, writer_agent_id: a.id, tier: 'log', text: 'Bo renews it.' });
  await host.memory.flush();
  assert.equal(host.memory.factsIn('agent', a.id).length, 2);
  assert.equal(host.audit.where((e) => e.type === 'memory.engine_failed').length, 1);
});

test('every finished run is retained as an exchange — user turns, wakes, automations — and a failed one is not', async () => {
  const { host, engine } = setup({ script: () => [say('The launch is Friday.')] });
  const ada = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const bo = host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });

  host.userRequest({ agent_id: ada.id, text: 'When do we launch?' });
  await host.drain();
  await host.memory.flush();
  const user = engine.retained.find((r) => r.item.metadata.source === 'exchange');
  assert.equal(user.bank, 'agent-agt_a', 'an agent\'s exchanges are its own experience');
  assert.equal(user.item.context, 'conversation with the user');
  assert.match(user.item.content, /The user asked Ada: When do we launch\?\nAda answered: The launch is Friday\./);
  assert.match(user.item.metadata.run_id, /^run/);

  // The turn log line is written to disk but not retained again: the exchange covers it.
  const turnLogRetains = engine.retained.filter((r) => r.item.metadata.source === 'turn_log');
  assert.equal(turnLogRetains.length, 0);
  assert.ok(host.memory.factsIn('agent', ada.id).some((f) => f.source === 'turn_log'));

  host.deliverPeerMessage({ sender_id: ada.id, target_id: bo.id, text: 'Bo, the deploy will not start.' });
  await host.drain();
  await host.memory.flush();
  const wake = engine.retained.find((r) => r.bank === 'agent-agt_b' && r.item.metadata.source === 'exchange');
  assert.ok(wake, 'a wake leaves memory behind too');
  assert.equal(wake.item.context, 'messages from teammates');
  assert.match(wake.item.content, /Ada \(teammate\) to Bo: Bo, the deploy will not start\./);

  const before = engine.retained.length;
  host.adapter.script = () => { throw new Error('boom'); };
  host.userRequest({ agent_id: ada.id, text: 'boom' });
  await host.drain().catch(() => {});
  await host.memory.flush();
  assert.equal(engine.retained.length, before, 'a failed turn is not memory');
});

test('a meeting\'s outcome lands in project memory, written by the host', async () => {
  const { host, engine } = setup({ script: ({ agent_id }) => [say(agent_id === 'agt_a' ? 'Ship it.' : 'Agreed, ship Friday.')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'ship or not?', memory: 'project' });
  await host.runRoom(room.id, { request: 'decide' });
  await host.memory.flush();

  const meeting = engine.retained.find((r) => r.item.metadata.source === 'exchange' && r.bank === 'project-default');
  assert.ok(meeting, 'the room outcome was retained');
  assert.equal(meeting.item.metadata.writer_agent_id, 'host');
  assert.equal(meeting.item.context, 'meeting: ship or not?');
  assert.match(meeting.item.content, /Ada: Ship it\./);
  assert.match(meeting.item.content, /Bo: Agreed, ship Friday\./);
  assert.ok(!engine.retained.some((r) => r.bank.startsWith('agent-') && /meeting/.test(r.item.context ?? '')), 'no member\'s private bank got the meeting');
});

test('the Recall tool searches only this agent\'s own and shared scopes, notes included, and cannot name another agent', async () => {
  const { host, engine } = setup();
  const ada = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  engine.seed('agent-agt_a', [result('Filed: the vault code is in the safe.', { tier: 'note' })]);
  engine.seed('agent-agt_b', [result('Bo\'s private plan.')]);
  engine.seed('user-user', [result('Alex prefers short answers.', { tier: 'profile' })]);

  const tool = host.tools.get('Recall');
  assert.equal(tool.input_schema.properties.scope.enum.includes('agent'), true);
  assert.equal('agent_id' in tool.input_schema.properties, false, 'there is no way to ask for someone else\'s memory');

  const out = await tool.handler({ agent: host.registry.get(ada.id), input: { query: 'where is the vault code' } });
  assert.ok(out.results.some((r) => r.tier === 'note' && /vault/.test(r.text)), 'notes are reachable by explicit recall');
  assert.ok(out.results.some((r) => /short answers/.test(r.text)));
  assert.ok(!out.results.some((r) => /Bo's private/.test(r.text)));
  assert.deepEqual(engine.recalled.map((r) => r.bank).sort(), ['agent-agt_a', 'project-default', 'user-user']);

  // The model sees the tool.
  assert.ok(host.tools.describeFor(host.registry.get(ada.id)).some((t) => t.name === 'Recall'));
});

test('the envelope reports which engine ranked memory, so a fallback is visible', async () => {
  const { host } = setup();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const context = await buildContext({
    agent: host.registry.get(a.id), payload: { kind: 'user', text: 'hello' },
    registry: host.registry, transcripts: host.transcripts, memory: host.memory, tools: host.tools, workflows: host.workflows,
  });
  assert.equal(context.memory_budget.engine, 'fake');
});

test('the model is told what day it is, because memory keeps dated facts', async () => {
  const { host } = setup();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const context = await buildContext({
    agent: host.registry.get(a.id), payload: { kind: 'user', text: 'hello' }, now: '2026-09-04T15:00:00Z',
    registry: host.registry, transcripts: host.transcripts, memory: host.memory, tools: host.tools, workflows: host.workflows,
  });
  assert.equal(context.today, '2026-09-04');
  const { system } = renderMessages(context);
  assert.match(system, /Today is 2026-09-04 \(Friday\)/);
  assert.match(system, /call Recall to search/);
});

test('the first touch of a bank makes it ours: Memory Defense on, one standing-knowledge model, once per bank', async () => {
  const { host, engine } = setup();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.memory.remember({ scope: 'agent', owner_id: a.id, writer_agent_id: a.id, tier: 'log', text: 'one' });
  host.memory.remember({ scope: 'agent', owner_id: a.id, writer_agent_id: a.id, tier: 'log', text: 'two' });
  await host.memory.recall({ agent_id: a.id, scopes: [{ scope: 'project', owner_id: 'default' }], query: 'anything' });
  await host.memory.flush();
  assert.deepEqual(engine.ensured.map((e) => e.bank).sort(), ['agent-agt_a', 'project-default'], 'each bank ensured exactly once');
  const agentBank = engine.ensured.find((e) => e.bank === 'agent-agt_a');
  assert.match(agentBank.opts.standing_query, /keep in mind at all times/);
  assert.match(engine.ensured.find((e) => e.bank === 'project-default').opts.standing_query, /shared project/);
});

test('standing knowledge is read as a row and shown before the ranked facts; absent means nothing is shown', async () => {
  const { host, engine } = setup();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  engine.standing.set('agent-agt_a', 'Ada is the release manager and owns the Friday launch.');
  engine.standing.set('user-user', 'Alex prefers one-line answers.');
  const envelope = () => buildContext({
    agent: host.registry.get(a.id), payload: { kind: 'user', text: 'what next?' },
    registry: host.registry, transcripts: host.transcripts, memory: host.memory, tools: host.tools, workflows: host.workflows,
    scopes: [{ scope: 'project', owner_id: 'default' }, { scope: 'user', owner_id: 'user' }],
  });
  const ctx = await envelope();
  assert.deepEqual(ctx.standing_knowledge.map((k) => k.scope).sort(), ['agent', 'user'], 'the project bank has none yet, so it is not shown');
  const { system } = renderMessages(ctx);
  assert.match(system, /Consolidated memory \(historical evidence/);
  assert.ok(system.indexOf('release manager') < system.indexOf('Your transcript window'), 'standing knowledge is part of the identity block');
  assert.match(system, /The person you work for\nAlex prefers one-line answers\./);

  // Another agent never sees Ada's standing knowledge.
  const b = host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  const forBo = await host.memory.recall({ agent_id: b.id, scopes: [{ scope: 'user', owner_id: 'user' }], query: 'what next?' });
  assert.deepEqual(forBo.standing.map((k) => k.scope), ['user']);
});

test('a standing-knowledge placeholder is not knowledge', async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ content: 'Generating content...\n', last_refreshed_at: null }) }; };
  const engine = new HindsightEngine({ url: 'http://h', api_key: 'k', fetch });
  assert.equal(await engine.standingKnowledge('agent-x'), null);
  const written = new HindsightEngine({ url: 'http://h', api_key: 'k', fetch: async () => ({ ok: true, status: 200, json: async () => ({ content: '## Yourself\nYou verify.', last_refreshed_at: 't' }) }) });
  assert.deepEqual(await written.standingKnowledge('agent-x'), { text: '## Yourself\nYou verify.', refreshed_at: 't' });
  const missing = new HindsightEngine({ url: 'http://h', api_key: 'k', fetch: async () => ({ ok: false, status: 404, text: async () => 'not found' }) });
  assert.equal(await missing.standingKnowledge('agent-x'), null, 'a bank without one yet is simply empty');
});

test('a private meeting is remembered by its members only, so an agent kept out of the room never inherits it', async () => {
  const { host, engine } = setup({ script: ({ agent_id }) => [say(agent_id === 'agt_a' ? 'Buy.' : 'Agreed, buy.')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  host.registry.create({ id: 'agt_v', profile: { name: 'Verify' } });
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'step 1: pick a signal', memory: 'members' });
  await host.runRoom(room.id, { request: 'decide' });
  await host.memory.flush();

  const meetings = engine.retained.filter((r) => /meeting/.test(r.item.context ?? ''));
  assert.deepEqual(meetings.map((r) => r.bank).sort(), ['agent-agt_a', 'agent-agt_b'], 'each member remembers it in its own bank');
  assert.ok(!engine.retained.some((r) => r.bank === 'project-default'), 'nothing went to shared memory');
  assert.ok(!engine.retained.some((r) => r.bank === 'agent-agt_v'), 'the verifier has nothing to recall');
  assert.match(meetings[0].item.context, /private to its members/);

  const forgotten = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'scratch', memory: 'none' });
  const before = engine.retained.length;
  await host.runRoom(forgotten.id, { request: 'x' });
  await host.memory.flush();
  assert.equal(engine.retained.length, before, 'memory: none leaves only the transcript');
  assert.throws(() => host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'x', memory: 'everyone' }), /bad_room_memory|one of/);
});

test('switching an existing private room off stops future Hindsight retention without deleting its transcript', async () => {
  const { host, engine } = setup({ script: ({ payload }) => [say(payload.epoch === 2 ? 'Previous judgment.' : 'Fresh judgment.')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const room = host.createRoom({ member_ids: ['agt_a'], purpose: 'independent review', memory: 'members' });
  await host.runRoom(room.id, { request: 'First case' });
  await host.memory.flush();
  const retainedBeforeOff = engine.retained.length;
  assert.ok(retainedBeforeOff > 0, 'the original private discussion was retained');

  host.rooms.update(room.id, { memory: 'none' });
  await host.runRoom(room.id, { request: 'Second case' });
  await host.memory.flush();
  assert.equal(engine.retained.length, retainedBeforeOff, 'the Off discussion created no new Hindsight writes');
  assert.match(host.transcripts.all('room', room.id).map((entry) => entry.text).join(' '), /Previous judgment/);
  assert.match(host.transcripts.all('room', room.id).map((entry) => entry.text).join(' '), /Fresh judgment/);
});


test('live roster survives historical memory and records an empty team after deletion', async () => {
  const { host, engine } = setup();
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'Ada', description: 'Old team: Bo is your lead.' } });
  const b = host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  engine.standing.set('agent-agt_a', 'Bo is the current team lead.');
  const envelope = () => buildContext({ agent: host.registry.get(a.id), payload: { kind: 'user', text: 'Who remains?' }, registry: host.registry, transcripts: host.transcripts, memory: host.memory, tools: host.tools });
  let system = renderMessages(await envelope()).system;
  assert.match(system, /Other currently registered agents: Bo \(agt_b\)/);
  await host.deleteAgent(b.id, { confirm: true });
  system = renderMessages(await envelope()).system;
  assert.match(system, /There are no other currently registered agents/);
  assert.ok(system.indexOf('Current host roster') > system.indexOf('Bo is the current team lead'));
  assert.match(system, /workspace contents do not establish existence or deletion/);
  assert.match(system, /Being registered does not prove an agent is running/);
});
