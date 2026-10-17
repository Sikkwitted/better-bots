import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPE_NAMES, STYLES, COLORS, DEFAULT_SHAPE, DEFAULT_STYLE, DEFAULT_COLOR, normalizeShape, normalizeStyle, normalizeColor } from '../web/avatar.js';
import { makeHost, say } from './helpers.js';

// The avatar module is shared by the browser and the server, so it must stay
// importable in Node — a stray document reference at module scope would break
// every route that validates a face.

test('the picker offers bodies, characters, and colours, with no duplicates', () => {
  assert.deepEqual(SHAPE_NAMES, ['round', 'blob', 'square', 'oval', 'triangle', 'droplet']);
  assert.deepEqual(STYLES, ['crown', 'glasses', 'monocle', 'hair', 'pencil', 'headset', 'plain', 'cap']);
  for (const color of COLORS) assert.match(color, /^#[0-9A-Fa-f]{6}$/);
  assert.equal(new Set(COLORS).size, COLORS.length, 'the palette should have no duplicates');
});

test('an unknown shape, character, or colour falls back instead of throwing; old faces map onto new bodies', () => {
  assert.equal(normalizeShape('trapezoid'), DEFAULT_SHAPE);
  assert.equal(normalizeShape(undefined), DEFAULT_SHAPE);
  assert.equal(normalizeShape('egg'), 'oval');
  assert.equal(normalizeShape('dome'), 'round');
  assert.equal(normalizeShape('chip'), 'square');
  assert.equal(normalizeShape('pebble'), 'round');
  assert.equal(normalizeStyle('wizard'), DEFAULT_STYLE);
  assert.equal(normalizeStyle('crown'), 'crown');
  assert.equal(normalizeColor('rebeccapurple'), DEFAULT_COLOR);
  assert.equal(normalizeColor('#fff'), DEFAULT_COLOR);
  assert.equal(normalizeColor('#51FFCD'), '#51FFCD');
});

test('an agent created without a profile gets a face the picker actually offers', () => {
  // The registry hard-codes its defaults rather than importing them, so this is
  // the test that keeps the two files in step.
  const { host } = makeHost();
  const { profile } = host.registry.create({});
  assert.ok(SHAPE_NAMES.includes(profile.avatar_shape), `${profile.avatar_shape} is not a drawable shape`);
  assert.ok(STYLES.includes(profile.avatar_style), `${profile.avatar_style} is not a drawable character`);
  assert.ok(COLORS.includes(profile.avatar_color), `${profile.avatar_color} is not in the palette`);
  assert.equal(profile.avatar_shape, DEFAULT_SHAPE);
  assert.equal(profile.avatar_style, DEFAULT_STYLE);
  assert.equal(profile.avatar_color, DEFAULT_COLOR);
});

// --- models -----------------------------------------------------------------

test('provider-returned model IDs, including dated IDs, are preserved without a static whitelist', async () => {
  const { normalizeModel } = await import('../web/models.js');
  assert.equal(normalizeModel('future-model-20990101'), 'future-model-20990101');
  assert.equal(normalizeModel('vendor/model:variant'), 'vendor/model:variant');
  assert.equal(normalizeModel('bad\nmodel'), null);
  assert.equal(normalizeModel(''), null);
  assert.equal(normalizeModel(undefined), null);
});

test('a pinned model reaches the adapter; an unpinned agent inherits the host default', async () => {
  const { host, adapter } = makeHost({ script: () => [say('ok')] });
  const pinned = host.registry.create({ profile: { name: 'Pin', model: 'claude-haiku-4-5' } });
  const plain = host.registry.create({ profile: { name: 'Plain' } });

  host.userRequest({ agent_id: pinned.id, text: 'hi' });
  await host.drain();
  host.userRequest({ agent_id: plain.id, text: 'hi' });
  await host.drain();

  const modelFor = (id) => adapter.calls.find((c) => c.settings.agent_id === id)?.settings.model;
  assert.equal(modelFor(pinned.id), 'claude-haiku-4-5');
  // undefined, not null: the adapter falls through to its own model.
  assert.equal(modelFor(plain.id), undefined);
});

// --- working faces -----------------------------------------------------------

test('every face the UI can ask for exists on disk; working phases are CSS classes, not files', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { staticFace } = await import('../web/avatar.js');
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

  // Nothing is offered without its file: every body x character x colour has a
  // static face, or the picker would 404 silently.
  let checked = 0;
  for (const shape of SHAPE_NAMES) {
    for (const style of STYLES) {
      for (const color of COLORS) {
        const src = staticFace(shape, style, color);
        assert.ok(fs.existsSync(path.join(webDir, src.replace(/^\//, '').replace(/\?.*$/, ''))), `${src} is missing`);
        checked += 1;
      }
    }
  }
  assert.equal(checked, SHAPE_NAMES.length * STYLES.length * COLORS.length);
  // Only static PNGs ship; thinking and typing animate the same face in CSS.
  assert.deepEqual(fs.readdirSync(path.join(webDir, 'avatars')).filter((f) => !f.startsWith('.') && !f.endsWith('.png')), []);
  const css = fs.readFileSync(path.join(webDir, 'style.css'), 'utf8');
  for (const phase of ['thinking', 'typing']) assert.match(css, new RegExp(`\\.avatar\\.is-${phase}\\s*\\{[^}]*animation:`));
  // Faces from before the sheets still resolve to real files.
  assert.ok(fs.existsSync(path.join(webDir, staticFace('egg', undefined, '#51FFCD').replace(/^\//, '').replace(/\?.*$/, ''))));
});

test('a run reports thinking until the first text arrives, then typing', async () => {
  const { makeGate } = await import('./helpers.js');
  const speak = makeGate();
  const hold = makeGate();

  const { host } = makeHost({
    script: () => (async function* stream() {
      await speak.promise;
      yield say('here it comes');
      await hold.promise;
    })(),
  });
  const agent = host.registry.create({ profile: { name: 'Ada' } });

  host.userRequest({ agent_id: agent.id, text: 'hi' });
  const draining = host.drain();

  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  assert.equal(host.scheduler.activeRun(agent.id)?.phase, 'thinking', 'no text yet');

  speak.release();
  await settle();
  assert.equal(host.scheduler.activeRun(agent.id)?.phase, 'typing', 'text has started');

  hold.release();
  await draining;
  assert.equal(host.scheduler.activeRun(agent.id), null, 'the run is over');
});

test('the asset generator and the interface agree on the palette', async () => {
  // The generator is Python and cannot import the palette, so pin it here.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = fs.readFileSync(path.join(root, 'tools/avatars/build_avatars.py'), 'utf8');

  const block = script.match(/COLORS = \[([^\]]+)\]/);
  assert.ok(block, 'the generator should declare a COLORS list');
  const generated = [...block[1].matchAll(/"(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
  assert.deepEqual(generated, COLORS, 'generator palette has drifted from web/avatar.js');
});

test('providers declare their own credential sources independently of model IDs', async () => {
  const { PROVIDERS, normalizeProvider } = await import('../web/models.js');

  // A provider that leaves this machine must name where its credential comes
  // from. Local runtimes legitimately have none — they never cross the network.
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    assert.ok(Array.isArray(spec.key_env), `${name} needs a key_env array`);
    const remote = spec.base_url && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(spec.base_url);
    if (remote) {
      // A key in the environment, or a subscription sign-in the host can read.
      assert.ok(spec.key_env.length > 0 || (spec.oauth === true && spec.sign_in), `${name} is remote and needs a credential source`);
    }
  }

  assert.equal(normalizeProvider('anthropic'), 'anthropic');
  assert.equal(normalizeProvider('codex'), 'codex');
  assert.equal(normalizeProvider(null), null);
  assert.equal(normalizeProvider('unknown-provider'), null);

  // Anthropic keeps the SDK default; Z.ai must be reached at its own endpoint.
  assert.equal(PROVIDERS.anthropic.base_url, null);
  assert.equal(PROVIDERS.glm.base_url, 'https://api.z.ai/api/anthropic');
});

test('a local model is routed to the OpenAI wire, a hosted one to Anthropic', async () => {
  const { wireFor } = await import('../web/models.js');
  const { RoutingAdapter } = await import('../src/model/routing-adapter.js');

  assert.equal(wireFor('local'), 'openai');
  assert.equal(wireFor('anthropic'), 'anthropic');
  assert.equal(wireFor('glm'), 'anthropic', 'Z.ai speaks Anthropic');

  // The router must send a turn to the adapter its provider names, and fall
  // back rather than throw when an agent pins nothing.
  const seen = [];
  const stub = (name) => ({
    model: name,
    async *stream() { seen.push(name); yield { type: 'done', stop_reason: 'end_turn' }; },
    normalizeToolCall: (c) => c,
    reportUsage: () => ({ provider: name }),
    cancel: () => ({ cancelled: true }),
  });
  const router = new RoutingAdapter({
    routes: { anthropic: stub('anthropic'), local: stub('local') },
    fallback: 'anthropic',
  });

  for await (const _ of router.stream([], [], { provider: 'local' })) { /* drain */ }
  for await (const _ of router.stream([], [], { provider: undefined })) { /* drain */ }
  assert.deepEqual(seen, ['local', 'anthropic']);
  assert.deepEqual(Object.keys(router.reportUsage().by_provider), ['anthropic', 'local']);
});

test('every shape x character x colour has its face, and a white-haired one where it has hair', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'avatars');
  const { HAIR_STYLES, staticFace } = await import('../web/avatar.js');
  for (const shape of SHAPE_NAMES) for (const style of STYLES) for (const color of COLORS) {
    const base = `avatar-${shape}-${style}-${color.slice(1).toUpperCase()}`;
    assert.ok(fs.existsSync(path.join(dir, `${base}.png`)), `missing ${base}.png`);
    if (HAIR_STYLES.includes(style)) assert.ok(fs.existsSync(path.join(dir, `${base}-white.png`)), `missing ${base}-white.png`);
  }
  // White hair only changes the file for characters that have hair.
  assert.match(staticFace('round', 'hair', '#51FFCD', 'white'), /-white\.png\?v=/);
  assert.match(staticFace('round', 'monocle', '#51FFCD', 'white'), /-white\.png\?v=/);
  assert.doesNotMatch(staticFace('round', 'crown', '#51FFCD', 'white'), /-white/);
  assert.doesNotMatch(staticFace('round', 'hair', '#51FFCD', 'nonsense'), /-white/);
});

test('hair offers only what a character can show: colour with hair, nothing for a cap; no bald option', async () => {
  const { hairOptions, staticFace, normalizeHair, HAIRS } = await import('../web/avatar.js');
  assert.deepEqual(HAIRS, ['dark', 'white']);
  assert.deepEqual(hairOptions('glasses'), ['dark', 'white']);
  assert.deepEqual(hairOptions('crown'), ['dark']);
  assert.deepEqual(hairOptions('pencil'), ['dark', 'white']);
  assert.deepEqual(hairOptions('cap'), ['dark']);
  // An agent saved with the old bald choice keeps the default haired face.
  assert.equal(normalizeHair('none'), 'dark');
  assert.equal(staticFace('round', 'crown', '#51FFCD', 'none'), staticFace('round', 'crown', '#51FFCD', 'dark'));
  assert.equal(staticFace('round', 'glasses', '#51FFCD', 'none'), staticFace('round', 'glasses', '#51FFCD'));
});
