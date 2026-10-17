import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { makeHost, tmpDir } from './helpers.js';
import { fixedClock } from '../src/core/clock.js';
import { pruneShots } from '../src/services/desktop-backend.js';
import { healthSnapshot, checkedHealthSnapshot, healthSignature, startHealthNotifier } from '../src/core/health.js';

// The box runs unattended with the laptop shut, so it needs a way to be asked
// "are you sick?" and a way to say so. These pin both.

function writeShots(dir, prefix, n, { offset = 0 } = {}) {
  for (let i = 0; i < n; i += 1) {
    const file = path.join(dir, `${prefix}${String.fromCharCode(122 - (i % 26))}-${i + offset}.png`);
    fs.writeFileSync(file, 'x');
    const t = new Date(Date.now() + i * 1000);
    fs.utimesSync(file, t, t); // mtime, not filename, decides what is newest
  }
}

test('pruneShots keeps only the newest N for one window and leaves others alone', () => {
  const dir = tmpDir('shots');
  writeShots(dir, 'window-0-', 5);
  writeShots(dir, 'window-1-', 2);
  const dropped = pruneShots(dir, 'window-0-', 2);
  const left = fs.readdirSync(dir);
  assert.equal(dropped.length, 3, 'dropped the oldest three');
  assert.equal(left.filter((n) => n.startsWith('window-0-')).length, 2, 'window 0 is capped');
  assert.equal(left.filter((n) => n.startsWith('window-1-')).length, 2, 'another window is untouched');
  // The two kept are the two newest by mtime.
  const mtimes = left.filter((n) => n.startsWith('window-0-')).map((n) => fs.statSync(path.join(dir, n)).mtimeMs);
  assert.deepEqual([...mtimes].sort((a, b) => b - a).slice(0, 2).sort(), mtimes.sort());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneShots is a no-op at or below the cap and never throws', () => {
  const dir = tmpDir('shots');
  writeShots(dir, 'window-0-', 2);
  assert.deepEqual(pruneShots(dir, 'window-0-', 2), []);
  assert.deepEqual(pruneShots(dir, 'window-0-', 99), []);
  assert.deepEqual(pruneShots('/nonexistent-dir', 'window-0-'), [], 'a missing directory is not an error');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('healthSnapshot is ok on a clean host and carries no secrets', () => {
  const { host, clock } = makeHost();
  const snap = healthSnapshot({ host, live: false, startedAt: clock.now(), now: clock.now() });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(snap.signals.errors, []);
  assert.equal(snap.signals.reconciliation_open, 0);
  assert.equal(snap.counts.agents, 0);
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('sk-ant'), 'no credential material in a token-free surface');
  assert.ok(!/'model'/.test(json), 'no model ID on the unauthenticated surface');
});

test('healthSnapshot reports degraded when a provider run failed recently', () => {
  const { host, clock } = makeHost();
  host.audit.record('run.model_failed', { agent_id: 'agt_x', error: '401' });
  const snap = healthSnapshot({ host, live: true, startedAt: clock.now(), now: clock.now() });
  assert.equal(snap.status, 'degraded');
  assert.deepEqual(snap.signals.errors.map((e) => e.type), ['run.model_failed']);
  assert.equal(snap.signals.errors[0].n, 1);
  assert.equal(snap.live, true);
});

test('healthSnapshot ignores failures outside the window', () => {
  const { host, clock } = makeHost();
  host.audit.record('run.model_failed', { error: 'old' });
  clock.advance(60 * 60_000); // an hour later, the failure is stale
  const snap = healthSnapshot({ host, startedAt: clock.now() - 60 * 60_000, now: clock.now() });
  assert.equal(snap.status, 'ok', 'a stale failure is not current degradation');
});

test('a failed or stopped nightly backup degrades health until a backup completes', () => {
  const { host, clock } = makeHost();
  const report = (result, at) => fs.writeFileSync(path.join(host.dir, 'backup-status.json'), JSON.stringify({ result, at: new Date(at).toISOString() }));
  const state = () => healthSnapshot({ host, startedAt: clock.now(), now: clock.now() });
  assert.equal(state().status, 'ok', 'a host without scheduled backups has no backup signal');
  report('partial', clock.now());
  assert.deepEqual(state().signals.state.map((e) => e.type), ['backup_failed']);
  report('complete', clock.now());
  assert.equal(state().status, 'ok');
  clock.advance(49 * 3600_000);
  assert.deepEqual(state().signals.state.map((e) => e.type), ['backup_stale']);
});

test('retention failure stays degraded between retries outside the audit window', () => {
  const { host, clock } = makeHost();
  host.memory.retention.status = () => ({ unfinished: [{ status: 'retryable', attempts: 26 }] });
  const snapshot = healthSnapshot({ host, now: clock.now() });
  assert.equal(snapshot.status, 'degraded');
  assert.ok(snapshot.signals.state.some(e => e.type === 'memory_retention_failed'));
  host.memory.retention.status = () => ({ unfinished: [{ status: 'pending', created_at: clock.iso() }] });
  assert.equal(healthSnapshot({host, now: clock.now()}).status, 'ok', 'fresh pending work is normal');
  clock.advance(16 * 60_000);
  host.memory.retention.status = () => ({ unfinished: [{ status: 'pending', created_at: new Date(clock.now() - 16 * 60_000).toISOString() }] });
  assert.ok(healthSnapshot({host, now: clock.now()}).signals.state.some(e => e.type === 'memory_retention_stalled'));
});

test('unreadable health inputs degrade without throwing or leaking details', () => {
  const { host } = makeHost();
  host.audit.tail = () => { throw new Error('secret audit path'); };
  host.memory.retention.status = () => { throw new Error('secret credentials'); };
  host.registry.list = () => { throw new Error('private name'); };
  const snapshot = healthSnapshot({host});
  assert.equal(snapshot.status, 'degraded');
  assert.ok(snapshot.signals.state.some(e => e.type === 'health_check_failed'));
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private name/);
});

test('required memory cannot silently become local-only', async () => {
  const {host} = makeHost();
  host.memoryRequired = true;
  const snapshot = await checkedHealthSnapshot({host});
  assert.equal(snapshot.status, 'degraded');
  assert.ok(snapshot.signals.state.some(e => e.type === 'memory_engine_missing'));
});

test('unreachable memory is checked without queued jobs and recovers after cache expiry', async () => {
  const {host, clock} = makeHost();
  let calls = 0, down = true;
  host.memory.engine = { health: async () => { calls++; if (down) throw new Error('secret endpoint'); return {status:'healthy', database:'connected'}; } };
  const options = () => ({host, now:clock.now()});
  const [a,b] = await Promise.all([checkedHealthSnapshot(options()), checkedHealthSnapshot(options())]);
  assert.equal(calls, 1, 'concurrent probes coalesce');
  assert.equal(a.status, 'degraded'); assert.equal(b.status, 'degraded');
  assert.doesNotMatch(JSON.stringify(a), /secret endpoint/);
  down = false; clock.advance(31_000);
  assert.equal((await checkedHealthSnapshot(options())).status, 'ok');
  assert.equal(calls, 2);
  host.memory.engine = {health:async () => ({status:'healthy', database:'disconnected'})};
  assert.equal((await checkedHealthSnapshot(options())).status, 'degraded', 'HTTP success is not database readiness');
});

test('health endpoint and notifier both surface a dependency outage', async () => {
  await withServer(async ({host,base}) => {
    host.memory.engine = {health:async () => {throw new Error('down');}};
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 503);
    const posts = [];
    const notifier = startHealthNotifier({host,webhook:'https://example.invalid',post:async (_url,snapshot) => posts.push(snapshot)});
    try { await notifier.tick(); assert.equal(posts[0].status, 'degraded'); }
    finally {notifier.stop();}
  });
});

test('healthSnapshot counts uncertain runs and log corruption as state failures', () => {
  const { host, clock } = makeHost();
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  const run = host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'background' });
  host.scheduler.checkpoint(run, 'tool_pending');
  run.status = 'recovery_required';
  host.scheduler.save(run);
  const snap = healthSnapshot({ host, startedAt: clock.now(), now: clock.now() });
  assert.equal(snap.status, 'degraded');
  assert.deepEqual(snap.signals.state.map((s) => s.type), ['recovery_required']);
  assert.equal(snap.counts.agents, 1);
});

async function withServer(run, { live = false } = {}) {
  // Anchor the test clock to real now so audit events land inside the health
  // window: the route itself uses Date.now(), not the injected clock.
  const { host } = makeHost({ clock: fixedClock(Date.now()) });
  const server = createServer({ host, live });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ host, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /healthz is token-free and reports 200 when healthy', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.uptime_seconds >= 0);
  });
});

test('GET /healthz reports 503 when the host is degraded, with no token asked for', async () => {
  await withServer(async ({ host, base }) => {
    host.audit.record('run.model_failed', { error: 'overload' });
    const res = await fetch(`${base}/healthz`, { headers: { Authorization: 'Bearer wrong-token' } });
    assert.equal(res.status, 503, 'degraded, and reachable without a valid token');
    const body = await res.json();
    assert.equal(body.status, 'degraded');
    assert.deepEqual(body.signals.errors.map((e) => e.type), ['run.model_failed']);
    assert.ok(!('counts' in body), 'operational counts stay off the token-free surface');
  });
});

test('healthSignature separates a persistent fault from a new one', () => {
  const a = { signals: { errors: [{ type: 'run.model_failed', n: 1 }], state: [] } };
  const b = { signals: { errors: [{ type: 'run.model_failed', n: 2 }], state: [] } };
  const c = { signals: { errors: [{ type: 'run.model_failed', n: 1 }, { type: 'memory.engine_failed', n: 1 }], state: [] } };
  assert.equal(healthSignature(a), healthSignature(b), 'same fault type is the same signature');
  assert.notEqual(healthSignature(a), healthSignature(c), 'an added fault changes the signature');
  assert.equal(healthSignature(undefined), 'none');
});

test('startHealthNotifier stays inert without a webhook and never throws', () => {
  const { host } = makeHost();
  const before = process.env.BETTER_BOTS_NOTIFY_WEBHOOK;
  delete process.env.BETTER_BOTS_NOTIFY_WEBHOOK;
  assert.equal(startHealthNotifier({ host }), null, 'no env var means nothing runs');
  process.env.BETTER_BOTS_NOTIFY_WEBHOOK = 'not-a-url';
  assert.equal(startHealthNotifier({ host }), null, 'a non-http URL is refused');
  process.env.BETTER_BOTS_NOTIFY_WEBHOOK = before;
});

test('startHealthNotifier posts on a new fault, then respects the cooldown', async () => {
  const { host, clock } = makeHost();
  const posts = [];
  const notifier = startHealthNotifier({
    host, live: true, startedAt: clock.now(),
    webhook: 'https://example.invalid/hook',
    intervalMs: 10, cooldownMs: 30 * 60_000,
    post: async (url, snap) => { posts.push({ url, status: snap.status }); },
    now: () => clock.now(),
  });
  assert.ok(notifier, 'a valid https webhook enables the notifier');

  await notifier.tick();
  assert.equal(posts.length, 0, 'healthy host sends nothing');

  host.audit.record('run.model_failed', { error: '401' });
  await notifier.tick();
  assert.equal(posts.length, 1, 'a new fault posts immediately');
  assert.equal(posts[0].status, 'degraded');
  assert.equal(posts[0].url, 'https://example.invalid/hook');

  await notifier.tick();
  assert.equal(posts.length, 1, 'the same fault within the cooldown does not re-post');

  // A persistent provider keeps failing: advance past the cooldown and let it
  // fail again, so the fault is still inside the health window.
  clock.advance(45 * 60_000);
  host.audit.record('run.model_failed', { error: '503' });
  await notifier.tick();
  assert.equal(posts.length, 2, 'a persistent fault re-posts after the cooldown');

  notifier.stop();
});

test('startHealthNotifier swallows a failing webhook', async () => {
  const { host, clock } = makeHost();
  const notifier = startHealthNotifier({
    host, startedAt: clock.now(), webhook: 'https://example.invalid/hook',
    post: async () => { throw new Error('webhook down'); },
    now: () => clock.now(),
  });
  host.audit.record('memory.engine_failed', { error: '401' });
  await notifier.tick(); // must not reject
  notifier.stop();
});
