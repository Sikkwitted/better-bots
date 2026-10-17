import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, toResponsesInput } from '../src/model/codex-adapter.js';
import { OpenAICompatAdapter, toOpenAIMessages } from '../src/model/openai-adapter.js';
import { AnthropicAdapter, toAnthropicMessages } from '../src/model/anthropic-adapter.js';

const png = {
  media_type: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aX9cAAAAASUVORK5CYII=',
};
const gif = {
  media_type: 'image/gif',
  data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
};
const pngURL = `data:image/png;base64,${png.data}`;
const gifURL = `data:image/gif;base64,${gif.data}`;

// Capture the real adapter's outbound fetch/SDK request. Nothing calls a live
// provider, reads stored credentials, or invokes a model.
async function requestFor(provider, messages, reject = false) {
  let request;
  let adapter;
  if (provider === 'codex') {
    adapter = new CodexAdapter({
      model: 'test-model',
      auth: { credentials: async () => ({ access_token: 'test-token' }) },
      fetchImpl: async (_url, init) => {
        request = JSON.parse(init.body);
        return reject
          ? new Response('This model does not support image input', { status: 400 })
          : new Response('data: {"type":"response.completed","response":{"usage":{}}}\n\n');
      },
    });
  } else if (provider === 'openai-compatible') {
    adapter = new OpenAICompatAdapter({
      provider: 'local', model: 'test-model',
      fetchImpl: async (_url, init) => {
        request = JSON.parse(init.body);
        return reject
          ? new Response('This model does not support image input', { status: 400 })
          : new Response('data: [DONE]\n\n');
      },
    });
  } else {
    adapter = new AnthropicAdapter({
      model: 'test-model', apiKey: null,
      client: { messages: { stream(body) {
        request = structuredClone(body);
        if (reject) throw new Error('This model does not support image input');
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: async () => ({ usage: {}, stop_reason: 'end_turn' }),
        };
      } } },
    });
  }
  for await (const _event of adapter.stream(messages, [], { system: 'System instructions' })) { /* consume */ }
  return provider === 'codex' ? request.input : request.messages;
}

const cases = [
  {
    provider: 'codex',
    withCaption: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'Compare these images' },
      { type: 'input_image', image_url: pngURL },
      { type: 'input_image', image_url: gifURL },
    ] }],
    imageOnly: [{ type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: pngURL },
    ] }],
  },
  {
    provider: 'openai-compatible',
    withCaption: [{ role: 'system', content: 'System instructions' }, { role: 'user', content: [
      { type: 'text', text: 'Compare these images' },
      { type: 'image_url', image_url: { url: pngURL } },
      { type: 'image_url', image_url: { url: gifURL } },
    ] }],
    imageOnly: [{ role: 'system', content: 'System instructions' }, { role: 'user', content: [
      { type: 'image_url', image_url: { url: pngURL } },
    ] }],
  },
  {
    provider: 'anthropic',
    withCaption: [{ role: 'user', content: [
      { type: 'text', text: 'Compare these images' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: gif.data } },
    ] }],
    imageOnly: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
    ] }],
  },
];

for (const { provider, withCaption, imageOnly } of cases) {
  test(`${provider} sends caption and every image's bytes in the provider-native request`, async () => {
    const messages = [{ role: 'user', content: 'Compare these images', images: [png, gif] }];
    const before = structuredClone(messages);
    assert.deepEqual(await requestFor(provider, messages), withCaption);
    assert.deepEqual(messages, before, 'conversion must not change the neutral history');
  });

  test(`${provider} sends an image-only user turn without an empty text block`, async () => {
    assert.deepEqual(await requestFor(provider, [{ role: 'user', content: '', images: [png] }]), imageOnly);
  });

  test(`${provider} reports the provider's image rejection without substituting text`, async () => {
    await assert.rejects(
      requestFor(provider, [{ role: 'user', content: '', images: [png] }], true),
      /This model does not support image input/,
    );
  });
}

const toolHistory = [
  { role: 'user', content: 'Read the file', images: [] },
  { role: 'assistant', content: 'Reading it', tool_calls: [{ id: 'call_1', name: 'ReadFile', input: { path: 'notes.txt' } }] },
  { role: 'tool_results', results: [{ call_id: 'call_1', output: { ok: false, error: 'missing' } }] },
  { role: 'assistant', content: 'The file is missing.' },
];

test('Codex text/tool history and opaque output-item echoes remain unchanged', () => {
  assert.deepEqual(toResponsesInput(toolHistory), [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read the file' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading it' }] },
    { type: 'function_call', call_id: 'call_1', name: 'ReadFile', arguments: '{"path":"notes.txt"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"ok":false,"error":"missing"}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The file is missing.' }] },
  ]);
  const items = [{ type: 'reasoning', id: 'reasoning_1', encrypted_content: 'opaque' },
    { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'ReadFile', arguments: '{"path":"notes.txt"}' }];
  assert.deepEqual(toResponsesInput([{ ...toolHistory[1], output_items: items }]), items);
});

test('OpenAI-compatible text/tool history remains unchanged', () => {
  assert.deepEqual(toOpenAIMessages(toolHistory, 'System instructions'), [
    { role: 'system', content: 'System instructions' },
    { role: 'user', content: 'Read the file' },
    { role: 'assistant', content: 'Reading it', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'ReadFile', arguments: '{"path":"notes.txt"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":false,"error":"missing"}' },
    { role: 'assistant', content: 'The file is missing.' },
  ]);
});

test('Anthropic text/tool history remains unchanged, including error results', () => {
  assert.deepEqual(toAnthropicMessages(toolHistory), [
    { role: 'user', content: 'Read the file' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Reading it' },
      { type: 'tool_use', id: 'call_1', name: 'ReadFile', input: { path: 'notes.txt' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":false,"error":"missing"}', is_error: true }] },
    { role: 'assistant', content: 'The file is missing.' },
  ]);
});
