// Explicit real-runtime acceptance probe; not a mocked unit test or default suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DockerDesktop } from '../src/services/docker-desktop.js';
import { ComputerService } from '../src/services/computer-service.js';
import { AuditLog } from '../src/core/audit.js';
import { systemClock as clock } from '../src/core/clock.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-desktop-live-'));
const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const color = req.url.startsWith('/a') ? '#e24040' : '#3864df';
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Surface ${req.url}</title><style>body{background:${color};font:24px sans-serif;padding:40px}input,button{font:24px sans-serif}</style><h1>Surface ${req.url}</h1><form action="/record"><input name="value" autofocus><button>Record</button></form>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let backend = new DockerDesktop({ dir, workspace });
const audit = new AuditLog({ file: path.join(dir, 'audit.jsonl'), clock });
let computer = new ComputerService({ dir, clock, audit, backend, window_count: 2 });
const act = (agent, assignment, action, detail = {}) => computer.performWindowAction(agent, { ...assignment, action, detail });
try {
  const a = computer.assignWindow('a').assignment, b = computer.assignWindow('b').assignment;
  assert.equal(computer.assignWindow('c').reason, 'no_monitor_available');
  const ready = await Promise.all([computer.readyWindow('a'), computer.readyWindow('b')]);
  assert.ok(ready.every((m) => m.live));
  assert.notEqual(ready[0].vnc_url, ready[1].vnc_url);
  for (const view of ready) assert.equal((await fetch(view.vnc_url)).status, 200);
  console.log('READY', JSON.stringify({ dir, views: ready.map((r) => r.vnc_url) }));
  const port = server.address().port;
  const shots = await Promise.all([
    act('a', a, 'open_url', { url: `http://host.docker.internal:${port}/a`, wait_ms: 1000 }),
    act('b', b, 'open_url', { url: `http://host.docker.internal:${port}/b`, wait_ms: 1000 }),
  ]);
  for (const shot of shots) assert.equal(shot.performed, true, JSON.stringify(shot));
  assert.ok(requests.includes('/a') && requests.includes('/b'), JSON.stringify(requests));
  const bytes = shots.map((s) => fs.readFileSync(path.join(backend.shots, s.screenshot)));
  assert.ok(bytes.every((b) => b.length > 10000)); assert.notDeepEqual(bytes[0], bytes[1]);
  await assert.rejects(act('b', a, 'click', { x: 10, y: 10 }), /does not own/);
  await act('a', a, 'type', { text: 'alpha' });
  await act('a', a, 'key', { key: 'Return', wait_ms: 1000 });
  await act('b', b, 'type', { text: 'beta' });
  await act('b', b, 'key', { key: 'Return', wait_ms: 1000 });
  assert.ok(requests.includes('/record?value=alpha'), JSON.stringify(requests));
  assert.ok(requests.includes('/record?value=beta'), JSON.stringify(requests));
  console.log('INDEPENDENT_INPUT_PASSED', JSON.stringify(shots.map((s) => path.join(backend.shots, s.screenshot))));
  if (process.env.BB_DESKTOP_HOLD === '1') {
    console.log('HOLD: open the noVNC views to verify user takeover; send SIGTERM to finish cleanup.');
    await new Promise((r) => process.once('SIGTERM', r));
  }
  computer.releaseWindow('a');
  const c = computer.assignWindow('c').assignment;
  await computer.readyWindow('c');
  assert.notEqual(c.owner_token, a.owner_token);
  await assert.rejects(act('a', a, 'screenshot'), /does not own/);
  // New backend instance emulates a host restart with orphaned containers.
  backend = new DockerDesktop({ dir, workspace });
  computer = new ComputerService({ dir, clock, audit, backend, window_count: 2 });
  assert.equal((await computer.readyWindow('b')).live, true);
  assert.equal((await act('b', b, 'screenshot')).performed, true);
  const owned = JSON.parse((await backend.command(['inspect', backend.name(b.window_index)])).stdout)[0];
  assert.equal(owned.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(owned.HostConfig.CapDrop, ['ALL']);
  assert.ok(owned.Mounts.every((m) => m.Type !== 'bind' || (m.Destination === '/work' && m.RW === false)));
  assert.ok(Object.values(owned.NetworkSettings.Ports).flat().every((p) => p.HostIp === '127.0.0.1'));
  await backend.command(['stop', backend.name(b.window_index)]);
  const failed = await act('b', b, 'screenshot');
  assert.equal(failed.ok, false); assert.match(failed.message, /stopped/);
  console.log('PASS: real desktops, input, screenshots, ownership, exhaustion, release, restart, failure reporting, boundaries');
} finally {
  await backend.shutdown();
  await new Promise((r) => server.close(r));
  console.log('CLEANED: all containers owned by this probe removed');
}
