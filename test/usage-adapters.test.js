import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatAdapter } from '../src/model/openai-adapter.js';
import { CodexAdapter } from '../src/model/codex-adapter.js';
import { AnthropicAdapter } from '../src/model/anthropic-adapter.js';
import { RoutingAdapter } from '../src/model/routing-adapter.js';
import { ModelAdapter } from '../src/model/adapter.js';
import { recordUsage, totalUsage } from '../src/services/usage-totals.js';

// Usage records are labeled with where their numbers came from,
// and a provider's token counts are never presented as billing data. Driven
// offline with fake transports: with a usage frame, BOTH the adapter
// cumulative total and the emitted per-call record say 3, not the 5 a
// double-add of estimate and frame would give.

const TEXT_8_CHARS = { choices: [{ delta: { content: '12345678' } }] };
const FRAME_3 = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
const STOP = { choices: [{ delta: {}, finish_reason: 'stop' }] };

function sse(chunks) {
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''), { status: 200 });
}

async function drain(adapter, settings) {
  const events = [];
  for await (const event of adapter.stream([{ role: 'user', content: 'hi' }], [], settings)) events.push(event);
  return events;
}

test('openai: a provider usage frame is reported once, as provider-reported', async () => {
  let request = null;
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return sse([TEXT_8_CHARS, FRAME_3]);
    },
  });

  const events = await drain(adapter);
  const records = events.filter((e) => e.type === 'usage');
  assert.equal(records.length, 1, 'exactly one usage record per call');
  const record = records[0].usage;
  assert.match(record.call_id, /^call_/, 'each call carries a stable unique id');
  assert.equal(record.provenance, 'provider_reported');
  assert.equal(record.authoritative, false, 'a token frame is not billing authority');
  assert.deepEqual(record.call, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(adapter._usage.output_tokens, 3, 'cumulative total counts the call once');
  assert.equal(adapter.reportUsage().output_tokens, 3);
  assert.equal(adapter.reportUsage().provenance, 'provider_reported');
  assert.ok(request.stream_options?.include_usage, 'the adapter asks the provider for usage');
});

test('openai: no usage frame still yields an explicitly estimated record', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([TEXT_8_CHARS, STOP]),
  });

  const events = await drain(adapter);
  const records = events.filter((e) => e.type === 'usage');
  assert.equal(records.length, 1, 'the estimate is emitted, not withheld');
  const record = records[0].usage;
  assert.equal(record.provenance, 'estimated');
  assert.equal(record.authoritative, false);
  assert.equal(record.call.output_tokens, 2, 'eight output characters at four per token');
  assert.equal(record.call.input_tokens, 0, 'no invented input tokens');
  assert.equal(adapter._usage.output_tokens, 2, 'adapter total and event total agree');
});

test('openai: neither frame nor output is unknown, not a fabricated zero', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([STOP]),
  });

  const events = await drain(adapter);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'unknown');
  assert.deepEqual(record.call, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test('openai: mixed calls aggregate once each and report mixed provenance', async () => {
  const calls = [];
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return calls.length === 1 ? sse([TEXT_8_CHARS, FRAME_3]) : sse([TEXT_8_CHARS, STOP]);
    },
  });

  const first = await drain(adapter);
  const second = await drain(adapter);
  const idA = first.find((e) => e.type === 'usage').usage.call_id;
  const idB = second.find((e) => e.type === 'usage').usage.call_id;
  assert.notEqual(idA, idB, 'call ids are unique per call');
  assert.equal(adapter._usage.output_tokens, 5, '3 provider-reported + 2 estimated, once each');
  assert.equal(adapter.reportUsage().provenance, 'mixed');
});

test('openai: duplicate usage frames collapse to one record, last frame wins', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([TEXT_8_CHARS, FRAME_3, { choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 4 } }]),
  });

  const events = await drain(adapter);
  const records = events.filter((e) => e.type === 'usage');
  assert.equal(records.length, 1);
  assert.equal(records[0].usage.call.output_tokens, 4);
  assert.equal(adapter._usage.output_tokens, 4, 'a duplicate frame cannot double-add');
});

test('openai: a runtime that rejects stream_options falls back without it', async () => {
  const bodies = [];
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.stream_options) return new Response('stream_options is not supported here', { status: 400 });
      return sse([TEXT_8_CHARS, FRAME_3]);
    },
  });

  const events = await drain(adapter);
  assert.equal(bodies.length, 2, 'one fallback request');
  assert.ok(bodies[0].stream_options);
  assert.ok(!bodies[1].stream_options);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'provider_reported');
  assert.equal(record.call.output_tokens, 3);
});

test('openrouter: agentic-harness restriction reports the model and reason without response details', async () => {
  let calls = 0;
  const adapter = new OpenAICompatAdapter({
    provider: 'openrouter', model: 'thinkingmachines/inkling:free', apiKey: 'fake-key',
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: {
        message: 'thinkingmachines/inkling:free is only available on agentic harnesses. See https://openrouter.ai/apps',
        code: 403,
        metadata: { routing_funnel: [{ step: 'Initial Endpoints' }], request: 'private prompt' },
      } }), { status: 403 });
    },
  });

  await assert.rejects(drain(adapter), (error) => {
    assert.equal(error.message, 'openrouter (thinkingmachines/inkling:free) returned 403: thinkingmachines/inkling:free is only available on agentic harnesses.');
    assert.doesNotMatch(error.message, /https?:|routing_funnel|private prompt|fake-key|\{\"/);
    return true;
  });
  assert.equal(calls, 1, 'a provider restriction is not retried');
});

test('openrouter: generic 429 uses the upstream rate-limit reason without raw JSON', async () => {
  let calls = 0;
  const adapter = new OpenAICompatAdapter({
    provider: 'openrouter', model: 'qwen/qwen3.8-27b:free', apiKey: 'fake-key',
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: {
        message: 'Provider returned error', code: 429,
        metadata: { raw: 'qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly, or add your own key: https://openrouter.ai/settings/integrations', provider_name: 'ModelRun' },
      } }), { status: 429 });
    },
  });

  await assert.rejects(drain(adapter), (error) => {
    assert.equal(error.message, 'openrouter (qwen/qwen3.8-27b:free) returned 429: qwen/qwen3.8-27b:free is temporarily rate-limited upstream.');
    assert.doesNotMatch(error.message, /https?:|provider_name|fake-key|\{\"/);
    return true;
  });
  assert.equal(calls, 1, 'an upstream rate limit is not retried');
});

test('openrouter: malformed error body is not echoed', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'openrouter', model: 'test-model', apiKey: 'fake-key',
    fetchImpl: async () => new Response('bad response with private prompt and https://example.test', { status: 502 }),
  });
  await assert.rejects(drain(adapter), /openrouter \(test-model\) returned 502: Provider request failed$/);
});

test('openrouter: a structured error echoing prompt or credentials is not displayed', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'openrouter', model: 'test-model', apiKey: 'fake-key',
    fetchImpl: async () => new Response(JSON.stringify({ error: {
      message: 'Provider returned error',
      metadata: { raw: 'Request body prompt and Authorization: Bearer private-token were rejected.' },
    } }), { status: 400 }),
  });
  await assert.rejects(drain(adapter), (error) => {
    assert.equal(error.message, 'openrouter (test-model) returned 400: Provider request failed');
    return true;
  });
});

test('openai: an aborted call emits no usage record', async () => {
  const controller = new AbortController();
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([{ choices: [{ delta: { reasoning_content: 'hmm' } }] }, STOP]),
  });

  const events = [];
  for await (const event of adapter.stream([{ role: 'user', content: 'hi' }], [], { signal: controller.signal })) {
    events.push(event);
    if (event.type === 'thinking') controller.abort();
  }
  assert.ok(events.some((e) => e.type === 'thinking'), 'the stream was live when aborted');
  assert.ok(!events.some((e) => e.type === 'usage'), 'no usage record after an abort');
});

test('codex: response.completed usage is provider-reported and counted once', async () => {
  const adapter = new CodexAdapter({
    model: 'test-model',
    auth: { credentials: async () => ({ access_token: 'test-token' }) },
    fetchImpl: async () => new Response(
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
      + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2,"input_tokens_details":{"cached_tokens":5}}}}\n\n',
    ),
  });

  const events = await drain(adapter);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.match(record.call_id, /^call_/);
  assert.equal(record.provenance, 'provider_reported');
  assert.equal(record.authoritative, false);
  assert.deepEqual(record.call, { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 });
  assert.equal(adapter._usage.output_tokens, 2);
});

test('anthropic: final message usage is provider-reported with the billing caveat', async () => {
  const adapter = new AnthropicAdapter({
    client: { messages: { stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking the page.' } };
          yield { type: 'content_block_stop', index: 0 };
        },
        finalMessage: async () => ({ usage: { input_tokens: 10, output_tokens: 4 }, stop_reason: 'end_turn' }),
      };
    } } },
  });

  const events = await drain(adapter);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.match(record.call_id, /^call_/);
  assert.equal(record.provenance, 'provider_reported');
  assert.equal(record.authoritative, false, 'provider token counts are not billing data');
  assert.deepEqual(record.call, { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(adapter._usage.output_tokens, 4);
  assert.match(adapter.reportUsage().note, /not authoritative billing data/);
  assert.equal(adapter.reportUsage().authoritative, false);
});

test('openai: tool-only output estimates from the tool call, never a silent zero', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ReadFile', arguments: '{"path":"/tmp/notes.txt"}' } }] } }] }, STOP]),
  });

  const events = await drain(adapter);
  assert.ok(events.some((e) => e.type === 'tool_call'), 'the tool call still arrives');
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'estimated');
  assert.ok(record.call.output_tokens > 0, 'the estimate accounts for the tool call, not just text');
  assert.match(record.note, /tool-call arguments/);
});

test('openai: mixed text and tool-call output both feed the estimate', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([
      { choices: [{ delta: { content: '12345678' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Ab', arguments: '{"k":"v"}' } }] } }] },
      STOP,
    ]),
  });

  const events = await drain(adapter);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'estimated');
  // 8 text characters + 2 name characters + 9 argument characters = 19 -> ceil(19/4).
  assert.equal(record.call.output_tokens, Math.ceil(19 / 4));
});

test('openai: a negative-only frame is not provider-reported zero', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([TEXT_8_CHARS, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: -4, completion_tokens: -2 } }]),
  });

  const events = await drain(adapter);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'estimated', 'garbage numbers fall back to the honest estimate');
  assert.equal(record.call.output_tokens, 2);
});

test('openai: one valid field beside a negative one is provider-reported with clamped values', async () => {
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([TEXT_8_CHARS, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: -5, completion_tokens: 10 } }]),
  });

  const events = await drain(adapter);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'provider_reported');
  assert.equal(record.call.input_tokens, 0, 'the invalid field clamps to zero');
  assert.equal(record.call.output_tokens, 10, 'the valid field survives');
});

test('openai: a 400 echoing the request body is a real failure, not a usage-field rejection', async () => {
  const bodies = [];
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'bogus-model',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response("Model 'bogus-model' not found. Request: " + JSON.stringify({ model: 'bogus-model', stream_options: { include_usage: true } }), { status: 400 });
    },
  });

  await assert.rejects(drain(adapter), /bogus-model/);
  assert.equal(bodies.length, 1, 'no retry for a 400 that merely echoes the field');
});

test('openai: strict-backend field rejections still fall back once', async () => {
  const bodies = [];
  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.stream_options) return new Response('422: stream_options"],"msg":"extra fields not permitted', { status: 400 });
      return sse([TEXT_8_CHARS, FRAME_3]);
    },
  });

  const events = await drain(adapter);
  assert.equal(bodies.length, 2);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'provider_reported');
  assert.equal(record.call.output_tokens, 3);
});

test('reportUsage notes agree with their provenance class', async () => {
  const fresh = new ModelAdapter({ provider: 'local', model: 'm' });
  assert.equal(fresh.reportUsage().provenance, 'unknown');
  assert.match(fresh.reportUsage().note, /No usage recorded yet/);
  assert.match(fresh.reportUsage().note, /not authoritative billing data/);

  const adapter = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([TEXT_8_CHARS, FRAME_3]),
  });
  await drain(adapter);
  assert.equal(adapter.reportUsage().provenance, 'provider_reported');
  assert.match(adapter.reportUsage().note, /Provider-reported/);
  assert.match(adapter.reportUsage().note, /not authoritative billing data/);

  const estimator = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async () => sse([TEXT_8_CHARS, STOP]),
  });
  await drain(estimator);
  assert.match(estimator.reportUsage().note, /Estimated/);

  const both = new OpenAICompatAdapter({
    provider: 'local', model: 'test-model',
    fetchImpl: async (_url, init) => {
      if (!both.seen) both.seen = 0;
      both.seen += 1;
      return both.seen === 1 ? sse([TEXT_8_CHARS, FRAME_3]) : sse([TEXT_8_CHARS, STOP]);
    },
  });
  await drain(both);
  await drain(both);
  assert.equal(both.reportUsage().provenance, 'mixed');
  assert.match(both.reportUsage().note, /mix provider-reported and estimated/);
});

test('anthropic: a missing or malformed final usage is unknown, not zero provider-reported', async () => {
  const make = (final) => new AnthropicAdapter({
    client: { messages: { stream() {
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: async () => final,
      };
    } } },
  });

  for (const final of [{ stop_reason: 'end_turn' }, { usage: 'seven tokens', stop_reason: 'end_turn' }, { usage: { input_tokens: -3 }, stop_reason: 'end_turn' }]) {
    const adapter = make(final);
    const events = await drain(adapter);
    const record = events.find((e) => e.type === 'usage').usage;
    assert.equal(record.provenance, 'unknown', JSON.stringify(final));
    assert.equal(record.authoritative, false);
    assert.equal(record.call.input_tokens, 0);
    assert.equal(record.call.output_tokens, 0);
  }

  const zeros = make({ usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' });
  const events = await drain(zeros);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'provider_reported', 'legitimate measured zeros stay valid');
  assert.equal(record.call.output_tokens, 0);
});

test('codex: malformed terminal usage is unknown; repeated completed frames stay one call', async () => {
  const frame = (usage) => `data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`;
  const adapter = new CodexAdapter({
    model: 'test-model',
    auth: { credentials: async () => ({ access_token: 'test-token' }) },
    fetchImpl: async () => new Response(
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
      + frame({ input_tokens: 7, output_tokens: 2 })
      + frame({ input_tokens: 7, output_tokens: 2 })
      + 'data: {"type":"response.completed","response":{"usage":"gone"}}\n\n',
    ),
  });

  const events = await drain(adapter);
  const records = events.filter((e) => e.type === 'usage');
  assert.equal(records.length, 1, 'retransmitted terminal frames are not extra calls');
  const record = records[0].usage;
  assert.equal(record.provenance, 'provider_reported');
  assert.equal(adapter._usage.input_tokens, 7, 'adapter total is 7, not 14');
  assert.equal(adapter._usage.output_tokens, 2, 'adapter total is 2, not 4');

  // Even if a stream did emit the same final record twice, the host contract
  // dedupes by call_id instead of adding.
  const recordsMap = new Map();
  recordUsage(recordsMap, record.call_id, record);
  recordUsage(recordsMap, record.call_id, record);
  const totals = totalUsage(recordsMap.values());
  assert.equal(totals.input_tokens, 7);
  assert.equal(totals.output_tokens, 2);
});

test('codex: a terminal frame without usable usage is unknown, not zero provider-reported', async () => {
  const adapter = new CodexAdapter({
    model: 'test-model',
    auth: { credentials: async () => ({ access_token: 'test-token' }) },
    fetchImpl: async () => new Response(
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
      + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":"many"}}}\n\n',
    ),
  });

  const events = await drain(adapter);
  const record = events.find((e) => e.type === 'usage').usage;
  assert.equal(record.provenance, 'unknown');
  assert.equal(record.call.output_tokens, 0);
});

test('routing: aggregate provenance is derived, not hardcoded mixed', () => {
  const fresh = () => new ModelAdapter({ provider: 'local', model: 'm' });

  const empty = new RoutingAdapter({ routes: { a: fresh(), b: fresh() } });
  assert.equal(empty.reportUsage().provenance, 'unknown', 'no calls anywhere is unknown');

  const homogeneous = new RoutingAdapter({ routes: { a: fresh(), b: fresh() } });
  homogeneous.routes.a.noteUsage({ provenance: 'provider_reported', call: { input_tokens: 1 } });
  homogeneous.routes.b.noteUsage({ provenance: 'provider_reported', call: { input_tokens: 1 } });
  assert.equal(homogeneous.reportUsage().provenance, 'provider_reported');

  const mixed = new RoutingAdapter({ routes: { a: fresh(), b: fresh() } });
  mixed.routes.a.noteUsage({ provenance: 'provider_reported', call: { input_tokens: 1 } });
  mixed.routes.b.noteUsage({ provenance: 'estimated', call: { output_tokens: 1 } });
  assert.equal(mixed.reportUsage().provenance, 'mixed');
});
