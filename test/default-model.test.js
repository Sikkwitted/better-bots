import test from 'node:test';
import assert from 'node:assert/strict';
import { RoutingAdapter } from '../src/model/routing-adapter.js';
import { ModelAdapter } from '../src/model/adapter.js';
import { buildAdapter } from '../src/model/build-adapter.js';

// An always-on box must not spend on a provider nobody chose. Unpinned agents
// follow BETTER_BOTS_DEFAULT_MODEL, and with no default they follow whichever provider
// actually has a key.

class Recording extends ModelAdapter {
  constructor(provider) { super({ provider, model: null }); this.seen = []; }
  async *stream(messages, tools, settings) { this.seen.push(settings); yield { type: 'text', text: 'ok' }; yield { type: 'done', stop_reason: 'end_turn' }; }
}

test('an unpinned agent inherits the default provider and model', async () => {
  const glm = new Recording('glm');
  const anthropic = new Recording('anthropic');
  const routed = new RoutingAdapter({ routes: { glm, anthropic }, fallback: 'glm', default_model: 'glm-5.3' });
  for await (const _ of routed.stream([], [], {})) { /* drain */ }
  assert.equal(glm.seen.length, 1);
  assert.equal(glm.seen[0].model, 'glm-5.3');
  assert.equal(anthropic.seen.length, 0);
  // A pinned agent keeps its own provider and model.
  for await (const _ of routed.stream([], [], { provider: 'anthropic', model: 'claude-haiku-4-5' })) { /* drain */ }
  assert.equal(anthropic.seen[0].model, 'claude-haiku-4-5');
});

test('buildAdapter picks the default from the environment, never Anthropic by habit', () => {
  const saved = { ...process.env };
  try {
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BETTER_BOTS_PROVIDER', 'BETTER_BOTS_DEFAULT_PROVIDER', 'BETTER_BOTS_DEFAULT_MODEL', 'OPENROUTER_API_KEY']) delete process.env[name];
    process.env.GLM_API_KEY = 'test-key';
    const onlyGlm = buildAdapter();
    assert.equal(onlyGlm.fallback, 'glm');
    process.env.BETTER_BOTS_DEFAULT_MODEL = 'openrouter/free';
    process.env.BETTER_BOTS_DEFAULT_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key';
    const chosen = buildAdapter();
    assert.equal(chosen.fallback, 'openrouter');
    assert.equal(chosen.default_model, 'openrouter/free');
    process.env.BETTER_BOTS_DEFAULT_MODEL = 'not-a-model';
    assert.equal(buildAdapter().default_model, 'not-a-model', 'operator-configured IDs are not restricted to a bundled catalog');
    process.env.BETTER_BOTS_DEFAULT_PROVIDER = 'unknown-provider';
    assert.throws(() => buildAdapter(), /Unknown default provider/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('discovery and inference share one Codex token-refresh coordinator', () => {
  const previous = process.env.BETTER_BOTS_PROVIDER;
  process.env.BETTER_BOTS_PROVIDER = 'codex';
  try {
    const catalog = { codexAuth: { status: () => ({ signed_in: true }) }, list: async () => ({ models: [], providers: [] }) };
    const adapter = buildAdapter({ catalog });
    assert.equal(adapter.routes.codex.auth, catalog.codexAuth);
  } finally {
    if (previous === undefined) delete process.env.BETTER_BOTS_PROVIDER;
    else process.env.BETTER_BOTS_PROVIDER = previous;
  }
});
