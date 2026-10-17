import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter, toAnthropicMessages, toAnthropicTools, DEFAULT_MODEL } from '../src/model/anthropic-adapter.js';
import { makeHost } from './helpers.js';

// The provider adapter shares the common contract
// and nothing else in the host changes. Driven with a fake client so the suite
// stays offline and dependency-free.

function fakeClient(events, final = { usage: { input_tokens: 10, output_tokens: 4 }, stop_reason: 'end_turn' }) {
  let aborted = false;
  return {
    aborted: () => aborted,
    messages: {
      stream() {
        const stream = {
          abort() { aborted = true; },
          async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
          async finalMessage() { return final; },
        };
        return stream;
      },
    },
  };
}

test('the adapter maps a Claude stream onto host events', async () => {
  const client = fakeClient([
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the page.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'SendToAgent' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"target_id":"agt_b",' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"message":"hi"}' } },
    { type: 'content_block_stop', index: 1 },
  ]);
  const adapter = new AnthropicAdapter({ client });

  const events = [];
  for await (const event of adapter.stream([{ role: 'user', content: 'go' }], [], { system: 'you are a test' })) {
    events.push(event);
  }

  assert.deepEqual(events[0], { type: 'text', text: 'Checking the page.' });
  assert.deepEqual(events[1], { type: 'tool_call', id: 'toolu_1', name: 'SendToAgent', input: { target_id: 'agt_b', message: 'hi' } });
  assert.equal(events[2].type, 'usage');
  assert.equal(events[2].usage.authoritative, false, 'usage is labelled an estimate');
  assert.equal(events[3].type, 'done');
  assert.equal(adapter.model, DEFAULT_MODEL);
});

test('cancel aborts the provider stream', async () => {
  const client = fakeClient([
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_stop', index: 1 },
  ]);
  const adapter = new AnthropicAdapter({ client });

  const events = [];
  for await (const event of adapter.stream([{ role: 'user', content: 'go' }], [])) {
    events.push(event);
    adapter.cancel('supersede');
  }
  assert.equal(events.length, 1, 'the stream stopped at the cancellation');
  assert.equal(client.aborted(), true);
  assert.equal(adapter.cancelled, 'supersede');
});

test('the neutral turn shape maps onto Anthropic tool blocks', () => {
  const mapped = toAnthropicMessages([
    { role: 'user', content: 'build it' },
    { role: 'assistant', content: 'writing the file', tool_calls: [{ id: 'toolu_1', name: 'SandboxWriteFile', input: { path: 'a.txt' } }] },
    { role: 'tool_results', results: [{ call_id: 'toolu_1', name: 'SandboxWriteFile', output: { ok: true } }] },
    { role: 'tool_results', results: [{ call_id: 'toolu_2', name: 'LocalReadFile', output: { ok: false, error: 'permission_blocked' } }] },
  ]);

  assert.deepEqual(mapped[1].content, [
    { type: 'text', text: 'writing the file' },
    { type: 'tool_use', id: 'toolu_1', name: 'SandboxWriteFile', input: { path: 'a.txt' } },
  ]);
  assert.equal(mapped[2].role, 'user');
  assert.equal(mapped[2].content[0].type, 'tool_result');
  assert.equal(mapped[2].content[0].tool_use_id, 'toolu_1');
  assert.equal(mapped[2].content[0].is_error, false);
  assert.equal(mapped[3].content[0].is_error, true, 'a blocked tool call is reported as an error result');
});

test('tool definitions carry their side effect into the model prompt', () => {
  const { host } = makeHost({});
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  const tools = toAnthropicTools(host.tools.describeFor(agent));

  const send = tools.find((t) => t.name === 'SendToAgent');
  assert.match(send.description, /Side effect: Queues a durable message/);
  assert.equal(send.input_schema.type, 'object');
  assert.deepEqual(send.input_schema.required, ['target_id', 'message']);
});

test('the adapter honours the shared ModelAdapter contract', () => {
  const adapter = new AnthropicAdapter({ apiKey: 'test' });
  assert.equal(adapter.provider, 'anthropic');
  assert.match(adapter.reportUsage().note, /not authoritative billing data/);
  assert.equal(adapter.reportUsage().authoritative, false);

  // normalize_tool_call collapses every provider shape onto one shape.
  assert.deepEqual(
    adapter.normalizeToolCall({ id: 'toolu_1', name: 'X', input: { a: 1 } }),
    { id: 'toolu_1', name: 'X', input: { a: 1 } },
  );
  assert.deepEqual(
    adapter.normalizeToolCall({ tool_call_id: 'c1', function: { name: 'Y' }, arguments: '{"b":2}' }),
    { id: 'c1', name: 'Y', input: { b: 2 } },
  );
  assert.deepEqual(adapter.normalizeToolCall({ id: 'c2', name: 'Z' }), { id: 'c2', name: 'Z', input: {} });
  assert.deepEqual(
    adapter.normalizeToolCall({ id: 'c3', name: 'W', arguments: 'not json' }).input,
    { _raw: 'not json' },
  );
});

test('a cancellation applies to one stream, not to the adapter for all time', async () => {
  const { ScriptedAdapter } = await import('../src/model/scripted-adapter.js');
  const adapter = new ScriptedAdapter(() => [{ type: 'text', text: 'hello' }]);

  const first = [];
  for await (const event of adapter.stream([], [], {})) {
    first.push(event);
    adapter.cancel('supersede');
  }
  assert.equal(first.length, 1, 'the cancelled stream stopped early');

  // The next turn must not be silently empty.
  const second = [];
  for await (const event of adapter.stream([], [], {})) second.push(event);
  assert.equal(second[0].text, 'hello');
  assert.equal(second.at(-1).type, 'done');
});

test('an interrupted run does not silently empty the next room turn', async () => {
  const { makeHost: mk, say: text } = await import('./helpers.js');
  const { host } = mk({ script: () => [text('a view')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'B' } });

  host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'background', payload: { kind: 'bg' } });
  const running = host.scheduler.pump('agt_a');
  host.scheduler.interrupt('agt_a', { reason: 'supersede' });
  await running;

  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'after an interrupt' });
  const result = await host.runRoom(room.id, { request: 'still working?' });
  assert.ok(result.total_messages > 0, 'the room still produces messages after an interrupt');
});

test('the adapter bounds a pathological request instead of hanging forever', async () => {
  let constructedWith = null;
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test', timeout_ms: 1234 });
  assert.equal(adapter.timeout_ms, 1234);
  assert.equal(new AnthropicAdapter({ apiKey: 'sk-test' }).timeout_ms, 600_000);

  // The timeout reaches the client that actually makes the request.
  const stub = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {}, async finalMessage() { return {}; } }) } };
  const withClient = new AnthropicAdapter({ client: stub, timeout_ms: 50 });
  const events = [];
  for await (const e of withClient.stream([{ role: 'user', content: 'hi' }], [])) events.push(e);
  assert.equal(events.at(-1).type, 'done');
});

test('the CLI only uses the paid provider when credentials exist', async () => {
  const { liveProvider } = await import('../src/cli.js');
  const { PROVIDERS } = await import('../web/models.js');
  // A developer's machine can carry unrelated keys (GLMMODELS_API_KEY, OPENAI…),
  // so clear every provider credential the registry knows, not just Anthropic's.
  const saved = {};
  const clear = (names) => { for (const name of names) { saved[name] = process.env[name]; delete process.env[name]; } };
  clear([['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BETTER_BOTS_PROVIDER', 'BETTER_BOTS_DEFAULT_PROVIDER'].concat(
    Object.values(PROVIDERS).flatMap((spec) => spec.key_env ?? []))].flat());
  try {
    assert.equal(liveProvider(), false, 'no credentials means the scripted stand-in');
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assert.equal(liveProvider(), true);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.ANTHROPIC_API_KEY;
    const original = saved.ANTHROPIC_API_KEY;
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('per-bot GLM reasoning level reaches provider without changing other bots', async () => {
  const client = fakeClient([]);
  const original = client.messages.stream;
  const bodies = [];
  client.messages.stream = body => { bodies.push(body); return original(); };
  const adapter = new AnthropicAdapter({ client, effort: 'high' });
  for (const effort of ['low', 'max', undefined]) {
    for await (const _ of adapter.stream([], [], { provider: 'glm', model: 'glm-5.3-flash', reasoning_effort: effort })) {}
  }
  assert.deepEqual(bodies.map(b => b.output_config.effort), ['low', 'max', 'high']);
});
