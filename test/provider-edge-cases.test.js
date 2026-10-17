import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAICompatAdapter } from '../src/model/openai-adapter.js';
import { CodexAdapter } from '../src/model/codex-adapter.js';
import { ProviderStore } from '../src/services/provider-store.js';
import { writeEnvVar } from '../src/core/env-file.js';
import { normalizeBaseUrl } from '../web/models.js';

// Regression tests for truncated streams, idle timeouts, provider-secret
// permissions, credential-name collisions and env-file injection.

const frame = (c) => `data: ${JSON.stringify(c)}\n\n`;
const drain = async (adapter, settings) => {
  const events = [];
  for await (const event of adapter.stream([{ role: 'user', content: 'hi' }], [], settings)) events.push(event);
  return events;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bb-review-'));

test('openai: a stream that closes before any finish marker is an error, not a complete reply', async () => {
  const adapter = new OpenAICompatAdapter({ provider: 'local', model: 'm',
    fetchImpl: async () => new Response(frame({ choices: [{ delta: { content: 'partial answ' } }] })) });
  await assert.rejects(drain(adapter), /ended before completion/);
});

test('openai: a mid-stream error frame is thrown with its message', async () => {
  const adapter = new OpenAICompatAdapter({ provider: 'local', model: 'm',
    fetchImpl: async () => new Response(frame({ error: { message: 'upstream exploded' }, choices: [{ finish_reason: 'error' }] })) });
  await assert.rejects(drain(adapter), /upstream exploded/);
});

test('openai: parallel tool calls without an index stay separate', async () => {
  const adapter = new OpenAICompatAdapter({ provider: 'local', model: 'm',
    fetchImpl: async () => new Response([
      frame({ choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'A', arguments: '{"x":1}' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ id: 'c2', function: { name: 'B', arguments: '{"y":2}' } }] } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ].join('')) });
  const calls = (await drain(adapter)).filter((e) => e.type === 'tool_call');
  assert.deepEqual(calls.map((c) => [c.id, c.name, c.input]), [['c1', 'A', { x: 1 }], ['c2', 'B', { y: 2 }]]);
});

test('openai: indexed tool-call fragments still accumulate into one call', async () => {
  const adapter = new OpenAICompatAdapter({ provider: 'local', model: 'm',
    fetchImpl: async () => new Response([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'A', arguments: '{"x"' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ].join('')) });
  const calls = (await drain(adapter)).filter((e) => e.type === 'tool_call');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { x: 1 });
});

test('openai: a stalled request fails with a real Error, not the string "timeout"', async () => {
  const adapter = new OpenAICompatAdapter({ provider: 'local', model: 'm', timeout_ms: 30,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  await assert.rejects(drain(adapter), (error) => error instanceof Error && /timed out after 30ms/.test(error.message));
});

test('openai: the timeout is idle-based, so a slow but steady stream completes', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 6; i += 1) {
        controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: 'x' } }] })));
        await new Promise((r) => setTimeout(r, 25));
      }
      controller.enqueue(encoder.encode(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
      controller.close();
    },
  });
  const adapter = new OpenAICompatAdapter({ provider: 'local', model: 'm', timeout_ms: 80, fetchImpl: async () => new Response(body) });
  const events = await drain(adapter); // ~150ms total, longer than the 80ms idle limit
  assert.equal(events.find((e) => e.type === 'text').text, 'xxxxxx');
});

test('openai: OpenAI itself gets max_completion_tokens; gateways keep max_tokens', async () => {
  const seen = {};
  for (const provider of ['openai', 'local']) {
    const adapter = new OpenAICompatAdapter({ provider, model: 'm', max_tokens: 123,
      fetchImpl: async (_url, init) => { seen[provider] = JSON.parse(init.body); return new Response(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })); } });
    await drain(adapter);
  }
  assert.equal(seen.openai.max_completion_tokens, 123);
  assert.equal(seen.openai.max_tokens, undefined);
  assert.equal(seen.local.max_tokens, 123);
});

test('codex: a stream that ends before response.completed is an error', async () => {
  const adapter = new CodexAdapter({ model: 'm', auth: { credentials: async () => ({ access_token: 't', account_id: 'a' }) },
    fetchImpl: async () => new Response(frame({ type: 'response.output_text.delta', delta: 'half' })) });
  await assert.rejects(drain(adapter), /ended before response\.completed/);
});

test('provider secrets file is never group/world readable, including after a removal', () => {
  const dir = tmp();
  const store = new ProviderStore({ dir, env: {} });
  store.addProvider({ label: 'alpha', base_url: 'https://a.example.test/v1', key: 'sk-alpha' });
  store.addProvider({ label: 'beta', base_url: 'https://b.example.test/v1', key: 'sk-beta' });
  store.removeProvider('alpha');
  const mode = fs.statSync(path.join(dir, 'providers-secrets.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  delete process.env.ALPHA_API_KEY; delete process.env.BETA_API_KEY;
});

test('a custom provider cannot reuse a built-in provider credential name', () => {
  const store = new ProviderStore({ dir: tmp(), env: {} });
  assert.throws(() => store.addProvider({ label: 'zai', base_url: 'https://evil.example.test/v1' }), /collides|reserved/);
  assert.throws(() => store.addProvider({ label: 'glmmodels', base_url: 'https://evil.example.test/v1' }), /collides|reserved/);
});

test('base URLs with a query string or fragment are refused', () => {
  assert.equal(normalizeBaseUrl('https://api.example.test/v1?api_key=SECRET'), null);
  assert.equal(normalizeBaseUrl('https://api.example.test/v1#frag'), null);
  assert.equal(normalizeBaseUrl('https://api.example.test/v1/'), 'https://api.example.test/v1');
});

test('writeEnvVar refuses values that would inject extra environment lines', () => {
  const file = path.join(tmp(), 'env');
  assert.throws(() => writeEnvVar('OPENAI_API_KEY', 'sk-1\nNODE_OPTIONS=--require /tmp/x.js', file), /Invalid/);
  assert.throws(() => writeEnvVar('bad name', 'v', file), /Invalid/);
  assert.equal(fs.existsSync(file), false);
  writeEnvVar('OPENAI_API_KEY', 'sk-ok', file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'OPENAI_API_KEY=sk-ok\n');
});
