import test from 'node:test';
import assert from 'node:assert/strict';
import { Host, isTransientProviderError, LOOP_STOP_AFTER, LOOP_WARN_AFTER } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';
import { tmpDir, say, call } from './helpers.js';

function hostWith(script, delays = [0, 0]) {
  const adapter = new ScriptedAdapter(script);
  const host = new Host({ dir: tmpDir(), adapter, clock: fixedClock(), provider_retry_delays_ms: delays });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  return { host, adapter };
}

const failing = (status) => Object.assign(new Error(`provider returned ${status}`), { status });

test('a passing rate limit or outage is retried and the turn still answers', async () => {
  let attempts = 0;
  const { host, adapter } = hostWith(() => {
    attempts += 1;
    if (attempts <= 2) throw failing(attempts === 1 ? 429 : 503);
    return [say('here you go')];
  });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'hi' });
  await host.drain();

  assert.equal(adapter.calls.length, 3);
  assert.equal(host.explain(run.id).result.status, 'completed');
  assert.equal(host.explain(run.id).result.text, 'here you go');
  assert.equal(host.audit.where((e) => e.type === 'run.model_retry').length, 2);
  assert.equal(host.audit.where((e) => e.type === 'run.model_failed').length, 0);
  assert.ok(!host.transcripts.all('agent', 'agt_a').some((e) => e.kind === 'run_failed'));
});

test('a dropped connection is retried like an outage', async () => {
  let attempts = 0;
  const { host } = hostWith(() => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return [say('back')];
  });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'hi' });
  await host.drain();
  assert.equal(host.explain(run.id).result.status, 'completed');
});

test('a refusal is not retried: it fails the turn at once and stays visible', async () => {
  const { host, adapter } = hostWith(() => { throw failing(400); });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'hi' });
  await host.drain();
  assert.equal(adapter.calls.length, 1);
  assert.equal(host.explain(run.id).result.status, 'failed');
  assert.ok(host.transcripts.all('agent', 'agt_a').some((e) => e.kind === 'run_failed'));
});

test('retries are bounded: a provider that stays down fails the turn', async () => {
  const { host, adapter } = hostWith(() => { throw failing(503); });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'hi' });
  await host.drain();
  assert.equal(adapter.calls.length, 3);
  assert.equal(host.explain(run.id).result.status, 'failed');
});

test('a step that already showed text is never retried, so nothing is said twice', async () => {
  const { host, adapter } = hostWith(async function* () {
    yield say('partial');
    throw failing(503);
  });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'hi' });
  await host.drain();
  assert.equal(adapter.calls.length, 1);
  assert.equal(host.explain(run.id).result.status, 'failed');
  assert.equal(host.transcripts.all('agent', 'agt_a').filter((e) => e.kind === 'agent_text').length, 1);
});

test('stopping a run during a retry pause ends it without another provider call', async () => {
  const { host, adapter } = hostWith(() => { throw failing(503); }, [60_000]);
  const run = host.userRequest({ agent_id: 'agt_a', text: 'hi' });
  const drained = host.drain();
  while (!host.audit.where((e) => e.type === 'run.model_retry').length) await new Promise((r) => setTimeout(r, 5));
  host.scheduler.cancelRun(run.id, { actor: 'user' });
  await drained;
  assert.equal(adapter.calls.length, 1);
  assert.notEqual(host.explain(run.id).result.status, 'completed');
});

test('transient errors are told apart from real failures', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 529]) assert.equal(isTransientProviderError({ status }), true, String(status));
  for (const status of [400, 401, 403, 404, 413, 422]) assert.equal(isTransientProviderError({ status }), false, String(status));
  assert.equal(isTransientProviderError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isTransientProviderError(new Error('context window exceeded')), false);
  assert.equal(isTransientProviderError(undefined), false);
});

test('a model repeating the same call with the same result is warned, then stopped', async () => {
  const { host, adapter } = hostWith(() => [call('SandboxReadFile', { path: 'missing.txt' })]);
  const run = host.userRequest({ agent_id: 'agt_a', text: 'read it' });
  await host.drain();

  assert.equal(adapter.calls.length, LOOP_STOP_AFTER);
  const result = host.explain(run.id).result;
  assert.equal(result.status, 'failed');
  assert.match(result.error, /same tool call came back with the same result/);
  assert.equal(host.audit.where((e) => e.type === 'run.loop_stopped').length, 1);
  // The warning reaches the model on the step after the threshold, before the stop.
  const sawNote = (ctx) => JSON.stringify(ctx.messages.at(-1)).includes('host_note');
  assert.equal(sawNote(adapter.calls[LOOP_WARN_AFTER - 1]), false);
  assert.equal(sawNote(adapter.calls[LOOP_WARN_AFTER]), true);
  // The person sees why it stopped.
  assert.ok(host.transcripts.all('agent', 'agt_a').some((e) => e.kind === 'run_failed' && /same tool call/.test(e.error)));
});

test('repeating a call whose result changes is progress, not a loop', async () => {
  let n = 0;
  const { host, adapter } = hostWith((ctx) => {
    n += 1;
    if (n > 7) return [say('done')];
    return [call('SandboxWriteFile', { path: 'count.txt', content: String(n) })];
  });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'count' });
  await host.drain();
  assert.equal(adapter.calls.length, 8);
  assert.equal(host.explain(run.id).result.status, 'completed');
});
