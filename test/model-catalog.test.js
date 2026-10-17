import test from 'node:test';
import assert from 'node:assert/strict';
import { RoutingAdapter } from '../src/model/routing-adapter.js';
import { ModelAdapter } from '../src/model/adapter.js';
import * as models from '../web/models.js';
import { makeHost, say } from './helpers.js';

test('model IDs are validated structurally, not against a release-time whitelist', () => {
  assert.equal(models.normalizeModel('future-provider-model-2099'), 'future-provider-model-2099');
  assert.equal(models.normalizeModel(''), null);
  assert.equal(models.normalizeModel(null), null);
  assert.equal(models.normalizeModel('bad\nmodel'), null);
});

test('the browser module has no shipped model catalog', () => {
  assert.equal('MODELS' in models, false);
  assert.equal('MODEL_IDS' in models, false);
});

test('an explicit unavailable provider never falls back to a different billing route', async () => {
  let paidCalls = 0;
  class Paid extends ModelAdapter {
    async *stream() { paidCalls += 1; yield { type: 'text', text: 'wrong route' }; }
  }
  const routed = new RoutingAdapter({ routes: { openai: new Paid({ provider: 'openai', model: 'shared-model' }) }, fallback: 'openai' });
  await assert.rejects(async () => {
    for await (const _ of routed.stream([], [], { provider: 'codex', model: 'shared-model' })) { /* drain */ }
  }, /no adapter|unavailable provider/);
  assert.equal(paidCalls, 0);
});

test('a provider default is discovered, not chosen from a hard-coded model name', async () => {
  const seen = [];
  const route = { model: null, async *stream(messages, tools, settings) { seen.push(settings); yield { type: 'text', text: 'ok' }; } };
  const catalog = { list: async () => ({ models: [{ id: 'new-default', provider: 'codex', is_default: true }], providers: [] }) };
  const routed = new RoutingAdapter({ routes: { codex: route }, fallback: 'codex', catalog });
  const events = [];
  for await (const event of routed.stream([], [], {})) events.push(event);
  assert.equal(seen[0].model, 'new-default');
  assert.deepEqual(events[0], { type: 'model_selected', provider: 'codex', model: 'new-default' });
});

test('empty and nullish legacy models inherit the host default before catalog discovery', async () => {
  for (const discovered of [[{ id: 'different-default', provider: 'codex', is_default: true }], []]) {
    for (const model of [undefined, null, '']) {
      const seen = [];
      let discoveries = 0;
      const route = { model: null, async *stream(messages, tools, settings) { seen.push(settings); } };
      const catalog = { list: async () => { discoveries++; return { models: discovered }; } };
      const routed = new RoutingAdapter({ routes: { codex: route }, fallback: 'codex', default_model: 'host-model', catalog });
      const settings = model === undefined ? {} : { model };
      const events = [];
      for await (const event of routed.stream([], [], settings)) events.push(event);
      assert.deepEqual(events[0], { type: 'model_selected', provider: 'codex', model: 'host-model' });
      assert.deepEqual(seen, [{ provider: 'codex', model: 'host-model' }]);
      assert.equal(discoveries, 0);
      assert.deepEqual(settings, model === undefined ? {} : { model });
    }
  }
});

test('empty and nullish models retain an explicit provider and its adapter default', async () => {
  for (const model of [undefined, null, '']) {
    const seen = [];
    const route = { model: 'provider-model', async *stream(messages, tools, settings) { seen.push(settings); } };
    const catalog = { list: async () => { throw new Error('must use the adapter default'); } };
    const routed = new RoutingAdapter({ routes: { codex: route }, fallback: 'openai', default_model: 'host-model', catalog });
    const events = [];
    for await (const event of routed.stream([], [], { provider: 'codex', model })) events.push(event);
    assert.deepEqual(events[0], { type: 'model_selected', provider: 'codex', model: 'provider-model' });
    assert.deepEqual(seen, [{ provider: 'codex', model: 'provider-model' }]);
  }
});

test('explicit model and provider pairs retain their identity without catalog substitution', async () => {
  const seen = [];
  const routes = Object.fromEntries(['codex', 'openai'].map((provider) => [provider, {
    model: 'adapter-default', async *stream(messages, tools, settings) { seen.push(settings); },
  }]));
  const catalog = { list: async () => { throw new Error('must retain the explicit model'); } };
  const routed = new RoutingAdapter({ routes, fallback: 'openai', default_model: 'host-model', catalog });
  for (const provider of ['codex', 'openai']) {
    const events = [];
    for await (const event of routed.stream([], [], { provider, model: 'same-model' })) events.push(event);
    assert.deepEqual(events[0], { type: 'model_selected', provider, model: 'same-model' });
  }
  assert.deepEqual(seen, [
    { provider: 'codex', model: 'same-model' },
    { provider: 'openai', model: 'same-model' },
  ]);
});

test('an unqualified explicit model is not silently sent to the host billing route', async () => {
  const route = { model: null, async *stream() { throw new Error('wrong route'); } };
  const routed = new RoutingAdapter({ routes: { openai: route }, fallback: 'openai', default_model: 'host-model' });
  await assert.rejects(async () => {
    for await (const _ of routed.stream([], [], { model: 'subscription-model' })) { /* drain */ }
  }, /provider.*required|choose.*provider/i);
});

test('normal turns and rooms retain separate providers for the same model ID', async () => {
  const { host, adapter } = makeHost({ script: () => [say('ok')] });
  const sub = host.registry.create({ profile: { name: 'Sub', model: 'same-model', model_provider: 'codex' } });
  const api = host.registry.create({ profile: { name: 'API', model: 'same-model', model_provider: 'openai' } });
  for (const agent of [sub, api]) {
    host.userRequest({ agent_id: agent.id, text: 'hello' });
    await host.drain();
  }
  const room = host.rooms.create({ purpose: 'Review', member_ids: [sub.id, api.id] });
  await host.runRoom(room.id, { request: 'Discuss' });
  for (const agent of [sub, api]) {
    const calls = adapter.calls.filter((c) => c.settings.agent_id === agent.id);
    assert.ok(calls.some((c) => c.settings.payload.kind === 'room_turn'));
    assert.ok(calls.every((c) => c.settings.model === 'same-model' && c.settings.provider === agent.profile.model_provider));
  }
});
