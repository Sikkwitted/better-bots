import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatAdapter } from '../src/model/openai-adapter.js';
import { CodexAdapter } from '../src/model/codex-adapter.js';
import { AnthropicAdapter } from '../src/model/anthropic-adapter.js';
import { RoutingAdapter } from '../src/model/routing-adapter.js';
import { makeGate } from './helpers.js';

async function collect(stream) {
  const events = [];
  try { for await (const event of stream) events.push(event); return { events }; }
  catch (error) { return { events, error }; }
}

for (const provider of ['local', 'codex']) {
  test(`${provider}: aborting a routed room request only cancels that HTTP request`, async () => {
    const started = makeGate();
    const requests = [];
    const fetchImpl = (_url, init) => new Promise((resolve, reject) => {
      requests.push({ signal: init.signal, resolve });
      init.signal.addEventListener('abort', () => reject(new Error('aborted request')), { once: true });
      if (requests.length === 2) started.release();
    });
    const adapter = provider === 'local'
      ? new OpenAICompatAdapter({ model: 'test-model', fetchImpl })
      : new CodexAdapter({ model: 'test-model', fetchImpl, auth: { credentials: async () => ({ access_token: 'test', account_id: 'test' }) } });
    const routed = new RoutingAdapter({ routes: { [provider]: adapter }, fallback: provider });
    const controller = new AbortController();
    const room = collect(routed.stream([], [], { signal: controller.signal }));
    const unrelated = collect(routed.stream([], [], {}));
    await started.promise;
    controller.abort('room superseded');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false);
    const body = provider === 'local'
      ? 'data: {"choices":[{"delta":{"content":"unrelated survives"}}]}\n\ndata: [DONE]\n\n'
      : 'data: {"type":"response.output_text.delta","delta":"unrelated survives"}\n\ndata: {"type":"response.completed","response":{"usage":{}}}\n\n';
    requests[1].resolve(new Response(body, { status: 200 }));
    const [a, b] = await Promise.all([room, unrelated]);
    assert.match(a.error.message, /aborted/);
    assert.equal(b.error, undefined);
    assert.ok(b.events.some((e) => e.text === 'unrelated survives'));
  });
}

test('Anthropic: room abort is scoped to its stream, including when another stream starts later', async () => {
  const started = makeGate();
  const streams = [];
  const client = { messages: { stream() {
    const gate = makeGate();
    const stream = {
      aborted: false,
      abort() { this.aborted = true; gate.release(); },
      async *[Symbol.asyncIterator]() {
        if (streams.length === 2) started.release();
        await gate.promise;
        if (this.aborted) return;
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'unrelated survives' } };
        yield { type: 'content_block_stop', index: 0 };
      },
      finalMessage: async () => ({ usage: {}, stop_reason: 'end_turn' }),
      release: gate.release,
    };
    streams.push(stream); return stream;
  } } };
  const adapter = new AnthropicAdapter({ client });
  const controller = new AbortController();
  const room = collect(adapter.stream([], [], { signal: controller.signal }));
  const unrelated = collect(adapter.stream([], [], {}));
  await started.promise;
  controller.abort('room stopped');
  assert.equal(streams[0].aborted, true);
  assert.equal(streams[1].aborted, false);
  streams[1].release();
  const [a, b] = await Promise.all([room, unrelated]);
  assert.equal(a.events.length, 0);
  assert.ok(b.events.some((e) => e.text === 'unrelated survives'));
});
