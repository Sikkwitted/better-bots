import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute the real shell entry point and real builder/router in an isolated
// tree. All credentials, discovery, wire adapters and the legacy Host are fake;
// neither the developer's store nor any service/network can be reached.
function fixture(t, env = {}, models = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-bots-smoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const name of ['better-bots.sh', 'src/model/build-adapter.js', 'src/model/routing-adapter.js',
    'src/model/adapter.js', 'src/model/scripted-adapter.js', 'src/model/openai-adapter.js',
    'src/model/anthropic-adapter.js', 'src/model/codex-adapter.js',
    'src/services/provider-store.js', 'src/core/store.js', 'src/core/env-file.js',
    'web/models.js']) {
    write(name, fs.readFileSync(new URL('../' + name, import.meta.url)));
  }
  write('package.json', '{"type":"module"}');
  write('preload.mjs', `
    import fs from 'node:fs';
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      fs.appendFileSync(process.env.TRANSPORT_LOG, JSON.stringify({ url, method: init?.method ?? 'GET' }) + '\\n');
      return new Response('{}', { status: 200 });
    };
    if (process.env.FAST_SMOKE_DEADLINE === '1') {
      const schedule = globalThis.setTimeout;
      globalThis.setTimeout = (fn, delay, ...args) => schedule(fn, delay === 120000 ? 100 : delay, ...args);
    }
  `);
  write('src/cli.js', '// Offline doctor stub: ready, even without credentials.\n');
  write('src/core/clock.js', 'export const systemClock = {};');
  write('src/model/codex-auth.js', `
    export const defaultCodexAuthFile = () => 'unused';
    export class CodexAuth { status() { return { signed_in: false }; } }
  `);
  write('src/services/model-catalog.js', `
    import fs from 'node:fs';
    export class ModelCatalog {
      constructor({ dir }) { this.dir = dir; this.codexAuth = {}; }
      async list() {
        fs.appendFileSync(process.env.DISCOVERY_LOG, JSON.stringify({ dir: this.dir }) + '\\n');
        if (process.env.DISCOVERY_REFRESH === '1') {
          await fetch('https://auth.example.invalid/token', { method: 'POST' });
        }
        return { models: JSON.parse(process.env.DISCOVERED_MODELS), providers: [] };
      }
    }
  `);
  write('src/model/recording.js', `
    import fs from 'node:fs';
    import { ModelAdapter } from './adapter.js';
    export class Recording extends ModelAdapter {
      constructor(provider, options = {}) {
        super({ provider: options.provider ?? provider, model: options.model ?? null });
        Object.assign(this, options);
      }
      async *stream(messages, tools, settings = {}) {
        this._usage.calls++;
        fs.appendFileSync(process.env.REQUEST_LOG, JSON.stringify({
          provider: settings.provider ?? this.provider, model: settings.model ?? this.model,
          max_tokens: this.max_tokens, effort: this.effort ?? this.reasoning_effort,
          messages, tools,
        }) + '\\n');
        if (['wire', 'retry', 'hang'].includes(process.env.RESPONSE_MODE)) {
          await fetch('https://api.example.invalid/v1/chat/completions', { method: 'POST' });
          if (process.env.RESPONSE_MODE === 'retry') {
            await fetch('https://api.example.invalid/v1/chat/completions', { method: 'POST' });
          }
          if (process.env.RESPONSE_MODE === 'hang') await new Promise(() => {
            const keepalive = setInterval(() => {}, 20);
            setTimeout(() => clearInterval(keepalive), 500);
          });
        }
        if (process.env.RESPONSE_MODE === 'error') throw new Error('synthetic wire failure');
        if (process.env.RESPONSE_MODE === 'tool') yield { type: 'tool_call', name: 'Unexpected', input: {} };
        else if (process.env.RESPONSE_MODE !== 'empty') yield { type: 'text', text: 'synthetic reachable reply' };
        if (process.env.RESPONSE_MODE !== 'incomplete') yield { type: 'done', stop_reason: 'end_turn' };
      }
    }
  `);
  for (const [name, klass, provider] of [
    ['anthropic', 'AnthropicAdapter', 'anthropic'], ['openai', 'OpenAICompatAdapter', 'openai'],
    ['codex', 'CodexAdapter', 'codex'],
  ]) {
    write(`src/model/${name}-adapter.js`, `
      import { Recording } from './recording.js';
      export class ${klass} extends Recording { constructor(options) { super('${provider}', options); } }
    `);
  }
  // Keeps the pre-fix implementation executable so red shows its wrong route,
  // rather than a missing import in the fixture.
  write('src/host.js', `
    export class Host {
      constructor({ adapter }) { this.adapter = adapter; this.registry = { create: () => ({ id: 'probe' }) }; }
      userRequest() { return { id: 'run' }; }
      async drain() {
        this.text = '';
        for await (const e of this.adapter.stream([{ role: 'user', content: 'probe' }], [], {})) {
          if (e.type === 'text') this.text += e.text;
        }
      }
      visibleResults() { return [{ run_id: 'run', text: this.text, status: 'completed' }]; }
    }
  `);
  const requestLog = path.join(dir, 'requests.jsonl');
  const discoveryLog = path.join(dir, 'discovery.jsonl');
  const transportLog = path.join(dir, 'transport.jsonl');
  const readLog = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return {
    run(input = 'y\n') {
      const result = spawnSync('/bin/bash', [path.join(dir, 'better-bots.sh'), 'smoke'], {
        cwd: dir, input, encoding: 'utf8', timeout: 10_000,
        env: {
          PATH: process.env.PATH, HOME: dir, TMPDIR: dir, BETTER_BOTS_DIR: path.join(dir, 'store'),
          NODE_OPTIONS: '--import=' + JSON.stringify(path.join(dir, 'preload.mjs')),
          REQUEST_LOG: requestLog, DISCOVERY_LOG: discoveryLog, TRANSPORT_LOG: transportLog,
          DISCOVERED_MODELS: JSON.stringify(models), ...env,
        },
      });
      assert.ifError(result.error);
      return { ...result, requests: readLog(requestLog), discovery: readLog(discoveryLog), transport: readLog(transportLog) };
    },
    store: path.join(dir, 'store'),
  };
}

test('smoke honors the explicit default pair with BETTER_BOTS_MODEL unset and hard small bounds', (t) => {
  for (const provider of ['anthropic', 'glm', 'openai']) {
    const f = fixture(t, {
      BETTER_BOTS_DEFAULT_PROVIDER: provider, BETTER_BOTS_DEFAULT_MODEL: 'synthetic/chosen',
      BETTER_BOTS_MAX_TOKENS: '64000', BETTER_BOTS_EFFORT: 'high',
    });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].provider, provider);
    assert.equal(result.requests[0].model, 'synthetic/chosen');
    assert.equal(result.requests[0].max_tokens, 2048);
    if (provider !== 'openai') assert.equal(result.requests[0].effort, 'low');
    assert.deepEqual(result.requests[0].tools, []);
    assert.equal(result.requests[0].messages.length, 1);
    assert.match(result.stdout, new RegExp(`provider: +${provider}`));
    assert.match(result.stdout, /model: +synthetic\/chosen/);
    assert.match(result.stdout, /Live path verified/);
    assert.equal(result.discovery.length, 0);
  }
});

test('smoke inherits normal fresh catalog selection in the configured data directory', (t) => {
  for (const models of [
    [{ provider: 'openai', id: 'synthetic/discovered' }],
    [{ provider: 'openai', id: 'synthetic/other' }, { provider: 'openai', id: 'synthetic/discovered', is_default: true }],
  ]) {
    const f = fixture(t, { BETTER_BOTS_DEFAULT_PROVIDER: 'openai' }, models);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].provider, 'openai');
    assert.equal(result.requests[0].model, 'synthetic/discovered');
    assert.deepEqual(result.discovery, [{ dir: f.store }]);
  }
});

test('smoke never picks the first ambiguous or stale model', (t) => {
  for (const models of [
    [{ provider: 'openai', id: 'synthetic/one' }, { provider: 'openai', id: 'synthetic/two' }],
    [{ provider: 'openai', id: 'synthetic/one', stale: true, is_default: true }],
  ]) {
    const result = fixture(t, { BETTER_BOTS_DEFAULT_PROVIDER: 'openai' }, models).run();
    assert.equal(result.status, 1);
    assert.equal(result.requests.length, 0);
    assert.doesNotMatch(result.stdout, /Live path verified/);
  }
});

test('smoke never reports a scripted response as a live success', (t) => {
  const result = fixture(t).run();
  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.match(result.stderr, /not configured|scripted|not ready/i);
  assert.doesNotMatch(result.stdout, /Live path verified/);
});

test('smoke asks first and cancellation makes no discovery or inference request', (t) => {
  const result = fixture(t, { BETTER_BOTS_DEFAULT_PROVIDER: 'openai', BETTER_BOTS_DEFAULT_MODEL: 'synthetic/chosen' }).run('n\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Continue\? \[y\/N\]/);
  assert.match(result.stdout, /cancelled/);
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.discovery, []);
});

test('smoke fails on errors, empty/incomplete replies or tools without sending a second request', (t) => {
  for (const RESPONSE_MODE of ['error', 'empty', 'incomplete', 'tool']) {
    const result = fixture(t, {
      BETTER_BOTS_DEFAULT_PROVIDER: 'openai', BETTER_BOTS_DEFAULT_MODEL: 'synthetic/chosen', RESPONSE_MODE,
    }).run();
    assert.equal(result.status, 1, RESPONSE_MODE);
    assert.equal(result.requests.length, 1);
    assert.doesNotMatch(result.stdout, /Live path verified/);
  }
});

test('smoke refuses an unbounded subscription adapter rather than routing it to a paid API', (t) => {
  const result = fixture(t, {
    BETTER_BOTS_DEFAULT_PROVIDER: 'codex', BETTER_BOTS_DEFAULT_MODEL: 'synthetic/shared-id', OPENAI_API_KEY: 'synthetic-key',
  }).run();
  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.match(result.stderr, /codex.*output.token|output.token.*codex/i);
  assert.doesNotMatch(result.stdout, /Live path verified/);
});

test('smoke permits credential refresh during discovery before its single inference request', (t) => {
  const result = fixture(t, {
    BETTER_BOTS_DEFAULT_PROVIDER: 'openai', DISCOVERY_REFRESH: '1', RESPONSE_MODE: 'wire',
  }, [{ provider: 'openai', id: 'synthetic/discovered' }]).run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.transport.map((request) => request.url), [
    'https://auth.example.invalid/token', 'https://api.example.invalid/v1/chat/completions',
  ]);
  assert.equal(result.requests.length, 1);
});

test('smoke blocks a second inference transport attempt without blocking discovery refresh', (t) => {
  const result = fixture(t, {
    BETTER_BOTS_DEFAULT_PROVIDER: 'openai', DISCOVERY_REFRESH: '1', RESPONSE_MODE: 'retry',
  }, [{ provider: 'openai', id: 'synthetic/discovered' }]).run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /will not retry/i);
  assert.equal(result.transport.filter((request) => request.url.includes('/chat/completions')).length, 1);
  assert.doesNotMatch(result.stdout, /Live path verified/);
});

test('smoke enforces a process deadline when a stream stays open without completing', (t) => {
  const result = fixture(t, {
    BETTER_BOTS_DEFAULT_PROVIDER: 'openai', BETTER_BOTS_DEFAULT_MODEL: 'synthetic/chosen',
    FAST_SMOKE_DEADLINE: '1', RESPONSE_MODE: 'hang',
  }).run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /smoke timed out/i);
  assert.equal(result.transport.length, 1);
  assert.doesNotMatch(result.stdout, /Live path verified/);
});
