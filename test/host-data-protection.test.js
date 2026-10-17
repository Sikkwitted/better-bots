import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { call, makeHost, tmpDir } from './helpers.js';

// The host's data folder holds provider keys and access tokens, owned by the same
// account the host-machine tools run as. Those tools must not reach it, even when
// the local zone is "always"; only the shared workspace inside it stays open.

test('a bot with standing local permission still cannot read the host’s secrets', async () => {
  const probe = makeHost();
  const secrets = path.join(probe.dir, 'providers-secrets.json');
  const { host } = makeHost({ dir: probe.dir, script: () => [call('LocalReadFile', { path: secrets })] });
  fs.writeFileSync(secrets, '{"anthropic":"sk-ant-real-looking-secret"}');
  host.permissions.setStandingMode('local', 'always');
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'read it' });
  await host.drain();
  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.name === 'LocalReadFile').result;
  assert.equal(result.error, 'host_data_protected');
  assert.doesNotMatch(JSON.stringify(host.transcripts.all('agent', 'agt_a')), /sk-ant-real-looking-secret/);
});

test('the data folder is closed to host-machine reads, writes and PDFs, through symlinks too; the workspace and the rest of the machine stay open', async () => {
  const { host, dir } = makeHost();
  const tool = (name) => host.tools.get(name);
  const env = path.join(dir, 'better-bots.env');
  fs.writeFileSync(env, 'BETTER_BOTS_TOKEN=secret\n');
  const outside = tmpDir();
  const link = path.join(outside, 'innocent.txt');
  fs.symlinkSync(env, link);
  const elsewhere = path.join(outside, 'notes.txt');
  fs.writeFileSync(elsewhere, 'public notes');
  fs.mkdirSync(host.workspace, { recursive: true });
  const shared = path.join(host.workspace, 'shared.txt');
  fs.writeFileSync(shared, 'workspace text');

  for (const target of [env, link, dir, path.join(dir, 'nested', '..', 'better-bots.env')])
    assert.equal(tool('LocalReadFile').handler({ input: { path: target } }).error, 'host_data_protected', target);
  for (const target of [env, path.join(dir, 'registry.json'), path.join(outside, 'innocent.txt')])
    assert.equal(tool('LocalWriteFile').handler({ agent: { id: 'agt_a' }, input: { path: target, content: 'x' } }).error, 'host_data_protected', target);
  assert.equal(fs.readFileSync(env, 'utf8'), 'BETTER_BOTS_TOKEN=secret\n', 'nothing was overwritten');
  assert.equal((await tool('HostReadPDF').handler({ input: { path: env } })).error, 'host_data_protected');

  assert.equal(tool('LocalReadFile').handler({ input: { path: elsewhere } }).content, 'public notes');
  assert.equal(tool('LocalReadFile').handler({ input: { path: shared } }).content, 'workspace text');
});
