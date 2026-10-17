import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { ModelCatalog } from '../src/services/model-catalog.js';
import { CodexModelListError, listCodexModels } from '../src/model/codex-model-list.js';
import { ProviderStore } from '../src/services/provider-store.js';
import { VERSION } from '../src/core/version.js';
import { encodeModelChoice, modelOptions } from '../web/model-picker.js';

const LOCAL = 'http://127.0.0.1:11434/api/tags';
const OPENAI = 'https://api.openai.com/v1/models';
const ROUTER = 'https://openrouter.ai/api/v1/models/user';
const ANTHROPIC = 'https://api.anthropic.com/v1/models';
const signedOut = { status: () => ({ signed_in: false }), credentials: () => assert.fail('signed-out credentials requested') };
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const provider = (result, id) => result.providers.find((p) => p.id === id);
const models = (result, id) => result.models.filter((m) => m.provider === id);
const ids = (result, id) => models(result, id).map((m) => m.id);

test('validating a selected provider never waits for unrelated providers', async () => {
  const calls = [];
  const catalog = new ModelCatalog({ env: { DEEPSEEK_API_KEY: 'fixture', OPENAI_API_KEY: 'fixture' }, codexAuth: signedOut,
    fetchImpl: async url => { calls.push(String(url)); assert.equal(String(url), 'https://api.deepseek.com/models'); return json({ data: [{ id: 'deepseek-flash' }] }); } });
  const listed = await catalog.list({ provider: 'deepseek' });
  assert.deepEqual(ids(listed, 'deepseek'), ['deepseek-flash']);
  assert.deepEqual(listed.providers.map(p => p.id), ['deepseek']);
  assert.equal(calls.length, 1);
});

function transport(handler = () => { throw new Error('unexpected remote request'); }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), ...init, headers: new Headers(init.headers) });
      return String(url) === LOCAL ? json({ models: [] }) : handler(String(url), init);
    },
  };
}

function catalog(options = {}) {
  return new ModelCatalog({ env: {}, codexAuth: signedOut, ...transport(), ...options });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function appServer(handler) {
  const calls = [];
  const kills = [];
  let options;
  const spawnImpl = (bin, args, settings) => {
    options = { bin, args, settings };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const request = JSON.parse(String(chunk));
      calls.push(request);
      queueMicrotask(() => {
        try {
          const response = handler(request);
          if (response !== undefined) child.stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
        } catch { child.emit('error', new Error('private upstream details')); }
      });
      callback();
    } });
    child.kill = (signal) => {
      kills.push(signal);
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    return child;
  };
  return { spawnImpl, calls, kills, get options() { return options; } };
}

test('all remote/local parsers preserve arbitrary IDs, provider identity, metadata and pagination', async () => {
  const env = {
    ANTHROPIC_API_KEY: 'fake-anthropic', GLM_API_KEY: 'fake-glm', OPENAI_API_KEY: 'fake-openai',
    OPENROUTER_API_KEY: 'fake-router', DEEPSEEK_API_KEY: 'fake-deepseek', GLMMODELS_API_KEY: 'fake-atria',
  };
  const pages = new Map([
    [ANTHROPIC, { data: [{ id: 'new-ant-2099', display_name: 'New Ant' }], has_more: true, last_id: 'cursor /&' }],
    [`${ANTHROPIC}?after_id=cursor+%2F%26`, { data: [{ id: 'next-ant' }], has_more: false }],
    ['https://api.z.ai/api/coding/paas/v4/models', { data: ['new-glm-string', { id: 'new-glm-object' }] }],
    [OPENAI, { data: [{ id: 'shared-raw-id' }, { id: 'unknown-embedding-looking-id' }] }],
    [ROUTER, { data: [
      { id: 'vendor/new-tool:free', name: 'New Tool', description: 'From upstream', supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } },
      { id: 'no-tools', supported_parameters: ['temperature'] },
      { id: 'image-only', supported_parameters: ['tools'], architecture: { output_modalities: ['image'] } },
      { id: 'audio-only', architecture: { modality: 'text->audio' } },
    ], links: { next: '?page=2' } }],
    [`${ROUTER}?page=2`, { data: [{ id: 'vendor/new-tool:free' }, { id: 'unknown-capabilities' }] }],
    ['https://api.deepseek.com/models', { data: [{ id: 'new-deepseek' }] }],
    ['https://api.atria-asi.ai/v1/models', { data: [{ id: 'atria/Atria-Dawn-Preview', display_name: 'Atria Dawn Preview' }] }],
    [LOCAL, { models: [{ model: 'new-local:latest' }, { name: 'name-only:7b' }] }],
  ]);
  const calls = [];
  const codexCalls = [];
  const result = await catalog({ env, codexAuth: {
    status: () => ({ signed_in: true, account_id: 'fake-account', file: '/private/not-returned' }),
    credentials: async () => ({ access_token: 'fake-subscription-token', account_id: 'fake-account' }),
  }, codexModelList: async (options) => {
    codexCalls.push(options);
    return [
      { model: 'shared-raw-id', displayName: 'Subscription Shared', description: 'Subscription only', hidden: false, isDefault: true },
      { model: 'future-subscription', hidden: false },
      { model: 'hidden-subscription', hidden: true },
    ];
  }, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), ...init, headers: new Headers(init.headers) });
    return json(pages.get(String(url)));
  } }).list();
  assert.equal(result.providers.length, 8);
  assert.ok(result.providers.every((p) => p.state === 'ready' && p.error === null));
  assert.deepEqual(ids(result, 'anthropic'), ['new-ant-2099', 'next-ant']);
  assert.equal(models(result, 'anthropic')[0].label, 'New Ant');
  assert.deepEqual(ids(result, 'glm'), ['new-glm-string', 'new-glm-object']);
  assert.deepEqual(ids(result, 'openai'), ['shared-raw-id', 'unknown-embedding-looking-id']);
  assert.deepEqual(ids(result, 'openrouter'), ['vendor/new-tool:free', 'unknown-capabilities']);
  assert.equal(models(result, 'openrouter')[0].label, 'New Tool');
  assert.deepEqual(ids(result, 'deepseek'), ['new-deepseek']);
  assert.deepEqual(ids(result, 'atria'), ['atria/Atria-Dawn-Preview']);
  assert.equal(models(result, 'atria')[0].label, 'Atria Dawn Preview');
  assert.deepEqual(ids(result, 'local'), ['new-local:latest', 'name-only:7b']);
  assert.deepEqual(ids(result, 'codex'), ['shared-raw-id', 'future-subscription']);
  assert.equal(models(result, 'codex')[0].is_default, true);
  assert.equal(models(result, 'codex')[0].description, 'Subscription only');
  assert.deepEqual(result.models.filter((m) => m.id === 'shared-raw-id').map((m) => m.provider), ['openai', 'codex']);
  assert.deepEqual(calls.map((c) => c.url).sort(), [...pages.keys()].sort());
  assert.equal(codexCalls.length, 1);
  assert.equal(codexCalls[0].bin, 'codex');
  assert.ok(codexCalls[0].signal instanceof AbortSignal);
  assert.equal(codexCalls[0].timeoutMs, 10000);
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.body, undefined);
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal);
    const host = new URL(call.url).hostname;
    const bearer = { 'api.z.ai': 'fake-glm', 'api.openai.com': 'fake-openai', 'openrouter.ai': 'fake-router', 'api.deepseek.com': 'fake-deepseek', 'api.atria-asi.ai': 'fake-atria' }[host];
    assert.equal(call.headers.get('authorization'), bearer ? `Bearer ${bearer}` : null);
    if (host === 'api.anthropic.com') {
      assert.equal(call.headers.get('x-api-key'), 'fake-anthropic');
      assert.equal(call.headers.get('anthropic-version'), '2023-06-01');
    }
  }
  assert.doesNotMatch(JSON.stringify(result), /fake-|private|fingerprint|scope|access_token/);
});

test('alias-only discovery does not invent an omitted pinned release', async () => {
  for (const alias of ['deepseek-latest', 'deepseek-preview']) {
    const result = await catalog({ env: { DEEPSEEK_API_KEY: 'fake-key' },
      ...transport(() => json({ data: [{ id: alias, description: 'Upstream alias', is_default: true }] })),
    }).list();
    assert.deepEqual(ids(result, 'deepseek'), [alias]);
    assert.equal(models(result, 'deepseek')[0].description, 'Upstream alias');
    assert.equal(models(result, 'deepseek')[0].is_default, true);
    const value = encodeModelChoice('deepseek-1.13.0', 'deepseek');
    const selected = modelOptions(result, value).groups.flatMap(group => group.options).filter(option => option.value === value);
    assert.equal(selected.length, 1);
    assert.match(selected[0].label, /unavailable/);
  }
});

test('an operator can add an omitted model without changing discovery', async (t) => {
  const dir = tempDir(t);
  const env = { DEEPSEEK_API_KEY: 'fake-key' };
  const providers = new ProviderStore({ dir, env });
  providers.addModel({ provider: 'deepseek', model: 'deepseek-1.13.0', label: 'Pinned release' });
  const result = await catalog({ env, providers,
    ...transport(() => json({ data: [{ id: 'deepseek-latest' }] })),
  }).list();
  assert.deepEqual(ids(result, 'deepseek'), ['deepseek-latest', 'deepseek-1.13.0']);
  assert.equal(models(result, 'deepseek')[1].manual, true);
  const value = encodeModelChoice('deepseek-1.13.0', 'deepseek');
  const selected = modelOptions(result, value).groups.flatMap(group => group.options).filter(option => option.value === value);
  assert.equal(selected.length, 1);
  assert.doesNotMatch(selected[0].label, /unavailable/);
});

test('discovery preserves explicit upstream pinned metadata and does not invent other versions', async () => {
  const result = await catalog({ env: { DEEPSEEK_API_KEY: 'fake-key' },
    ...transport(() => json({ data: [
      { id: 'deepseek-latest' },
      { id: 'deepseek-1.13.0', display_name: 'Upstream pinned label', description: 'Upstream description' },
    ] })),
  }).list();
  assert.deepEqual(ids(result, 'deepseek'), ['deepseek-latest', 'deepseek-1.13.0']);
  assert.equal(models(result, 'deepseek')[1].label, 'Upstream pinned label');
  assert.equal(models(result, 'deepseek')[1].description, 'Upstream description');
  const unrelated = await catalog({ env: { DEEPSEEK_API_KEY: 'fake-key' },
    ...transport(() => json({ data: [{ id: 'other-model' }] })),
  }).list();
  assert.deepEqual(ids(unrelated, 'deepseek'), ['other-model']);
});

test('discovered models follow failure, revocation and empty-catalog status', async () => {
  for (const response of [json({ data: [] }), json({}, 401), json({}, 403), json({}, 503)]) {
    const result = await catalog({ env: { DEEPSEEK_API_KEY: 'fake-key' }, ...transport(() => response) }).list();
    assert.deepEqual(ids(result, 'deepseek'), []);
    assert.equal(provider(result, 'deepseek').state, response.ok ? 'ready' : 'error');
  }
  let response = json({ data: [{ id: 'deepseek-latest' }] });
  const service = catalog({ env: { DEEPSEEK_API_KEY: 'fake-key' }, ...transport(() => response) });
  await service.list();
  response = json({}, 503);
  const stale = await service.list({ force: true });
  assert.deepEqual(ids(stale, 'deepseek'), ['deepseek-latest']);
  assert.equal(provider(stale, 'deepseek').state, 'stale');
  assert.ok(models(stale, 'deepseek').every(model => model.stale === true));
  response = json({}, 401);
  const revoked = await service.list({ force: true });
  assert.deepEqual(ids(revoked, 'deepseek'), []);
  assert.equal(provider(revoked, 'deepseek').state, 'error');
});

test('legacy cache is refreshed before showing a previously synthesized model', async (t) => {
  const dir = tempDir(t);
  const env = { DEEPSEEK_API_KEY: 'fake-key' };
  const opts = { dir, env, now: () => 1000 };
  await catalog({ ...opts, ...transport(() => json({ data: [{ id: 'deepseek-latest' }] })) }).list();
  const file = path.join(dir, 'model-catalog.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.schema;
  legacy.providers.deepseek.models.push({ id: 'deepseek-1.13.0', provider: 'deepseek', label: 'DeepSeek 1.13.0' });
  fs.writeFileSync(file, JSON.stringify(legacy));

  const fresh = transport(() => json({ data: [{ id: 'deepseek-latest' }] }));
  const result = await catalog({ ...opts, ...fresh }).list();
  assert.deepEqual(ids(result, 'deepseek'), ['deepseek-latest']);
  assert.equal(fresh.calls.filter((call) => call.url === 'https://api.deepseek.com/models').length, 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema, 2);
  assert.deepEqual(saved.providers.deepseek.models.map((model) => model.id), ['deepseek-latest']);
});

test('unconfigured providers never request keys; Anthropic auth tokens and ZAI aliases are supported', async () => {
  const empty = transport();
  const result = await catalog(empty).list();
  assert.deepEqual(result.models, []);
  assert.ok(result.providers.filter((p) => p.id !== 'local').every((p) => p.state === 'unconfigured'));
  assert.deepEqual(empty.calls.map((c) => c.url), [LOCAL]);
  const fake = transport(() => json({ data: [{ id: 'arbitrary' }] }));
  const configured = await catalog({ ...fake, env: { ANTHROPIC_AUTH_TOKEN: 'fake-ant-token', ZAI_API_KEY: 'fake-zai' } }).list();
  assert.deepEqual(ids(configured, 'anthropic'), ['arbitrary']);
  assert.equal(fake.calls.find((c) => c.url === ANTHROPIC).headers.get('authorization'), 'Bearer fake-ant-token');
  assert.equal(fake.calls.find((c) => c.url === ANTHROPIC).headers.get('x-api-key'), null);
  assert.equal(fake.calls.find((c) => c.url.includes('api.z.ai')).headers.get('authorization'), 'Bearer fake-zai');
});

test('TTL, force, singleflight and invalidate refresh only when required', async () => {
  let clock = 1000;
  let count = 0;
  const fake = transport(() => json({ data: [{ id: `new-${++count}` }] }));
  const service = catalog({ ...fake, env: { OPENAI_API_KEY: 'fake-a' }, now: () => clock, ttl_ms: 100 });
  assert.deepEqual(ids(await service.list(), 'openai'), ['new-1']);
  clock = 1099;
  assert.deepEqual(ids(await service.list(), 'openai'), ['new-1']);
  const [a, b] = await Promise.all([service.list({ force: true }), service.list({ force: true })]);
  assert.deepEqual(ids(a, 'openai'), ['new-2']);
  assert.deepEqual(ids(b, 'openai'), ['new-2']);
  clock = 1199;
  assert.deepEqual(ids(await service.list(), 'openai'), ['new-3']);
  service.invalidate('openai');
  assert.deepEqual(ids(await service.list(), 'openai'), ['new-4']);
  assert.equal(count, 4);
});

test('transient failures retain explicitly stale same-account data with short retry backoff', async () => {
  let clock = 1000;
  let failed = false;
  const fake = transport(() => failed ? json({ error: 'fake-secret-upstream-body' }, 503) : json({ data: [{ id: 'last-good' }] }));
  const service = catalog({ ...fake, env: { OPENAI_API_KEY: 'fake-key' }, now: () => clock });
  await service.list();
  clock += 1;
  failed = true;
  const stale = await service.list({ force: true });
  assert.equal(provider(stale, 'openai').state, 'stale');
  assert.equal(provider(stale, 'openai').updated_at, 1000);
  assert.equal(models(stale, 'openai')[0].stale, true);
  assert.doesNotMatch(JSON.stringify(stale), /fake-secret|fake-key/);
  const count = fake.calls.length;
  await service.list();
  assert.equal(fake.calls.length, count);
  failed = false;
  clock += 60_000;
  const healthy = await service.list();
  assert.equal(provider(healthy, 'openai').state, 'ready');
  assert.ok(!models(healthy, 'openai')[0].stale);
});

test('disk caches persist timestamps but never credentials and isolate key rotation across restarts', async (t) => {
  const dir = tempDir(t);
  const env = { OPENAI_API_KEY: 'fake-key-account-a' };
  const opts = { dir, env, now: () => 1000 };
  await catalog({ ...opts, ...transport(() => json({ data: [{ id: 'account-a-model', access_token: env.OPENAI_API_KEY }] })) }).list();
  const raw = fs.readFileSync(path.join(dir, 'model-catalog.json'), 'utf8');
  assert.match(raw, /account-a-model/);
  assert.match(raw, /1000/);
  assert.doesNotMatch(raw, /fake-key|access_token|authorization/i);
  const offline = transport(() => { throw new Error('network includes fake-key-account-b'); });
  const cached = catalog({ ...opts, ...offline });
  assert.deepEqual(ids(await cached.list(), 'openai'), ['account-a-model']);
  assert.equal(offline.calls.length, 0);
  env.OPENAI_API_KEY = 'fake-key-account-b';
  const rotated = await cached.list();
  assert.deepEqual(ids(rotated, 'openai'), []);
  assert.equal(provider(rotated, 'openai').state, 'error');
  assert.doesNotMatch(JSON.stringify(rotated), /fake-key|account-a-model|scope|fingerprint/);
  assert.deepEqual(ids(await catalog({ ...opts, ...offline }).list(), 'openai'), []);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'model-catalog.json'), 'utf8'), /account-a-model/);
  delete env.OPENAI_API_KEY;
  assert.equal(provider(await cached.list(), 'openai').state, 'unconfigured');
});

test('401 and 403 revoke cached entitlements on disk and never use stale data', async (t) => {
  for (const status of [401, 403]) {
    const dir = tempDir(t);
    let response = json({ data: [{ id: 'revoked-model' }] });
    const opts = { dir, env: { OPENAI_API_KEY: 'fake-key' }, ...transport(() => response) };
    const service = catalog(opts);
    await service.list();
    response = { ok: false, status, json: () => assert.fail('error body must not be read') };
    const result = await service.list({ force: true });
    assert.deepEqual(ids(result, 'openai'), []);
    assert.equal(provider(result, 'openai').state, 'error');
    assert.equal(opts.calls.filter((c) => c.url === OPENAI).at(-1).signal.aborted, true);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'model-catalog.json'), 'utf8'), /revoked-model/);
    assert.deepEqual(ids(await catalog(opts).list(), 'openai'), []);
  }
});

test('partial failures and fetch/body hangs are bounded without leaking error text', async () => {
  for (const bodyHang of [false, true]) {
    const start = Date.now();
    let signal;
    const fake = transport((url, init) => {
      if (url === OPENAI) {
        signal = init.signal;
        return bodyHang ? { ok: true, status: 200, json: () => new Promise(() => {}) } : new Promise(() => {});
      }
      return json({ data: [{ id: 'healthy-deepseek' }] });
    });
    const result = await catalog({ ...fake, env: { OPENAI_API_KEY: 'fake-openai', DEEPSEEK_API_KEY: 'fake-deepseek' }, timeout_ms: 25 }).list();
    assert.ok(Date.now() - start < 1000);
    assert.equal(signal.aborted, true);
    assert.equal(provider(result, 'openai').state, 'error');
    assert.match(provider(result, 'openai').error, /timed out|timeout/i);
    assert.deepEqual(ids(result, 'deepseek'), ['healthy-deepseek']);
  }
  const result = await catalog({ env: { OPENAI_API_KEY: 'fake-sensitive' }, ...transport(() => { throw new Error('upstream Bearer fake-sensitive'); }) }).list();
  assert.doesNotMatch(JSON.stringify(result), /fake-sensitive|Bearer/);
});

test('pagination rejects other origins, credential URLs, loops and incomplete Anthropic cursors', async () => {
  for (const next of ['https://other.invalid/models', '//other.invalid/models', 'https://user:password@openrouter.ai/api/v1/models/user', ROUTER]) {
    const fake = transport(() => json({ data: [{ id: 'incomplete' }], links: { next } }));
    const result = await catalog({ ...fake, env: { OPENROUTER_API_KEY: 'fake-router' } }).list();
    assert.equal(provider(result, 'openrouter').state, 'error');
    assert.deepEqual(ids(result, 'openrouter'), []);
    assert.equal(fake.calls.filter((c) => c.url !== LOCAL).length, 1);
    assert.doesNotMatch(JSON.stringify(result), /password|other\.invalid|fake-router/);
  }
  const fake = transport(() => json({ data: [{ id: 'incomplete' }], has_more: true }));
  assert.equal(provider(await catalog({ ...fake, env: { ANTHROPIC_API_KEY: 'fake-ant' } }).list(), 'anthropic').state, 'error');
});

test('credential edits and invalidation cannot resurrect an in-flight old-account response', async () => {
  for (const rotate of [true, false]) {
    const env = { OPENAI_API_KEY: 'fake-a' };
    let finish;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    let calls = 0;
    const fake = transport(() => {
      if (++calls > 1) return json({ data: [{ id: 'new-account' }] });
      started();
      return new Promise((resolve) => { finish = resolve; });
    });
    const service = catalog({ ...fake, env });
    const pending = service.list();
    await ready;
    if (rotate) env.OPENAI_API_KEY = 'fake-b';
    else service.invalidate('openai');
    const fresh = await service.list();
    finish(json({ data: [{ id: 'old-account' }] }));
    assert.deepEqual(ids(fresh, 'openai'), ['new-account']);
    assert.deepEqual(ids(await pending, 'openai'), ['new-account']);
    assert.deepEqual(ids(await service.list(), 'openai'), ['new-account']);
  }
});

test('Codex uses one forced credential refresh on 401 and honors the app-server default', async () => {
  let token = 'fake-old';
  let forced = 0;
  let calls = 0;
  const codexAuth = {
    status: () => ({ signed_in: true, account_id: 'fake-account' }),
    credentials: async ({ force = false } = {}) => {
      if (force) { forced++; token = 'fake-new'; }
      return { access_token: token, account_id: 'fake-account' };
    },
  };
  const result = await catalog({ codexAuth, codexModelList: async () => {
    calls++;
    if (token === 'fake-old') throw new CodexModelListError('ChatGPT sign-in is no longer authorized.', 401);
    return [{ model: 'first-model' }, { model: 'explicit-default', isDefault: true }];
  } }).list();
  assert.equal(forced, 1);
  assert.equal(calls, 2);
  assert.equal(models(result, 'codex').find((m) => m.is_default)?.id, 'explicit-default');
  assert.equal(provider(result, 'codex').state, 'ready');
});

test('Codex app-server model/list handshakes, pages, isolates auth and stops its child', async () => {
  const fake = appServer((request) => {
    if (request.method === 'initialize') return { result: {} };
    if (request.method === 'model/list') return { result: request.params.cursor
      ? { data: [{ model: 'second', displayName: 'Second' }], nextCursor: null }
      : { data: [{ model: 'first', displayName: 'First', isDefault: true }], nextCursor: 'next-page' } };
  });
  const result = await listCodexModels({ bin: '/opt/codex/bin/codex', home: '/private/codex-home',
    env: { OPENAI_API_KEY: 'private-api', CODEX_ACCESS_TOKEN: 'private-token', HOME: '/private/home' },
    spawnImpl: fake.spawnImpl, timeoutMs: 200 });
  assert.deepEqual(result.map((row) => row.model), ['first', 'second']);
  assert.deepEqual(fake.calls.map((c) => c.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(fake.calls[0].params.clientInfo.name, 'better_bots');
  assert.equal(fake.calls[0].params.clientInfo.version, VERSION, 'the client reports the real release');
  assert.deepEqual(fake.calls[2].params, { limit: 100, includeHidden: false });
  assert.deepEqual(fake.calls[3].params, { limit: 100, includeHidden: false, cursor: 'next-page' });
  assert.equal(fake.options.bin, '/opt/codex/bin/codex');
  assert.deepEqual(fake.options.args, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"']);
  assert.equal(fake.options.settings.env.CODEX_HOME, '/private/codex-home');
  assert.equal(fake.options.settings.env.OPENAI_API_KEY, undefined);
  assert.equal(fake.options.settings.env.CODEX_ACCESS_TOKEN, undefined);
  assert.deepEqual(fake.kills, ['SIGTERM']);
});

test('Codex app-server protocol failures, repeated cursors and hangs fail safely', async () => {
  const rejected = appServer((request) => request.method === 'initialize' ? { result: {} }
    : request.method === 'model/list' ? { error: { code: -32000, message: 'Bearer private-token 401 Unauthorized' } } : undefined);
  await assert.rejects(listCodexModels({ home: '/private/home', spawnImpl: rejected.spawnImpl, timeoutMs: 200 }),
    (error) => error instanceof CodexModelListError && error.status === 401 && !/private-token/.test(error.message));
  const repeated = appServer((request) => request.method === 'initialize' ? { result: {} }
    : request.method === 'model/list' ? { result: { data: [], nextCursor: 'same-cursor' } } : undefined);
  await assert.rejects(listCodexModels({ home: '/private/home', spawnImpl: repeated.spawnImpl, timeoutMs: 200 }), /pagination/);
  assert.equal(repeated.calls.filter((request) => request.method === 'model/list').length, 2);
  const hung = appServer(() => undefined);
  const start = Date.now();
  await assert.rejects(listCodexModels({ home: '/private/home', spawnImpl: hung.spawnImpl, timeoutMs: 25 }), /timed out/);
  assert.ok(Date.now() - start < 1000);
  assert.deepEqual(hung.kills, ['SIGTERM']);
  await assert.rejects(listCodexModels({ home: '/private/home', spawnImpl: () => { throw new Error('private path'); } }),
    (error) => error instanceof CodexModelListError && !/private path/.test(error.message));
});

test('Codex account changes, sign-out and failed 401 retries do not retain old entitlements', async () => {
  let account = 'fake-a';
  let signedIn = true;
  let failed = false;
  let forced = 0;
  const codexAuth = {
    status: () => ({ signed_in: signedIn, account_id: account }),
    credentials: async ({ force = false } = {}) => {
      if (force) forced++;
      return { access_token: `token-${account}`, account_id: account };
    },
  };
  const service = catalog({ codexAuth, codexModelList: async () => {
    if (failed) throw new CodexModelListError('ChatGPT sign-in is no longer authorized.', 401);
    return [{ model: 'old-entitlement' }];
  } });
  await service.list();
  failed = true;
  assert.deepEqual(ids(await service.list({ force: true }), 'codex'), []);
  assert.equal(forced, 1);
  failed = false;
  await service.list({ force: true });
  failed = true;
  account = 'fake-b';
  assert.deepEqual(ids(await service.list(), 'codex'), []);
  signedIn = false;
  const out = await service.list();
  assert.deepEqual(ids(out, 'codex'), []);
  assert.equal(provider(out, 'codex').state, 'unconfigured');
});

test('Codex uses the configured CLI and the exact signed-in credential directory', async () => {
  const calls = [];
  const codexAuth = { file: '/private/codex-home/auth.json', status: () => ({ signed_in: true }),
    credentials: async () => ({ access_token: 'fake-cli-token' }) };
  const service = catalog({ codexAuth, env: { CODEX_BIN: '/opt/codex/bin/codex', OPENAI_API_KEY: 'fake-api-token' },
    codexModelList: async (options) => { calls.push(options); return [{ id: 'different-id', model: 'cli-discovered', displayName: 'New model' }]; } });
  assert.deepEqual(ids(await service.list(), 'codex'), ['cli-discovered']);
  assert.equal(models(await service.list(), 'codex')[0].label, 'New model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/opt/codex/bin/codex');
  assert.equal(calls[0].home, '/private/codex-home');
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('missing Codex CLI or malformed catalogs fail closed without fabricated fallback models', async () => {
  const codexAuth = { status: () => ({ signed_in: true }), credentials: async () => ({ access_token: 'fake-token' }) };
  const fake = transport(() => json({ unexpected: ['invented'] }));
  const result = await catalog({ ...fake, codexAuth, codexModelList: async () => { throw new CodexModelListError('Codex CLI is unavailable on this host.'); },
    env: { OPENAI_API_KEY: 'fake-api' } }).list();
  assert.deepEqual(result.models, []);
  assert.equal(provider(result, 'codex').state, 'error');
  assert.equal(provider(result, 'openai').state, 'error');
  assert.ok(fake.calls.every((c) => c.url === OPENAI || c.url === LOCAL));
  assert.doesNotMatch(JSON.stringify(result), /fake-token|fake-api/);
  const malformed = await catalog({ codexAuth, codexModelList: async () => ({ unexpected: ['invented'] }) }).list();
  assert.deepEqual(ids(malformed, 'codex'), []);
  assert.equal(provider(malformed, 'codex').state, 'error');
});

test('Codex persists same-account stale data but a 401 followed by 503 revokes it', async (t) => {
  const dir = tempDir(t);
  let status = 200;
  let retry = false;
  const codexAuth = {
    status: () => ({ signed_in: true, account_id: 'fake-private-account' }),
    credentials: async ({ force = false } = {}) => {
      if (force) retry = true;
      return { access_token: 'fake-private-token', account_id: 'fake-private-account' };
    },
  };
  const codexModelList = async () => {
    if (retry || status !== 200) throw new CodexModelListError('Model discovery failed.', retry ? 503 : status);
    return [{ model: 'subscription-last-good' }];
  };
  const service = catalog({ dir, codexAuth, codexModelList });
  await service.list();
  status = 503;
  const stale = await service.list({ force: true });
  assert.equal(models(stale, 'codex')[0].stale, true);
  const restarted = catalog({ dir, codexAuth, codexModelList });
  assert.deepEqual(ids(await restarted.list(), 'codex'), ['subscription-last-good']);
  const file = path.join(dir, 'model-catalog.json');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fake-private|access_token|account_id/);
  status = 401;
  const revoked = await restarted.list({ force: true });
  assert.deepEqual(ids(revoked, 'codex'), []);
  assert.equal(provider(revoked, 'codex').state, 'error');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /subscription-last-good/);
});

test('Codex status account changes reload cached auth credentials before discovery', async () => {
  let account = 'fake-a';
  let cachedAccount = account;
  let forced = 0;
  const codexAuth = {
    status: () => ({ signed_in: true, account_id: account }),
    credentials: async ({ force = false } = {}) => {
      if (force) { forced++; cachedAccount = account; }
      return { access_token: `token-${cachedAccount}`, account_id: cachedAccount };
    },
  };
  const service = catalog({ codexAuth, codexModelList: async () => [{ model: account === 'fake-a' ? 'account-a-model' : 'account-b-model' }] });
  await service.list();
  account = 'fake-b';
  assert.deepEqual(ids(await service.list(), 'codex'), ['account-b-model']);
  assert.equal(forced, 1);
});

test('Codex sign-out during a 401 retry is unconfigured, not a cached error', async () => {
  let signedIn = true;
  const codexAuth = {
    status: () => ({ signed_in: signedIn }),
    credentials: async () => ({ access_token: 'fake-token' }),
  };
  const result = await catalog({ codexAuth, codexModelList: async () => {
    signedIn = false;
    throw new CodexModelListError('ChatGPT sign-in is no longer authorized.', 401);
  } }).list();
  assert.deepEqual(ids(result, 'codex'), []);
  assert.equal(provider(result, 'codex').state, 'unconfigured');
  assert.equal(provider(result, 'codex').error, null);
});

test('Codex credential hangs are bounded and do not hide healthy providers', async () => {
  const codexAuth = { status: () => ({ signed_in: true }), credentials: () => new Promise(() => {}) };
  const start = Date.now();
  const fake = transport(() => json({ data: [{ id: 'healthy' }] }));
  const result = await catalog({ ...fake, codexAuth, env: { OPENAI_API_KEY: 'fake-key' }, timeout_ms: 20 }).list();
  assert.ok(Date.now() - start < 1000);
  assert.equal(provider(result, 'codex').state, 'error');
  assert.deepEqual(ids(result, 'openai'), ['healthy']);
});

test('Ollama uses a shorter timeout than the remote provider budget', async () => {
  const start = Date.now();
  let signal;
  const result = await catalog({ timeout_ms: 5000, fetchImpl: (url, init) => {
    assert.equal(String(url), LOCAL);
    signal = init.signal;
    return new Promise(() => {});
  } }).list();
  assert.ok(Date.now() - start < 3000);
  assert.equal(signal.aborted, true);
  assert.equal(provider(result, 'local').state, 'error');
});

test('a key edit while another provider is slow rechecks already-completed provider results', async () => {
  const env = { OPENAI_API_KEY: 'fake-a', DEEPSEEK_API_KEY: 'fake-deepseek' };
  let finish;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const fake = transport((url, init) => {
    if (url === OPENAI) return json({ data: [{ id: new Headers(init.headers).get('authorization') === 'Bearer fake-a' ? 'old-model' : 'new-model' }] });
    started();
    return new Promise((resolve) => { finish = resolve; });
  });
  const service = catalog({ ...fake, env });
  const pending = service.list();
  await ready;
  env.OPENAI_API_KEY = 'fake-b';
  finish(json({ data: [{ id: 'deepseek-model' }] }));
  assert.deepEqual(ids(await pending, 'openai'), ['new-model']);
});

test('free status follows refreshed pricing, never the model name', async () => {
  let price='0';
  const c=catalog({env:{OPENROUTER_API_KEY:'fixture'},...transport(()=>json({data:[
    {id:'arbitrary-model',pricing:{prompt:price,completion:price}},
    {id:'name-says:free'},
    {id:'request-charge',pricing:{prompt:'0',completion:'0',request:'0.1'}},
    {id:'blank-price',pricing:{prompt:'',completion:'0'}},
  ]}))});
  let rows=models(await c.list(),'openrouter');
  assert.equal(rows[0].is_free,true);
  assert.equal(rows[1].is_free,undefined);
  assert.equal(rows[2].is_free,false);
  assert.equal(rows[3].is_free,false);
  price='0.0001';
  rows=models(await c.list({force:true}),'openrouter');
  assert.equal(rows[0].is_free,false,'paid models leave the free group after refresh');
});
