import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeHost, tmpDir, makeGate, call, say } from './helpers.js';

function fixture(script = () => [say('done')]) {
  const made = makeHost({ script });
  const agent = made.host.registry.create({ id: 'agt_a', profile: { name: 'Builder' } });
  const root = path.join(made.host.workspace, 'agents/agt_a/dist'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Initial build</h1>');
  return { ...made, agent, root };
}
const input = { directory: 'dist', files: ['index.html'] };

test('preview survives turns, snapshots build files, scopes requests, and stops with completed originating work', async () => {
  const { host } = fixture(() => [call('StartPreview', input)]);
  const run = host.userRequest({ agent_id: 'agt_a', text: 'preview' }); await host.drain();
  const preview = host.previews.list()[0];
  try {
    assert.equal(preview.status, 'running');
    assert.equal(host.explain(run.id).run.status, 'completed');
    const response = await fetch(preview.url);
    assert.equal(await response.text(), '<h1>Initial build</h1>');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal((await fetch(new URL('/elsewhere', preview.url))).status, 404);
    assert.equal((await fetch(new URL('../agents/agt_a/index.html', preview.url))).status, 404);
    fs.writeFileSync(path.join(host.workspace, 'agents/agt_a/dist/index.html'), '<h1>Changed build</h1>');
    assert.equal(await (await fetch(preview.url)).text(), '<h1>Initial build</h1>');
    host.scheduler.cancelRun(run.id); await host.previews.stopCancelled();
    await assert.rejects(fetch(preview.url));
    assert.equal(host.previews.list()[0].stop_reason, 'work_cancelled');
    assert.equal(host.explain(run.id).run.status, 'completed', 'completed work remains completed');
  } finally { await host.close(); }
});

test('symlink, traversal, non-owned files and excessive file lists cannot be served', async () => {
  const { host, agent, root } = fixture();
  const run = host.userRequest({ agent_id: agent.id, text: 'preview' });
  fs.symlinkSync('/etc/passwd', path.join(root, 'secret.txt'));
  for (const bad of [
    { directory: '../agt_b', files: ['index.html'] },
    { directory: 'dist', files: ['index.html', 'secret.txt'] },
    { directory: 'dist', files: ['index.html', '../secret.txt'] },
    { directory: 'dist', files: ['index.html', ...Array(100).fill('x.js')] },
  ]) await assert.rejects(host.previews.start({ agent, input: bad, run }));
  assert.equal(host.previews.live.size, 0);
});

test('cancellation during snapshot reading prevents listener creation', async () => {
  const { host, agent } = fixture(); const entered = makeGate(), release = makeGate();
  const execute = host.files.execute.bind(host.files);
  host.files.execute = async (...args) => { entered.release(); await release.promise; return execute(...args); };
  const run = host.userRequest({ agent_id: agent.id, text: 'preview' });
  const starting = host.previews.start({ agent, input, run });
  const rejected = assert.rejects(starting, /cancelled/);
  await entered.promise; host.scheduler.cancelRun(run.id); release.release(); await rejected;
  assert.equal(host.previews.live.size, 0);
});

test('preview owner gate and repeated stop preserve unrelated previews', async () => {
  const { host, agent } = fixture(); const run = host.userRequest({ agent_id: agent.id, text: 'preview' });
  const a = await host.previews.start({ agent, input, run });
  const b = await host.previews.start({ agent, input, run });
  try {
    assert.throws(() => host.previews.stop(a.id, 'agent_stopped', 'someone_else'), /owning agent/);
    await host.previews.stop(a.id); await host.previews.stop(a.id);
    assert.equal((await fetch(b.url)).status, 200);
    await assert.rejects(fetch(a.url));
  } finally { await host.close(); }
});

test('dependency downloads honor standing permission, registry scope, integrity and safe writes', async () => {
  const bytes = Buffer.from('fixture package bytes');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const dep = { url: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity, path: 'dependency.b64' };
  const { host, agent } = fixture(() => [call('FetchDependency', dep)]);
  let fetched = 0;
  host.previews.fetchImpl = async () => { fetched++; return new Response(bytes); };
  host.permissions.setStandingMode('external', 'always');
  const blocked = host.userRequest({ agent_id: agent.id, text: 'fetch' }); await host.drain();
  assert.equal(fetched, 1, 'standing Always allows dependency fetches');
  assert.equal(host.permissions.pendingRequests().length, 0);
  const run = host.userRequest({ agent_id: agent.id, text: 'fetch' });
  const ok = await host.previews.fetchDependency({ agent, input: dep, run });
  assert.equal(ok.ok, true);
  assert.deepEqual(Buffer.from(fs.readFileSync(path.join(host.workspace, 'agents/agt_a/dependency.b64'), 'utf8'), 'base64'), bytes);
  await assert.rejects(host.previews.fetchDependency({ agent, input: { ...dep, url: 'https://localhost/private.tgz' }, run }), /registry/);
  await assert.rejects(host.previews.fetchDependency({ agent, input: { ...dep, integrity: 'sha512-AAAA' }, run }), /integrity/);
  await assert.rejects(host.previews.fetchDependency({ agent, input: { ...dep, path: '../escape' }, run }), /relative path/);
  host.scheduler.cancelRun(run.id);
  await assert.rejects(host.previews.fetchDependency({ agent, input: dep, run }), /cancelled/);
});

test('SIGKILL closes the preview listener; restart marks it stopped without hidden resumption', async () => {
  const dir = tmpDir('preview-crash');
  const child = spawnSync(process.execPath, [new URL('./fixtures/crash-preview.mjs', import.meta.url).pathname, dir]);
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const before = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'previews.json'))).previews)[0];
  assert.equal(before.status, 'running');
  await assert.rejects(fetch(before.url));
  const { host } = makeHost({ dir });
  assert.equal(host.previews.list()[0].status, 'stopped');
  assert.equal(host.previews.list()[0].stop_reason, 'host_restarted');
  assert.equal(host.previews.live.size, 0);
});
