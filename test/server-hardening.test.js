import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';
import { JsonDoc } from '../src/core/store.js';
import { isNonPublicAddress } from '../src/tools/web-tool.js';
import { sse } from '../src/model/codex-adapter.js';

// A single malformed request must never take the host down, and cross-origin
// pages must not be able to drive a loopback console.

async function start({ token = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-hardening-'));
  const host = new Host({ dir, adapter: new ScriptedAdapter(() => [{ type: 'text', text: 'ok' }]), clock: fixedClock() });
  const server = createServer({ host, live: false, token });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, dir, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A raw request, so malformed targets and headers reach the server unchanged. */
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
    setTimeout(() => socket.destroy(), 1500);
  });
}

test('malformed requests are answered, not fatal', async () => {
  const s = await start({ token: 'secret' });
  try {
    const status = (reply) => reply.split(' ')[1];
    assert.equal(status(await raw(s.port, 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')), '400', 'a target that is not a valid URL');
    assert.equal(status(await raw(s.port, 'POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull')), '401', 'a null login body');
    assert.equal(status(await raw(s.port, 'GET /api/state HTTP/1.1\r\nHost: x\r\nCookie: better_bots_token=%\r\nConnection: close\r\n\r\n')), '401', 'an undecodable cookie');
    // The server survived all of it.
    const ok = await fetch(`http://127.0.0.1:${s.port}/api/state`, { headers: { Authorization: 'Bearer secret' } });
    assert.equal(ok.status, 200);
  } finally { await s.close(); }
});

test('an undecodable screenshot name is a 404', async () => {
  const s = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/screens/%zz`);
    assert.equal(res.status, 404);
  } finally { await s.close(); }
});

test('a mutation from another origin is refused; the console itself still works', async () => {
  const s = await start();
  try {
    const url = `http://127.0.0.1:${s.port}/api/login`;
    const evil = await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(evil.status, 403);
    const same = await fetch(url, { method: 'POST', headers: { Origin: `http://127.0.0.1:${s.port}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(same.status, 200);
    const noOrigin = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noOrigin.status, 200, 'scripts and the CLI send no Origin');
  } finally { await s.close(); }
});

test('JsonDoc writers in one directory never collide on a shared temp file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-doc-')), 'doc.json');
  const a = new JsonDoc(file, { n: 0 });
  const b = new JsonDoc(file, { n: 0 });
  for (let i = 0; i < 50; i += 1) { a.update((d) => { d.n += 1; return d; }); b.update((d) => { d.n += 1; return d; }); }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 100);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['doc.json'], 'no temp files left behind');
});

test('caller data cannot overwrite an audit event id, type or time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-audit-'));
  const host = new Host({ dir, adapter: new ScriptedAdapter(() => []), clock: fixedClock() });
  const event = host.audit.record('real.type', { type: 'permission.allowed', id: 'aud_forged', at: '1999-01-01T00:00:00.000Z' });
  assert.equal(event.type, 'real.type');
  assert.notEqual(event.id, 'aud_forged');
  assert.notEqual(event.at, '1999-01-01T00:00:00.000Z');
});

test('addresses that embed or alias a private IPv4 target are not public', () => {
  for (const ip of ['64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '2002:a9fe:a9fe::', '::7f00:1', '::ffff:0:7f00:1', 'fec0::1', '192.0.0.1', '198.18.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isNonPublicAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(isNonPublicAddress(ip), false, ip);
  }
});

test('SSE parsing accepts CRLF event separators', async () => {
  const body = [Buffer.from('data: {"id":1}\r\n\r\ndata: {"i'), Buffer.from('d":2}\r'), Buffer.from('\n\r\n')];
  const seen = [];
  for await (const event of sse(body)) seen.push(event.id);
  assert.deepEqual(seen, [1, 2]);
});

test('a rebound DNS name cannot reach a console that has no token', async () => {
  const s = await start();
  try {
    const status = (reply) => reply.split(' ')[1];
    const as = (hostHeader, extra = '') => raw(s.port, `GET /api/state HTTP/1.1\r\nHost: ${hostHeader}\r\n${extra}Connection: close\r\n\r\n`);
    assert.equal(status(await as(`evil.example:${s.port}`)), '421', 'a stranger name, even on our port');
    assert.equal(status(await as(`evil.example:${s.port}`, `Origin: http://evil.example:${s.port}\r\n`)), '421', 'with a matching Origin');
    assert.equal(status(await raw(s.port, `POST /api/integrations HTTP/1.1\r\nHost: evil.example:${s.port}\r\nOrigin: http://evil.example:${s.port}\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)), '421', 'a mutation');
    for (const name of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`]) {
      assert.equal(status(await as(name)), '200', name);
    }
    const res = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally { await s.close(); }
});

test('with a token, any name works once authenticated', async () => {
  const s = await start({ token: 'secret' });
  try {
    const reply = await raw(s.port, `GET /api/state HTTP/1.1\r\nHost: bots.example.org\r\nAuthorization: Bearer secret\r\nConnection: close\r\n\r\n`);
    assert.equal(reply.split(' ')[1], '200');
  } finally { await s.close(); }
});
