// Explicit dependency -> build -> independent desktop review -> fix -> re-review.
import assert from 'node:assert/strict';
import { makeHost, call, say } from './helpers.js';
import { DockerDesktop } from '../src/services/docker-desktop.js';

let phase = 'fetch';
const html = '<!doctype html><title>Preview acceptance</title><script src="htmx.min.js"></script><style>body{font:24px sans-serif;padding:40px}button{font:24px sans-serif}</style><h1>Checkout verification</h1><button hx-get="message.txt" hx-target="#result">Check checkout</button><p id="result">Not checked</p>';
const dependency = { url: 'https://registry.npmjs.org/htmx.org/-/htmx.org-2.0.4.tgz',
  integrity: 'sha512-HLxMCdfXDOJirs3vBZl/ZLoY+c7PfM4Ahr2Ad4YXh6d22T5ltbTXFFkpx9Tgb2vvmWFMbIc3LqN2ToNkZJvyYQ==', path: 'dependency.b64' };
const build = [
  'set -eu', 'base64 -d < dependency.b64 > dependency.tgz', 'tar -xzf dependency.tgz', 'mkdir -p dist',
  'cp package/dist/htmx.min.js dist/htmx.min.js',
  `printf %s ${Buffer.from(html).toString('base64')} | base64 -d > dist/index.html`,
  "printf '%s' 'BROKEN: checkout unavailable' > dist/message.txt",
].join('\n');
const previewInput = { directory: 'dist', files: ['index.html', 'htmx.min.js', 'message.txt'] };
const { host, dir } = makeHost({ script: () => phase === 'fetch' ? [call('FetchDependency', dependency)]
  : phase === 'build' ? [call('SandboxRunCommand', { command: build }), call('StartPreview', previewInput)]
  : phase === 'fix' ? [call('SandboxRunCommand', { command: "printf '%s' 'READY: checkout verified' > dist/message.txt" }), call('StartPreview', previewInput)] : [say('done')] });
host.registry.create({ id: 'builder', profile: { name: 'Builder' } });
host.registry.create({ id: 'reviewer', profile: { name: 'Reviewer' } });
const localOnly = process.env.BB_PREVIEW_LOCAL_ONLY === '1';
if (!localOnly) host.computer.backend = new DockerDesktop({ dir, workspace: host.workspace });
host.approval_mode = 'wait';
const userRun = async (text) => { const run = host.userRequest({ agent_id: 'builder', text }); await host.drain(); return run; };
const pause = async () => {
  if (process.env.BB_PREVIEW_HOLD !== '1') return;
  await new Promise((resolve, reject) => {
    const keepAlive = setInterval(() => {}, 1000);
    const done = () => { clearInterval(keepAlive); process.off('SIGTERM', stop); resolve(); };
    const stop = () => { clearInterval(keepAlive); process.off('SIGUSR1', done); reject(new Error('verification stopped')); };
    process.once('SIGUSR1', done); process.once('SIGTERM', stop);
  });
};
try {
  const downloading = userRun('Fetch the pinned htmx fixture dependency');
  const deadline = Date.now() + 5000;
  while (!host.permissions.pendingRequests().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const request = host.permissions.pendingRequests()[0];
  assert.equal(request.action, 'external.fetch_dependency');
  host.permissions.resolve(request.id, 'allow_once');
  const fetched = await downloading;
  assert.equal(host.explain(fetched.id).run.checkpoint.record.result.ok, true);
  phase = 'build'; const built = await userRun('Build and preview the fixture');
  const shell = host.explain(built.id).run.checkpoints.find((c) => c.phase === 'tool_recorded' && c.tool === 'SandboxRunCommand');
  assert.equal(shell.record.result.ok, true, JSON.stringify(shell.record.result));
  const first = host.previews.list().at(-1);
  assert.ok(first, JSON.stringify(host.explain(built.id).run.checkpoints));
  assert.equal(first.status, 'running');
  const assignment = localOnly ? null : host.computer.assignWindow('reviewer').assignment;
  const ready = localOnly ? { vnc_url: null } : await host.computer.readyWindow('reviewer');
  const open = async (p) => {
    if (localOnly) return { screenshot: null };
    const result = await host.computer.performWindowAction('reviewer', { ...assignment, action: 'open_url', detail: { url: p.docker_url, wait_ms: 1000 } });
    assert.equal(result.performed, true, JSON.stringify(result)); return result;
  };
  const initial = await open(first);
  assert.match(await (await fetch(new URL('message.txt', first.url))).text(), /BROKEN/);
  console.log('INITIAL_REVIEW', JSON.stringify({ dir, preview: first.url, view: ready.vnc_url, screenshot: initial.screenshot }));
  console.log('SIGUSR1 continues after browser review.'); await pause();
  phase = 'fix'; const fixedRun = await userRun('Fix checkout based on the review');
  const fixed = host.previews.list().at(-1); await open(fixed);
  assert.match(await (await fetch(new URL('message.txt', fixed.url))).text(), /READY/);
  console.log('FIXED_REVIEW', JSON.stringify({ preview: fixed.url, view: ready.vnc_url }));
  console.log('SIGUSR1 finishes after re-review.'); await pause();
  host.scheduler.cancelRun(fixedRun.id); await host.previews.stopCancelled();
  await assert.rejects(fetch(fixed.url));
  await host.previews.stop(first.id); await assert.rejects(fetch(first.url));
  console.log(localOnly ? 'PASS: dependency, build, snapshots and cleanup; independent Docker reviewer not exercised in local-only mode'
    : 'PASS: approved dependency download, sandbox build, independent reviewer surface, fix, re-review, cancellation cleanup');
} finally { await host.close(); console.log('CLEANED: preview listeners and reviewer container removed'); }
