import test from 'node:test';
import assert from 'node:assert/strict';
import { orderProviders, providerTitle, missingSuggestions, PROVIDER_COPY, HIDDEN_PROVIDERS } from '../web/provider-copy.js';
import { PROVIDERS } from '../web/models.js';

const list = Object.entries(PROVIDERS).map(([id, spec]) => ({ id, label: spec.label }));

test('every provider is offered, Anthropic first, operator-added ones last', () => {
  const ordered = orderProviders([...list, { id: 'my-gateway', label: 'My Gateway', custom: true }]);
  assert.equal(ordered.length, list.length + 1);
  assert.equal(ordered[0].id, 'anthropic');
  assert.equal(ordered.at(-1).id, 'my-gateway', 'operator-added providers come last');
  assert.equal(HIDDEN_PROVIDERS.size, 0);
});

test('every shown built-in provider has a plain title', () => {
  for (const provider of orderProviders([...list])) assert.ok(PROVIDER_COPY[provider.id]?.title, provider.id);
  assert.equal(providerTitle({ id: 'unknown', label: 'Whatever' }), 'Whatever');
});

test('Claude models can be suggested until they are added or discovered', () => {
  assert.equal(missingSuggestions('anthropic').length, 4);
  assert.equal(missingSuggestions('anthropic', [{ id: 'claude-opus-5-5' }]).length, 3);
  assert.equal(missingSuggestions('anthropic', [], [{ provider: 'anthropic', id: 'claude-sonnet-5-5' }]).length, 3);
  assert.equal(missingSuggestions('anthropic', [], [{ provider: 'openai', id: 'claude-sonnet-5-5' }]).length, 4, 'another provider’s model does not count');
  assert.deepEqual(missingSuggestions('openai'), []);
});

test('Anthropic’s card says plainly that a Claude subscription login will not work here', () => {
  assert.match(PROVIDER_COPY.anthropic.note, /Pro or Max login can’t be used here/);
  assert.match(PROVIDER_COPY.anthropic.keyUrl, /console\.anthropic\.com/);
});
