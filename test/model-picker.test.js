import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeModelChoice, decodeModelChoice, modelOptions, modelLabel, modelCatalogStatus, createModelCatalog, providerStatus } from '../web/model-picker.js';

test('a rejected Z.ai credential keeps the provider visible without inventing selectable models', () => {
  const provider = { id: 'glm', label: 'Z.ai (GLM)', state: 'error', error: 'Model discovery failed (HTTP 401).' };
  const picker = modelOptions({ models: [], providers: [provider] });
  assert.equal(picker.groups[0].label, provider.label);
  assert.equal(picker.groups[0].options.length, 1);
  assert.equal(picker.groups[0].options[0].disabled, true);
  assert.match(picker.groups[0].options[0].label, /authentication rejected/);
  assert.throws(() => decodeModelChoice(picker.groups[0].options[0].value));
  const status = providerStatus({ id: 'glm', configured: true, needs_key: true }, provider);
  assert.equal(status.label, 'authentication rejected');
  assert.match(status.detail, /Replace the saved API key/);
});

test('saved credentials and successful discovery do not claim inference readiness', () => {
  const provider = { configured: true, needs_key: true };
  assert.equal(providerStatus(provider).label, 'key saved');
  assert.equal(providerStatus(provider, { state: 'ready' }).label, 'models loaded');
  assert.equal(providerStatus(provider, { state: 'stale', error: 'timeout' }).label, 'discovery unavailable');
  assert.match(providerStatus({ configured: true, oauth: true }, { state: 'error', error: 'HTTP 401' }).detail, /Sign in again/);
});

const catalog = {
  models: [
    { id: 'shared-model', provider: 'openai', label: 'Shared model', description: 'API access' },
    { id: 'shared-model', provider: 'codex', label: 'Shared model', description: 'Subscription access', is_default: true },
  ],
  providers: [
    { id: 'openai', label: 'OpenAI', state: 'ready', error: null, updated_at: 1 },
    { id: 'codex', label: 'ChatGPT (subscription)', state: 'ready', error: null, updated_at: 1 },
  ],
};
const options = (picker) => picker.groups.flatMap((group) => group.options);

test('identical raw IDs remain distinct provider choices with labelled groups and selections', () => {
  const picker = modelOptions(catalog, '["codex","shared-model"]');
  assert.deepEqual(picker.groups.map((group) => group.label), ['OpenAI', 'ChatGPT (subscription)']);
  assert.deepEqual(options(picker).map((option) => option.value), ['["openai","shared-model"]', '["codex","shared-model"]']);
  assert.match(options(picker)[0].label, /OpenAI/);
  assert.match(options(picker)[1].label, /ChatGPT \(subscription\)/);
  assert.equal(options(picker)[1].description, 'Subscription access');
  assert.equal(picker.value, '["codex","shared-model"]');
  assert.equal(modelOptions(catalog, '').value, '', 'a provider default never replaces host default');
});

test('choice encoding round-trips punctuation and clearing explicitly clears both fields', () => {
  const id = 'vendor/model:free,"special"';
  const encoded = encodeModelChoice(id, 'openrouter');
  assert.deepEqual(JSON.parse(encoded), ['openrouter', id]);
  assert.deepEqual(decodeModelChoice(encoded), { model: id, model_provider: 'openrouter' });
  assert.equal(encodeModelChoice(null, 'openai'), '');
  assert.deepEqual(decodeModelChoice(''), { model: null, model_provider: null });
  assert.deepEqual(decodeModelChoice('[null,"legacy-model"]'), { model: 'legacy-model', model_provider: null });
});

test('invalid nonempty select values are rejected rather than saved as host default', () => {
  for (const value of [null, 'raw-id', 'null', '[]', '["openai",null]', '["openai",""]', '["openai","a","b"]', '[7,"id"]']) {
    assert.throws(() => decodeModelChoice(value), /model selection/i);
  }
});

test('a missing persisted route is retained even when the same raw ID exists at another provider', () => {
  const apiOnly = { ...catalog, models: catalog.models.slice(0, 1) };
  const picker = modelOptions(apiOnly, '["codex","shared-model"]');
  const retained = options(picker).find((option) => option.value === picker.value);
  assert.equal(picker.value, '["codex","shared-model"]');
  assert.match(retained.label, /shared-model/);
  assert.match(retained.label, /ChatGPT \(subscription\)/);
  assert.match(retained.label, /unavailable/i);
  assert.deepEqual(decodeModelChoice(picker.value), { model: 'shared-model', model_provider: 'codex' });
});

test('legacy null-provider choices stay explicit and do not get assigned an available provider', () => {
  const picker = modelOptions(catalog, encodeModelChoice('shared-model', null));
  const retained = options(picker).find((option) => option.value === picker.value);
  assert.equal(picker.value, '[null,"shared-model"]');
  assert.match(retained.label, /provider unspecified.*legacy/i);
  assert.match(retained.label, /unavailable/i);
  assert.deepEqual(decodeModelChoice(picker.value), { model: 'shared-model', model_provider: null });
});

test('a retained selection rejoins its provider group when it returns without duplication', () => {
  const missing = modelOptions({ models: [], providers: [] }, '["openai","shared-model"]');
  const restored = modelOptions(catalog, missing.value);
  assert.equal(restored.value, '["openai","shared-model"]');
  assert.equal(options(restored).filter((option) => option.value === restored.value).length, 1);
  assert.doesNotMatch(options(restored).find((option) => option.value === restored.value).label, /unavailable/i);
});

test('headers label provider routes while older transcript models remain unchanged', () => {
  assert.match(modelLabel('shared-model', 'codex', catalog.providers), /ChatGPT \(subscription\).*shared-model/);
  assert.match(modelLabel('shared-model', 'openai'), /OpenAI.*shared-model/);
  assert.equal(modelLabel('old-model', null), 'old-model');
  assert.match(modelLabel('custom-model', 'custom-provider'), /custom-provider.*custom-model/);
});

test('stale catalogs and provider failures are explained without treating unconfigured accounts as errors', () => {
  const data = {
    models: [{ ...catalog.models[0], stale: true }],
    providers: [
      { ...catalog.providers[0], state: 'stale', error: 'Discovery timed out' },
      { ...catalog.providers[1], state: 'error', error: 'Sign in again' },
      { id: 'anthropic', label: 'Anthropic', state: 'unconfigured', error: 'No key', updated_at: null },
    ],
  };
  const status = modelCatalogStatus({ data, busy: false, error: null });
  assert.match(status, /OpenAI.*cached.*Discovery timed out/);
  assert.match(status, /ChatGPT \(subscription\).*Sign in again/);
  assert.doesNotMatch(status, /Anthropic|No key/);
  assert.match(options(modelOptions(data, ''))[0].label, /cached/i);
  assert.match(modelCatalogStatus({ data, busy: true, error: null }), /refreshing/i);
});

test('refresh uses the latest unsaved selection, retains disappeared options, and coalesces requests', async () => {
  let finish;
  let calls = 0;
  let value = '["openai","shared-model"]';
  let picker;
  const store = createModelCatalog(() => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  }, () => { picker = modelOptions(store.data, value); });
  const pending = store.refresh();
  assert.equal(store.busy, true);
  const concurrent = store.refresh();
  assert.equal(calls, 1);
  value = '["codex","unsaved-model"]';
  finish(catalog);
  await Promise.all([pending, concurrent]);
  assert.equal(store.busy, false);
  assert.equal(picker.value, '["codex","unsaved-model"]');
  assert.match(options(picker).find((option) => option.value === picker.value).label, /unavailable/i);
  assert.deepEqual(decodeModelChoice(picker.value), { model: 'unsaved-model', model_provider: 'codex' });

  const next = store.refresh();
  value = '';
  finish(catalog);
  await next;
  assert.equal(picker.value, '', 'clearing during refresh must also be preserved');
});

test('a credential refresh queued during discovery runs serially and never publishes the old result', async () => {
  const requests = [];
  const published = [];
  const store = createModelCatalog((force) => new Promise((resolve) => {
    requests.push({ force, resolve });
  }), () => { published.push(store.data); });
  const pending = store.refresh();
  const forced = store.refresh(true);
  store.refresh(true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].force, false);
  requests[0].resolve(catalog);
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].force, true);
  assert.equal(store.busy, true);
  assert.ok(published.every((data) => data.models.length === 0));
  const fresh = { ...catalog, models: catalog.models.slice(1) };
  requests[1].resolve(fresh);
  await Promise.all([pending, forced]);
  assert.deepEqual(store.data, fresh);
  assert.equal(store.busy, false);
  assert.ok(!published.includes(catalog));
});

test('failed or malformed refreshes keep previous options and allow a later retry', async () => {
  let result = catalog;
  const store = createModelCatalog(async () => {
    if (result instanceof Error) throw result;
    return result;
  }, () => {});
  await store.refresh();
  result = new Error('Offline');
  await store.refresh();
  assert.deepEqual(store.data, catalog);
  assert.equal(store.busy, false);
  assert.match(store.error, /Offline/);
  assert.match(modelCatalogStatus(store), /Offline/);
  result = {};
  await store.refresh();
  assert.deepEqual(store.data, catalog);
  assert.ok(store.error);
  result = catalog;
  await store.refresh(true);
  assert.equal(store.error, null);
});

test('replacement key immediately clears old authentication failure while verification runs', async () => {
  let finish;
  const store = createModelCatalog(() => new Promise(resolve => { finish = resolve; }), () => {});
  store.data = { models: [{ provider: 'glm', id: 'old' }], providers: [{ id: 'glm', state: 'error', error: 'HTTP 401' }] };
  const pending = store.credentialsChanged('glm');
  assert.equal(store.data.models.length, 0);
  const status = providerStatus({ configured: true }, store.data.providers[0]);
  assert.equal(status.label, 'checking new key');
  assert.equal(status.failed, false);
  finish({ models: [{ provider: 'glm', id: 'new' }], providers: [{ id: 'glm', state: 'ready' }] });
  await pending;
  assert.equal(providerStatus({ configured: true }, store.data.providers[0]).label, 'models loaded');
});

test('free models lead across providers without duplicates or false unavailable groups', () => {
  const chosen=encodeModelChoice('other-free','custom');
  const picker=modelOptions({providers:[{id:'openrouter',label:'OpenRouter',state:'ready'},{id:'custom',label:'Custom',state:'ready'},{id:'codex',label:'Subscription',state:'ready'}],models:[
    {provider:'openrouter',id:'provider-model-a',is_free:true},
    {provider:'custom',id:'other-free',is_free:true},
    {provider:'openrouter',id:'paid'},
    {provider:'codex',id:'subscription-model'},
  ]},chosen);
  assert.equal(picker.groups[0].label,'Free models');
  assert.equal(picker.groups[0].options.length,2);
  assert.equal(picker.groups.some(g=>g.label==='Custom'),false);
  assert.equal(picker.groups.flatMap(g=>g.options).length,4);
  assert.equal(picker.value,chosen);
  assert.ok(picker.groups[0].options.every(o=>o.label.includes(' / ')));
});
