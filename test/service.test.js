import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createServer, isLoopback, authorized, consoleToken } from '../src/server.js';
import { makeHost, tmpDir, say } from './helpers.js';

// What has to be true for the host to survive on a server rather than a laptop:
// it refuses to be published without a token, it authenticates the browser's
// event stream as well as its API calls, and it notices due automations by
// itself — nobody is going to run a command for it at 3am.

const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');

async function withServer(run, { token = null } = {}) {
  const { host } = makeHost({ script: () => [say('ok')] });
  const server = createServer({ host, live: false, token });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, host });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('loopback is recognised so the bind guard only fires on a public address', () => {
  for (const local of ['127.0.0.1', 'localhost', '::1']) assert.ok(isLoopback(local));
  for (const public_ of ['0.0.0.0', '10.0.0.4', '203.0.113.9']) assert.ok(!isLoopback(public_));
});

test('with no token only loopback names are allowed; with one, only the right credential is', () => {
  const req = (headers) => ({ headers });
  assert.ok(authorized(req({ host: '127.0.0.1:4173' }), null), 'no token: loopback is the gate');
  assert.ok(authorized(req({ host: 'localhost:4173' }), null));
  assert.ok(!authorized(req({ host: 'rebound.example:4173' }), null), 'a rebound DNS name is not loopback');
  assert.ok(!authorized(req({}), null), 'no Host header is not loopback either');
  assert.ok(!authorized(req({}), 'secret'));
  assert.ok(authorized(req({ authorization: 'Bearer secret' }), 'secret'));
  assert.ok(!authorized(req({ authorization: 'Bearer wrong' }), 'secret'));
  assert.ok(authorized(req({ cookie: 'better_bots_token=secret' }), 'secret'));
  assert.ok(!authorized(req({ cookie: 'better_bots_token=wrong' }), 'secret'));
  // A shorter or longer guess must not throw out of timingSafeEqual.
  assert.ok(!authorized(req({ authorization: 'Bearer s' }), 'secret'));
});

test('without BETTER_BOTS_TOKEN the host makes one private token and keeps it across restarts', () => {
  const dir = tmpDir('better-bots-console-token');
  const token = consoleToken(dir);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(fs.statSync(path.join(dir, 'console-token')).mode & 0o777, 0o600, 'readable by the host user only');
  assert.equal(consoleToken(dir), token, 'a restart reuses it rather than logging everybody out');
});

test('a token-protected console rejects strangers and accepts a cookie from login', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/events`)).status, 401);

    // Static assets stay open, or the unlock screen itself could not load.
    assert.equal((await fetch(`${base}/`)).status, 200);

    const bad = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret' }),
    });
    assert.equal(good.status, 200);
    const cookie = good.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const jar = cookie.split(';')[0];
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: jar } })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer secret' } })).status, 200);
  }, { token: 'secret' });
});

test('the running server fires a due automation without anyone asking it to', async () => {
  const dir = tmpDir('better-bots-tick');
  const { host } = makeHost({ dir });
  const agent = host.registry.create({ profile: { name: 'Nightly' } });
  host.scheduleAutomation({
    agent_id: agent.id,
    name: 'sweep',
    text: 'sweep the queue',
    due_at: new Date(Date.now() - 60_000).toISOString(),
  });

  const port = 4200 + Math.floor(process.pid % 300);
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, BETTER_BOTS_DIR: dir, BETTER_BOTS_PORT: String(port), BETTER_BOTS_TICK_MS: '150', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', BETTER_BOTS_PROVIDER: '', BETTER_BOTS_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const deadline = Date.now() + 15_000;
    let fired = false;
    while (Date.now() < deadline && !fired) {
      await new Promise((r) => setTimeout(r, 200));
      // No BETTER_BOTS_TOKEN: the host made its own, and nothing gets in without it.
      let token;
      try { token = fs.readFileSync(path.join(dir, 'console-token'), 'utf8').trim(); } catch { continue; }
      const res = await fetch(`http://127.0.0.1:${port}/api/activity?limit=100`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      if (!res?.ok) continue;
      const { events } = await res.json();
      fired = events.some((e) => e.type === 'automation.fired');
    }
    assert.ok(fired, 'the ticker should have fired the overdue automation on its own');
  } finally {
    child.kill('SIGTERM');
  }
});
