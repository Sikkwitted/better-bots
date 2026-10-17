import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderStore } from '../src/services/provider-store.js';
import { ModelCatalog } from '../src/services/model-catalog.js';
import { buildAdapter, liveProvider } from '../src/model/build-adapter.js';
import { createServer } from '../src/server.js';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';
import { PROVIDERS } from '../web/models.js';

// An operator's own endpoint — added with a base URL and a key — and the model
// IDs they vouch for. Both must behave like first-class configuration: durable,
// routable, pinnable, and never leaking the key back out.

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'better-bots-providers-'));
}

/** Keys written into process.env by the store are restored after the test. */
function withEnv(names, run) {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  return run().finally(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const noModels = async () => ({ models: [], providers: [] });

test('a custom provider is stored, keyed, and never echoes its key', async () => {
  const dir = tmp();
  await withEnv(['MY_ENDPOINT_API_KEY'], async () => {
    const store = new ProviderStore({ dir });
    const spec = store.addProvider({ label: 'My Endpoint', base_url: 'https://api.example.test/v1/', key: 'sk-secret-value' });
    assert.equal(spec.id, 'my-endpoint');
    assert.equal(spec.base_url, 'https://api.example.test/v1', 'trailing slash trimmed');
    assert.equal(store.keyed('my-endpoint'), true);
    assert.equal(process.env.MY_ENDPOINT_API_KEY, 'sk-secret-value', 'the key reaches the environment adapters read');
    // The spec file carries no secrets, and its mode matches the integrations convention.
    const specs = fs.readFileSync(path.join(dir, 'providers.json'), 'utf8');
    assert.doesNotMatch(specs, /sk-secret-value/);
    assert.equal(fs.statSync(path.join(dir, 'providers-secrets.json')).mode & 0o777, 0o600);
  });
});

test('a custom provider and its key survive a reopen', async () => {
  const dir = tmp();
  await withEnv(['MY_ENDPOINT_API_KEY'], async () => {
    new ProviderStore({ dir }).addProvider({ label: 'My Endpoint', base_url: 'https://api.example.test/v1', key: 'sk-secret-value' });
    const reopened = new ProviderStore({ dir });
    assert.equal(reopened.get('my-endpoint').base_url, 'https://api.example.test/v1');
    assert.equal(reopened.keyed('my-endpoint'), true);
  });
});

test('removing a custom provider clears its key and its manual models', async () => {
  const dir = tmp();
  await withEnv(['MY_ENDPOINT_API_KEY'], async () => {
    const store = new ProviderStore({ dir });
    store.addProvider({ label: 'My Endpoint', base_url: 'https://api.example.test/v1', key: 'sk-secret-value' });
    store.addModel({ provider: 'my-endpoint', model: 'internal/preview' });
    store.removeProvider('my-endpoint');
    assert.equal(store.get('my-endpoint'), undefined);
    assert.equal(store.manualModels().length, 0);
    assert.equal(process.env.MY_ENDPOINT_API_KEY, undefined);
  });
});

test('built-in provider names and bad endpoints are rejected with a code', async () => {
  const dir = tmp();
  const store = new ProviderStore({ dir });
  for (const [input, code] of [
    [{ label: 'anthropic', base_url: 'https://x.test/v1' }, 'provider_reserved'],
    [{ label: 'Anthropic', base_url: 'https://x.test/v1' }, 'provider_reserved'],
    [{ label: 'Good One', base_url: 'not-a-url' }, 'invalid_base_url'],
    [{ label: 'Good One', base_url: 'ftp://x.test/v1' }, 'invalid_base_url'],
    [{ label: 'Good One', base_url: 'https://user:pw@x.test/v1' }, 'invalid_base_url'],
    [{ label: '!!!', base_url: 'https://x.test/v1' }, 'invalid_provider_label'],
  ]) {
    await assert.rejects(async () => store.addProvider({ ...input, key: 'k' }), (err) => err.code === code, `${JSON.stringify(input)} -> ${code}`);
  }
  // Adding the same custom provider twice is an error, not a silent overwrite.
  store.addProvider({ label: 'Good One', base_url: 'https://x.test/v1' });
  await assert.rejects(async () => store.addProvider({ label: 'Good One', base_url: 'https://y.test/v1' }), (err) => err.code === 'provider_exists');
  // A model needs a provider that exists.
  await assert.rejects(async () => store.addModel({ provider: 'nope', model: 'x' }), (err) => err.code === 'unknown_provider');
  await assert.rejects(async () => store.addModel({ provider: 'openai', model: '\x00bad' }), (err) => err.code === 'invalid_model');
});

test('a manual model on a built-in provider is selectable without discovery', async () => {
  const dir = tmp();
  await withEnv(['GLMMODELS_API_KEY'], async () => {
    process.env.GLMMODELS_API_KEY = 'sk-test';
    const store = new ProviderStore({ dir });
    const entry = store.addModel({ provider: 'atria', model: 'atria/Atria-Dawn-Preview', label: 'Atria Dawn Preview' });
    assert.equal(entry.manual, true);
    assert.deepEqual(store.manualModels(), [{ id: 'atria/Atria-Dawn-Preview', provider: 'atria', label: 'Atria Dawn Preview', manual: true }]);
    // A second add of the same pair is rejected rather than duplicated.
    await assert.rejects(async () => store.addModel({ provider: 'atria', model: 'atria/Atria-Dawn-Preview' }), (err) => err.code === 'model_exists');
    store.removeModel('atria', 'atria/Atria-Dawn-Preview');
    assert.equal(store.manualModels().length, 0);
  });
});

test('the catalog merges manual models and derives a custom provider endpoint', async () => {
  const dir = tmp();
  await withEnv(['MY_ENDPOINT_API_KEY'], async () => {
    const store = new ProviderStore({ dir });
    store.addProvider({ label: 'My Endpoint', base_url: 'https://api.example.test/v1', key: 'sk-secret-value' });
    store.addModel({ provider: 'my-endpoint', model: 'internal/preview' });
    store.addModel({ provider: 'atria', model: 'atria/Atria-Dawn-Preview' });
    const calls = [];
    const catalog = new ModelCatalog({ dir, providers: store, timeout_ms: 2000, fetchImpl: async (url) => {
      calls.push(String(url));
      if (url.startsWith('https://api.example.test')) return new Response(JSON.stringify({ data: [{ id: 'listed-model' }] }), { headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    } });
    const list = await catalog.list({ force: true });
    // Discovery for the custom provider hangs off its own base URL.
    assert.ok(calls.some((url) => url === 'https://api.example.test/v1/models'));
    const ids = list.models.map((m) => `${m.provider}/${m.id}`);
    assert.ok(ids.includes('my-endpoint/listed-model'), 'discovered models still appear');
    assert.ok(ids.includes('my-endpoint/internal/preview'), 'the manual model appears alongside them');
    assert.ok(ids.includes('atria/atria/Atria-Dawn-Preview'), 'a manual model appears even when discovery 404s');
    // A manual model is never marked stale: an outage cannot delist it.
    for (const manual of list.models.filter((m) => m.manual)) assert.equal(manual.stale ?? false, false);
  });
});

test('a custom provider makes the host live and gets its own route', async () => {
  const dir = tmp();
  // A developer's machine may hold a ChatGPT sign-in or stray keys; neither is
  // this test's subject, so neutralize them along with the provider credentials.
  const cleared = [...'OPENAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN GLM_API_KEY ZAI_API_KEY DEEPSEEK_API_KEY OPENROUTER_API_KEY GLMMODELS_API_KEY'.split(' ')];
  const savedCodex = process.env.BETTER_BOTS_CODEX_AUTH_FILE;
  process.env.BETTER_BOTS_CODEX_AUTH_FILE = '/nonexistent/better-bots-test-codex-auth.json';
  await withEnv(cleared, async () => {
    const store = new ProviderStore({ dir });
    assert.equal(liveProvider(store), false, 'nothing is configured');
    store.addProvider({ label: 'My Endpoint', base_url: 'https://api.example.test/v1', key: 'sk-secret-value' });
    assert.equal(liveProvider(store), true, 'an operator endpoint is a live provider');
    process.env.BETTER_BOTS_DEFAULT_PROVIDER = 'my-endpoint';
    try {
      const adapter = buildAdapter({ dir, providers: store, catalog: { list: noModels } });
      assert.equal(adapter.fallback, 'my-endpoint');
      assert.ok(adapter.routes['my-endpoint'], 'a route exists for the custom provider');
      assert.equal(adapter.routes['my-endpoint'].base_url, 'https://api.example.test/v1');
      assert.deepEqual(adapter.routes['my-endpoint'].key_env, ['MY_ENDPOINT_API_KEY']);
      assert.equal(adapter.routes['my-endpoint'].provider, 'my-endpoint');
    } finally {
      delete process.env.BETTER_BOTS_DEFAULT_PROVIDER;
    }
  }).finally(() => {
    if (savedCodex === undefined) delete process.env.BETTER_BOTS_CODEX_AUTH_FILE;
    else process.env.BETTER_BOTS_CODEX_AUTH_FILE = savedCodex;
  });
});

// --------------------------------------------------------------- HTTP surface ---

function withStoreServer(run, { dir = tmp(), ...rest } = {}) {
  return withEnv(['GLMMODELS_API_KEY', 'MY_ENDPOINT_API_KEY'], async () => {
    process.env.GLMMODELS_API_KEY = 'sk-test';
    delete process.env.MY_ENDPOINT_API_KEY;
    const providers = new ProviderStore({ dir });
    const catalog = new ModelCatalog({ dir, providers, timeout_ms: 2000,
      fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }) });
    const host = new Host({ dir, adapter: new ScriptedAdapter(() => [{ type: 'text', text: 'ok' }]), clock: fixedClock() });
    host.providers = providers;
    host.modelCatalog = catalog;
    const server = createServer({ host, live: false, catalog, providers, ...rest });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, route, body) => {
      const res = await fetch(base + route, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    try {
      await run({ call, providers, host, dir });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('a custom provider can be added and removed over HTTP, and the key never comes back', async () => {
  await withStoreServer(async ({ call }) => {
    const added = await call('POST', '/api/custom-providers', { label: 'My Endpoint', base_url: 'https://api.example.test/v1', key: 'sk-secret-value' });
    assert.equal(added.status, 200);
    assert.equal(added.body.provider.id, 'my-endpoint');
    assert.equal(added.body.provider.configured, true);
    assert.doesNotMatch(JSON.stringify(added.body), /sk-secret-value/);

    const listed = (await call('GET', '/api/providers')).body.providers;
    const mine = listed.find((p) => p.id === 'my-endpoint');
    assert.equal(mine.custom, true);
    assert.equal(mine.base_url, 'https://api.example.test/v1');
    assert.equal(mine.configured, true);
    assert.doesNotMatch(JSON.stringify(listed), /sk-secret-value/);

    const removed = await call('DELETE', '/api/custom-providers', { provider: 'my-endpoint' });
    assert.equal(removed.status, 200);
    assert.equal((await call('GET', '/api/providers')).body.providers.some((p) => p.id === 'my-endpoint'), false);
    // Removing a built-in provider by id is refused.
    assert.equal((await call('DELETE', '/api/custom-providers', { provider: 'openai' })).status, 400);
  });
});

test('a manual model can be pinned to an agent without discovery listing it', async () => {
  await withStoreServer(async ({ call, host }) => {
    const added = await call('POST', '/api/models', { provider: 'atria', model: 'atria/Atria-Dawn-Preview', label: 'Atria Dawn Preview' });
    assert.equal(added.status, 200);
    assert.equal(added.body.model.id, 'atria/Atria-Dawn-Preview');

    const models = (await call('GET', '/api/models')).body.models;
    assert.ok(models.some((m) => m.id === 'atria/Atria-Dawn-Preview' && m.provider === 'atria' && m.manual));

    // Pinning it to an agent passes the same validation a discovered model does.
    const created = await call('POST', '/api/agents', { name: 'Ada' });
    const pinned = await call('PATCH', '/api/agents', { agent_id: created.body.id, model: 'atria/Atria-Dawn-Preview', model_provider: 'atria' });
    assert.equal(pinned.status, 200, pinned.body?.message);
    assert.equal(host.registry.get(created.body.id).profile.model, 'atria/Atria-Dawn-Preview');

    // An unlisted, un-vouched model is still refused.
    const rejected = await call('PATCH', '/api/agents', { agent_id: created.body.id, model: 'atria/NotARealModel', model_provider: 'atria' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, 'model_unavailable');

    const removed = await call('DELETE', '/api/models', { provider: 'atria', model: 'atria/Atria-Dawn-Preview' });
    assert.equal(removed.status, 200);
    assert.equal((await call('GET', '/api/models')).body.models.some((m) => m.id === 'atria/Atria-Dawn-Preview'), false);
  });
});

test('a key saved for a custom provider reaches the host environment', async () => {
  await withStoreServer(async ({ call }) => {
    await call('POST', '/api/custom-providers', { label: 'My Endpoint', base_url: 'https://api.example.test/v1' });
    assert.equal(process.env.MY_ENDPOINT_API_KEY, undefined, 'no key yet');
    const saved = await call('POST', '/api/providers', { provider: 'my-endpoint', key: 'sk-late-key' });
    assert.equal(saved.status, 200);
    assert.equal(process.env.MY_ENDPOINT_API_KEY, 'sk-late-key');
    assert.doesNotMatch(JSON.stringify(saved.body), /sk-late-key/);
  });
});

test('removing a provider reports the agents pinned to it', async () => {
  await withStoreServer(async ({ call }) => {
    await call('POST', '/api/custom-providers', { label: 'My Endpoint', base_url: 'https://api.example.test/v1', key: 'sk-k' });
    await call('POST', '/api/models', { provider: 'my-endpoint', model: 'internal/preview' });
    const created = await call('POST', '/api/agents', { name: 'Ada' });
    await call('PATCH', '/api/agents', { agent_id: created.body.id, model: 'internal/preview', model_provider: 'my-endpoint' });
    const removed = await call('DELETE', '/api/custom-providers', { provider: 'my-endpoint' });
    assert.deepEqual(removed.body.agents_pinned, ['Ada']);
  });
});

test('the built-in atria provider is configured to reach the Atria endpoint', () => {
  assert.equal(PROVIDERS.atria.base_url, 'https://api.atria-asi.ai/v1');
  assert.deepEqual(PROVIDERS.atria.key_env, ['GLMMODELS_API_KEY']);
  assert.equal(PROVIDERS.atria.wire, 'openai');
});

test('editing preserves identity, saved key, models and agent assignments across reopen', async () => {
  await withStoreServer(async ({call,providers,host,dir}) => {
    providers.addProvider({label:'My Endpoint',base_url:'https://old.test/v1',key:'retained-secret'});
    providers.addModel({provider:'my-endpoint',model:'preview'});
    const agent=host.registry.create({profile:{name:'Pinned',model_provider:'my-endpoint',model:'preview'}});
    const edited=await call('PATCH','/api/custom-providers',{provider:'my-endpoint',label:'Renamed',base_url:'https://new.test/v1/',key:''});
    assert.equal(edited.status,200);
    assert.equal(edited.body.provider.id,'my-endpoint');
    assert.equal(host.adapter.routes['my-endpoint'].base_url,'https://new.test/v1');
    assert.equal(host.registry.get(agent.id).profile.model_provider,'my-endpoint');
    delete process.env.MY_ENDPOINT_API_KEY;
    const reopened=new ProviderStore({dir});
    assert.equal(reopened.get('my-endpoint').label,'Renamed');
    assert.equal(reopened.keyFor('my-endpoint'),'retained-secret');
    assert.equal(reopened.manualModels()[0].id,'preview');
    const bad=await call('PATCH','/api/custom-providers',{provider:'my-endpoint',base_url:'invalid',key:'should-not-save'});
    assert.equal(bad.status,400);
    assert.equal(reopened.keyFor('my-endpoint'),'retained-secret');
    assert.doesNotMatch(JSON.stringify(edited.body),/retained-secret/);
  });
});
