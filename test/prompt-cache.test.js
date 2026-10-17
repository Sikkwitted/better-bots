import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter, cacheableSystem, cacheableTools } from '../src/model/anthropic-adapter.js';

// The system prompt and tool list repeat on every step of a turn,
// so the adapter marks them cacheable. Nothing outside the adapter changes.

function recordingClient() {
  const client = {
    params: null,
    messages: {
      stream(params) {
        client.params = params;
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
            yield { type: 'content_block_stop', index: 0 };
          },
          async finalMessage() {
            return { usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 400, cache_creation_input_tokens: 20 }, stop_reason: 'end_turn' };
          },
        };
      },
    },
  };
  return client;
}

test('the system prompt and the last tool carry cache breakpoints', async () => {
  const client = recordingClient();
  const adapter = new AnthropicAdapter({ client });
  const tools = [
    { name: 'A', description: 'a', input_schema: { type: 'object', properties: {} } },
    { name: 'B', description: 'b', input_schema: { type: 'object', properties: {} } },
  ];
  const events = [];
  for await (const event of adapter.stream([{ role: 'user', content: 'go' }], tools, { system: 'you are a test' })) events.push(event);
  assert.deepEqual(client.params.system, [{ type: 'text', text: 'you are a test', cache_control: { type: 'ephemeral' } }]);
  assert.equal(client.params.tools[0].cache_control, undefined);
  assert.deepEqual(client.params.tools[1].cache_control, { type: 'ephemeral' });
  const usage = events.find((e) => e.type === 'usage').usage;
  assert.equal(usage.call.cache_read_input_tokens, 400);
  assert.equal(usage.call.cache_creation_input_tokens, 20);
  assert.equal(usage.authoritative, false);
});

test('no system prompt and no tools stay absent rather than becoming empty cache blocks', async () => {
  const client = recordingClient();
  const adapter = new AnthropicAdapter({ client });
  for await (const _ of adapter.stream([{ role: 'user', content: 'go' }], [], {})) { /* drain */ }
  assert.equal('system' in client.params, false);
  assert.deepEqual(client.params.tools, []);
  assert.deepEqual(cacheableTools([]), []);
  assert.deepEqual(cacheableSystem([{ type: 'text', text: 'already blocks' }]), [{ type: 'text', text: 'already blocks' }]);
});
