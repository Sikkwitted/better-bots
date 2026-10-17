import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, makeGate, say, call } from './helpers.js';
import { buildContext, recallQuery, DEFAULT_TRANSCRIPT_TAIL } from '../src/context.js';
import { AnthropicAdapter } from '../src/model/anthropic-adapter.js';

// What the person sees while a model works, and what survives the turn:
// reasoning streams in the conversation, every answer names its model, the
// conversational window ignores tool chatter, and a turn leaves a log fact.

test('reasoning streams and persists before its answer without losing earlier text', async () => {
  const hold = makeGate();
  const { host } = makeHost({
    script: () => (async function* stream() {
      yield { type: 'thinking', text: 'Weighing the two options. ' };
      yield { type: 'thinking', text: 'The second is cheaper.' };
      await hold.promise;
      yield say('Go with the second.');
    })(),
  });
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  host.userRequest({ agent_id: agent.id, text: 'which one?' });
  const draining = host.drain();
  await new Promise((r) => setTimeout(r, 30));
  const live = host.status().agents.find((a) => a.id === agent.id).active_run;
  assert.equal(live.thought, 'Weighing the two options. The second is cheaper.');
  assert.equal(live.phase, 'thinking');
  hold.release();
  await draining;
  const kinds = host.transcripts.all('agent', agent.id).map((e) => e.kind);
  assert.ok(kinds.indexOf('reasoning') < kinds.indexOf('agent_text'));
  assert.equal(host.transcripts.all('agent', agent.id).find(e=>e.kind==='reasoning').text, 'Weighing the two options. The second is cheaper.');
  assert.equal(host.status().agents.find((a) => a.id === agent.id).active_run, null);
});

test('pending reasoning preserves the beginning until the host flushes it', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  host.scheduler.active.set(agent.id, { run: { id: 'run_x', agent_id: agent.id, lane: 'user' } });
  host.scheduler.markThought(agent.id, 'x'.repeat(2_000));
  assert.equal(host.scheduler.activeRun(agent.id).thought.length, 2_000);
  host.scheduler.active.delete(agent.id);
});

test('every answer records the model that produced it', async () => {
  const { host } = makeHost({ script: () => [say('hello')] });
  const pinned = host.registry.create({ profile: { name: 'Pin', model: 'glm-5.3-flash' } });
  host.userRequest({ agent_id: pinned.id, text: 'hi' });
  await host.drain();
  const entry = host.transcripts.all('agent', pinned.id).find((e) => e.kind === 'agent_text');
  assert.equal(entry.model, 'glm-5.3-flash');
});

test('tool chatter does not push the last real exchange out of the context window', async () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  host.transcripts.append('agent', agent.id, { kind: 'user_message', text: 'remember the launch date is Friday' });
  host.transcripts.append('agent', agent.id, { kind: 'agent_text', text: 'Noted.' });
  for (let i = 0; i < 150; i += 1) {
    host.transcripts.append('agent', agent.id, { kind: 'tool_call', name: 'SandboxReadFile', input: { path: `f${i}` } });
    host.transcripts.append('agent', agent.id, { kind: 'tool_result', name: 'SandboxReadFile', result: { ok: true } });
  }
  const context = await buildContext({ agent: host.registry.get(agent.id), payload: { kind: 'user', text: 'when is launch?' }, registry: host.registry, transcripts: host.transcripts, memory: host.memory, tools: host.tools, workflows: host.workflows });
  assert.deepEqual(context.recent_chat.map((e) => e.kind), ['user_message', 'agent_text']);
  assert.match(context.recent_chat[0].text, /Friday/);
});

test('a completed user turn leaves one log fact; failures, wakes, and automations do not', async () => {
  const { host } = makeHost({ script: (ctx) => (ctx.payload?.text === 'boom' ? (() => { throw new Error('provider down'); })() : [say('The launch is Friday.')]) });
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  host.userRequest({ agent_id: agent.id, text: 'When do we launch?' });
  await host.drain();
  const logs = () => host.memory.factsIn('agent', agent.id).filter((f) => f.source === 'turn_log');
  assert.equal(logs().length, 1);
  assert.match(logs()[0].text, /asked: When do we launch\? \| answered: The launch is Friday\./);
  assert.equal(logs()[0].tier, 'log');
  host.scheduleAutomation({ agent_id: agent.id, name: 'tick', text: 'status' });
  host.tickAutomations();
  await host.drain();
  assert.equal(logs().length, 1, 'automation lanes do not log');
  host.userRequest({ agent_id: agent.id, text: 'boom' });
  await host.drain().catch(() => {});
  assert.equal(logs().length, 1, 'a failed turn does not log');
});

test('the turn log keeps the point of the exchange, and waits until the window drops it', async () => {
  const answer = 'The launch is Friday. ' + 'Every other detail is padding that does not belong in memory. '.repeat(12);
  const { host } = makeHost({ script: () => [say(answer)] });
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  const envelope = (text) => buildContext({
    agent: host.registry.get(agent.id), payload: { kind: 'user', text },
    registry: host.registry, transcripts: host.transcripts,
    memory: host.memory, tools: host.tools, workflows: host.workflows,
  });

  host.userRequest({ agent_id: agent.id, text: 'When do we launch? Answer in as much detail as you like.' });
  await host.drain();
  const fact = host.memory.factsIn('agent', agent.id).find((f) => f.source === 'turn_log');

  // A fact, not a transcript: one sentence a side, however long the turn ran.
  assert.match(fact.text, /asked: When do we launch\? \| answered: The launch is Friday\./);
  assert.ok(fact.text.length < 320, `a turn log is a fact, not a copy of the turn (${fact.text.length} chars)`);
  assert.ok(fact.ref.run_id.startsWith('run'), 'it records which exchange it came from');

  // The exchange is still in the window, so recalling it would buy a duplicate.
  const now = await envelope('launch date?');
  assert.ok(!now.durable_memory.some((f) => f.source === 'turn_log'), 'held back while the transcript still shows it');
  assert.equal(now.memory_budget.already_in_prompt, 1, 'and the reason is reported, not hidden');

  // Once the window has moved past it, the fact is the only thing carrying it.
  for (let i = 0; i < DEFAULT_TRANSCRIPT_TAIL; i += 1) {
    host.transcripts.append('agent', agent.id, { kind: 'user_message', text: `a later, unrelated turn ${i}` });
  }
  const later = await envelope('launch date?');
  assert.ok(later.durable_memory.some((f) => /Friday/.test(f.text)), 'the fact outlives the window it stood in for');
  assert.equal(later.memory_budget.already_in_prompt, 0);
});

test('recall is given the request on every kind of turn, so a wake ranks by what arrived', async () => {
  assert.equal(recallQuery({ kind: 'agent_wake', messages: [{ text: 'the deploy will not start' }] }), 'the deploy will not start');
  assert.equal(recallQuery({ kind: 'automation', name: 'nightly', text: 'check the queue' }), 'nightly check the queue');
  assert.equal(recallQuery({ kind: 'user', text: 'hello' }), 'hello');

  const { host } = makeHost();
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  const keep = (text) => host.memory.remember({
    scope: 'agent', owner_id: agent.id, writer_agent_id: agent.id, tier: 'log', text,
  });
  // Written first, so on an empty query it wins on insertion order alone.
  keep('The staging certificate expires in October.');
  keep('The deploy unit refuses to start while the suite is red.');

  const context = await buildContext({
    agent: host.registry.get(agent.id),
    payload: { kind: 'agent_wake', messages: [{ sender_id: 'agt_x', text: 'the deploy will not start' }] },
    registry: host.registry, transcripts: host.transcripts,
    memory: host.memory, tools: host.tools, workflows: host.workflows,
  });
  assert.match(context.durable_memory[0].text, /deploy unit refuses/, 'the woken agent recalls what the message is about');
});

test('Remember writes a scoped fact the host owns, with the model unable to pick another agent as owner', async () => {
  const { host } = makeHost({ script: () => [
    call('Remember', { scope: 'user', tier: 'profile', text: 'Prefers short answers.' }),
    call('Remember', { scope: 'project', tier: 'log', text: 'We chose GLM for workers.' }),
    call('Remember', { scope: 'agent', tier: 'note', text: 'Check the deploy log first.' }),
  ] });
  const a = host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'B' } });
  host.userRequest({ agent_id: a.id, text: 'remember these' });
  await host.drain();
  assert.equal(host.memory.factsIn('user', 'user').length, 1);
  assert.equal(host.memory.factsIn('project', 'default').length, 1);
  assert.equal(host.memory.factsIn('agent', 'agt_a').filter((f) => f.source === 'tool').length, 1);
  assert.equal(host.memory.factsIn('agent', 'agt_b').length, 0, 'nothing can be written into another agent\'s private memory');
  assert.ok(host.tools.describeFor(host.registry.get('agt_b')).some((t) => t.name === 'Remember'));
});

test('the Anthropic adapter streams thinking deltas as thinking events', async () => {
  const client = {
    messages: {
      stream() {
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check.' } };
            yield { type: 'content_block_stop', index: 0 };
            yield { type: 'content_block_start', index: 1, content_block: { type: 'text' } };
            yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } };
            yield { type: 'content_block_stop', index: 1 };
          },
          async finalMessage() { return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }; },
        };
      },
    },
  };
  const events = [];
  for await (const event of new AnthropicAdapter({ client }).stream([{ role: 'user', content: 'go' }], [], {})) events.push(event);
  assert.deepEqual(events.filter((e) => e.type === 'thinking').map((e) => e.text), ['Let me ', 'check.']);
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['Done.']);
});

test('a run records what it cost, and the roster adds up the day', async () => {
  const { host, adapter } = makeHost({ script: () => [say('done')] });
  // Pretend the provider billed this turn: the scripted adapter reports zero, so patch its usage event.
  const original = adapter.stream.bind(adapter);
  adapter.stream = async function* (...args) {
    for await (const event of original(...args)) {
      if (event.type === 'usage') yield { type: 'usage', usage: { ...event.usage, call: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } };
      else yield event;
    }
  };
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  host.userRequest({ agent_id: agent.id, text: 'hi' });
  await host.drain();

  const result = host.visibleResults().at(-1);
  // Usage now travels with its provenance class and the billing caveat: token
  // counts are never authoritative billing data (shared adapter contract).
  assert.deepEqual(result.usage, { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, calls: 1, provenance: 'unknown', authoritative: false });
  assert.ok(host.audit.where((e) => e.type === 'run.usage' && e.input_tokens === 1200).length === 1, 'the audit has it too');
  const row = host.status().agents.find((a) => a.id === agent.id);
  assert.deepEqual(row.usage_24h, { runs: 1, input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, calls: 1, provenance: 'unknown', authoritative: false });
});

test('tool follow-ups include only the current step reply, never the accumulated run narration',async()=>{
 const {host}=makeHost();
 host.registry.create({id:'agt_repeat',profile:{name:'Repeat probe'}});
 let step=0;const captured=[];
 host.adapter.script=({messages})=>{
  captured.push(structuredClone(messages));
  return step++<3 ? [say(`Unique reply ${step}`),call('ProbeStep',{})] : [say('Finished')];
 };
 host.tools.register({name:'ProbeStep',description:'test',side_effect:'none',permission:{action:'sandbox.read_file',target:()=> 'fixture'},input_schema:{type:'object'},handler:()=>({ok:true})});
 host.userRequest({agent_id:'agt_repeat',text:'Perform three steps'});await host.drain();
 const replies=captured.at(-1).filter(m=>m.role==='assistant'&&m.tool_calls).map(m=>m.content);
 assert.deepEqual(replies,['Unique reply 1','Unique reply 2','Unique reply 3']);
});
