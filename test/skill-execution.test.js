import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHost, tmpDir, call, say } from './helpers.js';
import { bwrapArgs } from '../src/tools/shell-tool.js';

function fixture() {
  const dir = tmpDir('skill-execution');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: fixture\nfiles: [scripts/helper.sh, scripts/data.txt]\n---\nRun scripts/helper.sh to produce result.txt.');
  fs.writeFileSync(path.join(dir, 'scripts/helper.sh'), '#!/bin/sh\ncat "$(dirname "$0")/data.txt" > result.txt\necho helper-ran\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'scripts/data.txt'), 'declared asset');
  fs.writeFileSync(path.join(dir, 'undeclared.txt'), 'private');
  return dir;
}

test('import -> enable -> real sandbox helper execution, read-only assets, disable and isolation', async () => {
  let command;
  const { host } = makeHost({ script: () => [call('SandboxRunCommand', { command })] });
  for (const id of ['agt_a', 'agt_b']) host.registry.create({ id, profile: { name: id } });
  const record = host.workflows.importSkill(fixture());
  const bundle = host.workflows.bundle(record);
  assert.ok(record.bundle_version);
  assert.deepEqual(host.workflows.sandboxBundles('agt_a'), []);
  assert.equal(fs.existsSync(path.join(host.workspace, 'agents/agt_a/result.txt')), false);
  host.workflows.enableFor(record.id, 'agt_a');
  assert.ok(host.workflows.instructionsFor('agt_a')[0].text.includes(bundle.target));
  const execute = async (agent_id, cmd) => {
    command = cmd;
    const run = host.userRequest({ agent_id, text: 'exercise enabled skill' });
    await host.drain();
    return host.explain(run.id).run.checkpoint.record.result;
  };
  const result = await execute('agt_a', `sh '${bundle.target}/scripts/helper.sh'`);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.stdout, /helper-ran/);
  assert.equal(fs.readFileSync(path.join(host.workspace, 'agents/agt_a/result.txt'), 'utf8'), 'declared asset');
  assert.ok(host.audit.where((e) => e.type === 'tool.executed' && e.name === 'SandboxRunCommand').length);
  assert.equal((await execute('agt_a', `echo tampered > '${bundle.target}/scripts/data.txt'`)).ok, false);
  assert.equal((await execute('agt_a', `cat '${bundle.target}/undeclared.txt'`)).ok, false);
  // Encode the path so this tests OS enforcement rather than the shell path guard.
  const read = `p=$(printf %s ${Buffer.from(`${bundle.target}/scripts/data.txt`).toString('base64')} | base64 -d); cat "$p"`;
  assert.equal((await execute('agt_b', read)).ok, false);
  host.workflows.disableFor(record.id, 'agt_a');
  assert.deepEqual(host.workflows.sandboxBundles('agt_a'), []);
  assert.equal((await execute('agt_a', read)).ok, false);
  assert.equal(fs.readFileSync(record.files.find((f) => f.declared_as === 'scripts/data.txt').stored_at, 'utf8'), 'declared asset');
});

test('Linux mount plan exposes only enabled bundles read-only', () => {
  const { host } = makeHost(); host.registry.create({ id: 'agt_a' });
  host.workflows.sandbox_kind = 'bwrap';
  const record = host.workflows.importSkill(fixture()); host.workflows.enableFor(record.id, 'agt_a');
  const bundles = host.workflows.sandboxBundles('agt_a');
  assert.match(bundles[0].target, new RegExp(`^/skills/${record.id}/${record.bundle_version}$`));
  const args = bwrapArgs({ workspace: host.workspace, agentId: 'agt_a', cwd: path.join(host.workspace, 'agents/agt_a'), env: {}, bundles });
  const source = args.indexOf(bundles[0].source);
  assert.equal(args[source - 1], '--ro-bind'); assert.equal(args[source + 1], bundles[0].target);
  assert.ok(!bwrapArgs({ workspace: host.workspace, agentId: 'agt_b', cwd: host.workspace, env: {} }).includes(bundles[0].source));
});

for (const kind of ['traversal', 'file-link', 'directory-link', 'hard-link']) {
  test(`reject ${kind} in imported helper declarations`, () => {
    const { host } = makeHost(); const source = fixture(); const outside = tmpDir('skill-outside');
    fs.writeFileSync(path.join(outside, 'secret'), 'private');
    let declared = 'escape';
    if (kind === 'traversal') declared = '../outside';
    if (kind === 'file-link') fs.symlinkSync(path.join(outside, 'secret'), path.join(source, 'escape'));
    if (kind === 'directory-link') { fs.symlinkSync(outside, path.join(source, 'escape')); declared = 'escape/secret'; }
    if (kind === 'hard-link') fs.linkSync(path.join(outside, 'secret'), path.join(source, 'escape'));
    fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nfiles: [${declared}]\n---\nfixture`);
    assert.throws(() => host.workflows.importSkill(source), /skill/);
    assert.deepEqual(host.workflows.list(), []);
  });
}

test('changed bundles fail closed; reimport produces a distinct enabled version', () => {
  const { host } = makeHost({ script: () => [say('ok')] }); host.registry.create({ id: 'agt_a' });
  const source = fixture(); const old = host.workflows.importSkill(source); host.workflows.enableFor(old.id, 'agt_a');
  fs.writeFileSync(old.helper_scripts[0].stored_at, 'echo changed');
  assert.throws(() => host.workflows.sandboxBundles('agt_a'), /changed/);
  host.workflows.disableFor(old.id, 'agt_a');
  fs.writeFileSync(path.join(source, 'scripts/helper.sh'), 'echo new');
  const next = host.workflows.importSkill(source);
  assert.notEqual(old.bundle_version, next.bundle_version);
  assert.deepEqual(host.workflows.sandboxBundles('agt_a'), []);
  host.workflows.enableFor(next.id, 'agt_a');
  assert.deepEqual(host.workflows.sandboxBundles('agt_a').map((b) => b.id), [next.id]);
});
