import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CodexAuth, decodeJwt } from '../src/model/codex-auth.js';
import { CodexAdapter, toResponsesInput, toResponsesTools, sse } from '../src/model/codex-adapter.js';
import { Host } from '../src/host.js';
import { fixedClock } from '../src/core/clock.js';
import { tmpDir, call } from './helpers.js';

// A ChatGPT subscription as a provider: the Codex CLI's auth.json, refreshed
// through its OAuth endpoint, driving the Responses API over SSE. All against a
// fake network; the real one is exercised once, by hand, after `codex login`.

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const expIn = (ms, now) => Math.floor((now + ms) / 1000);

function authFile(dir, tokens) {
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens, last_refresh: null }));
  return file;
}

test('status reads the sign-in without throwing, and reports absence plainly', () => {
  const dir = tmpDir();
  const now = Date.now();
  const none = new CodexAuth({ file: path.join(dir, 'missing.json') }).status();
  assert.equal(none.signed_in, false);
  assert.match(none.why, /not signed in/);
  const file = authFile(dir, { access_token: jwt({ exp: expIn(3_600_000, now), 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'pro' } }), refresh_token: 'r1' });
  const s = new CodexAuth({ file }).status();
  assert.equal(s.signed_in, true);
  assert.equal(s.account_id, 'acct_1');
  assert.equal(s.plan, 'pro');
  assert.ok(decodeJwt('not-a-jwt') === null);
});

test('an expiring token is refreshed through the OAuth endpoint, rotated on disk atomically, and a dead refresh token says to sign in again', async () => {
  const dir = tmpDir();
  let now = Date.now();
  const file = authFile(dir, { access_token: jwt({ exp: expIn(30_000, now), 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } }), refresh_token: 'r1', account_id: 'acct_1' });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: jwt({ exp: expIn(3_600_000, now) }), refresh_token: 'r2', id_token: 'id2' }) };
  };
  const auth = new CodexAuth({ file, fetch, now: () => now });
  const creds = await auth.credentials();
  assert.equal(calls.length, 1, 'refreshed because the token was within a minute of expiry');
  assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['client_id', 'grant_type', 'refresh_token']);
  assert.equal(calls[0].body.refresh_token, 'r1');
  assert.equal(creds.account_id, 'acct_1');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.tokens.refresh_token, 'r2', 'the rotated refresh token is persisted');
  assert.equal(onDisk.tokens.account_id, 'acct_1');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'written via rename');
  await auth.credentials();
  assert.equal(calls.length, 1, 'a fresh token is not refreshed again');

  // Concurrent callers share one refresh.
  now += 3_600_000;
  await Promise.all([auth.credentials(), auth.credentials(), auth.credentials()]);
  assert.equal(calls.length, 2);

  const dead = new CodexAuth({ file, now: () => now + 7_200_000, fetch: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'refresh_token_reused' } }) }) });
  await assert.rejects(() => dead.credentials(), /refresh_token_reused.*reconnect ChatGPT in App settings/);
});

test('the request is the Codex wire shape and the SSE stream maps onto neutral events, items kept for the echo', async () => {
  const dir = tmpDir();
  const now = Date.now();
  const file = authFile(dir, { access_token: jwt({ exp: expIn(3_600_000, now) }), refresh_token: 'r1', account_id: 'acct_9' });
  let request;
  const events = [
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking…' },
    { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' } },
    { type: 'response.output_text.delta', delta: 'Checking ' },
    { type: 'response.output_text.delta', delta: 'the file.' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the file.' }] } },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'SandboxReadFile', arguments: '{"path":"a.txt"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 900 } } } },
  ];
  const body = (async function* () { for (const e of events) yield Buffer.from(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); })();
  const fetch = async (url, init) => { request = { url, init }; return { ok: true, status: 200, body }; };
  const adapter = new CodexAdapter({ auth: new CodexAuth({ file, now: () => now }), fetchImpl: fetch, model: 'gpt-5.6-terra' });
  const tools = [{ name: 'SandboxReadFile', description: 'Read', side_effect: 'None', input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }];
  const got = [];
  for await (const e of adapter.stream([{ role: 'user', content: 'read a.txt' }], tools, { system: 'You are Ada.', reasoning_effort: 'low' })) got.push(e);

  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(request.init.headers['chatgpt-account-id'], 'acct_9');
  assert.equal(request.init.headers.originator, 'codex_cli_rs');
  assert.match(request.init.headers.authorization, /^Bearer h\./);
  const sent = JSON.parse(request.init.body);
  assert.equal(sent.model, 'gpt-5.6-terra');
  assert.equal(sent.instructions, 'You are Ada.');
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.include, ['reasoning.encrypted_content']);
  assert.equal(sent.reasoning.effort, 'low', 'the bot’s own reasoning level reaches the request');
  assert.deepEqual(sent.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a.txt' }] }]);
  assert.equal(sent.tools[0].name, 'SandboxReadFile', 'tools are flat, not nested under function');
  assert.equal(sent.tools[0].parameters.required[0], 'path');

  assert.deepEqual(got.filter((e) => e.type === 'thinking').map((e) => e.text), ['thinking…']);
  // One text event per completed message, not one per token: the host records each.
  assert.deepEqual(got.filter((e) => e.type === 'text').map((e) => e.text), ['Checking the file.']);
  const tc = got.find((e) => e.type === 'tool_call');
  assert.deepEqual({ id: tc.id, name: tc.name, input: tc.input }, { id: 'call_1', name: 'SandboxReadFile', input: { path: 'a.txt' } });
  const usage = got.find((e) => e.type === 'usage').usage;
  assert.deepEqual(usage.call, { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
  const items = got.find((e) => e.type === 'output_items').items;
  assert.deepEqual(items.map((i) => i.type), ['reasoning', 'message', 'function_call'], 'every item, reasoning included, is kept to echo back');
  assert.equal(got.at(-1).stop_reason, 'tool_use');
});

test('the second step echoes the model\'s own items verbatim and appends the tool result', () => {
  const items = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'X', arguments: '{}' }];
  const input = toResponsesInput([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'X', input: {} }], output_items: items },
    { role: 'tool_results', results: [{ call_id: 'call_1', name: 'X', output: { ok: true } }] },
  ]);
  assert.deepEqual(input[1], items[0]);
  assert.deepEqual(input[2], items[1]);
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' });
  // Without kept items (another adapter's history), the calls are rebuilt plainly.
  const plain = toResponsesInput([{ role: 'assistant', content: 'hi', tool_calls: [{ id: 'c', name: 'X', input: { a: 1 } }] }]);
  assert.deepEqual(plain.map((i) => i.type), ['message', 'function_call']);
  assert.equal(toResponsesTools([]).length, 0);
});

test('the host carries output items from one step into the next assistant message', async () => {
  // A scripted stream that behaves like Codex: a tool call with items on step one, text on step two.
  const adapter = {
    provider: 'fake-codex', model: 'x', _usage: { calls: 0 },
    seen: [],
    async *stream(messages) {
      this.seen.push(messages);
      if (messages.at(-1).role !== 'tool_results') {
        yield { type: 'tool_call', id: 'call_1', name: 'SandboxReadFile', input: { path: 'a.txt' } };
        yield { type: 'output_items', items: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'o' }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'SandboxReadFile', arguments: '{"path":"a.txt"}' }] };
        yield { type: 'done', stop_reason: 'tool_use' };
      } else {
        yield { type: 'text', text: 'done' };
        yield { type: 'done', stop_reason: 'end_turn' };
      }
    },
    normalizeToolCall: (c) => c, cancel() {}, reportUsage() { return {}; },
  };
  const host = new Host({ dir: tmpDir(), adapter, clock: fixedClock() });
  const a = host.registry.create({ profile: { name: 'Ada' } });
  host.userRequest({ agent_id: a.id, text: 'read it' });
  await host.drain();
  const second = adapter.seen[1];
  const assistant = second.find((m) => m.role === 'assistant' && m.tool_calls?.length);
  assert.deepEqual(assistant.output_items.map((i) => i.type), ['reasoning', 'function_call'], 'the items rode along to step two');
});

test('sse parses multi-line blocks and ignores keep-alives', async () => {
  const body = (async function* () { yield ': ping\n\n'; yield 'event: x\ndata: {"a":1}\n\ndata: {"b":'; yield '2}\n\ndata: [DONE]\n\n'; })();
  const got = [];
  for await (const e of sse(body)) got.push(e);
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
});

test('separate catalog and adapter auth instances share a token rotation', async () => {
  const now = Date.now();
  const file = authFile(tmpDir(), { access_token: jwt({ exp: expIn(-1000, now) }), refresh_token: 'old' });
  let calls = 0;
  const fetch = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, text: async () => JSON.stringify({ access_token: jwt({ exp: expIn(3600000, now) }), refresh_token: 'new' }) };
  };
  const a = new CodexAuth({ file, fetch });
  const b = new CodexAuth({ file, fetch });
  const values = await Promise.all([a.credentials(), b.credentials()]);
  assert.equal(calls, 1);
  assert.deepEqual(values[0], values[1]);
});

test('a new login replaces cached credentials and wins over an in-flight refresh', async () => {
  const now = Date.now();
  const dir = tmpDir();
  const file = authFile(dir, { access_token: jwt({ exp: expIn(3600000, now) }), refresh_token: 'old', account_id: 'old-account' });
  const auth = new CodexAuth({ file, fetch: async () => {
    authFile(dir, { access_token: jwt({ exp: expIn(7200000, now) }), refresh_token: 'new-login', account_id: 'new-account' });
    return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'refresh_token_invalidated' }) };
  } });
  await auth.credentials();
  const result = await auth.credentials({ force: true });
  assert.equal(result.account_id, 'new-account');
  assert.equal(JSON.parse(fs.readFileSync(file)).tokens.refresh_token, 'new-login');
  authFile(dir, { access_token: jwt({ exp: expIn(7200000, now) }), account_id: 'third-account' });
  assert.equal((await auth.credentials()).account_id, 'third-account');
});
