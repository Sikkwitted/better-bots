import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHost, say, call, tmpDir } from './helpers.js';
import { escapesWorkspace, MAX_OUTPUT_BYTES, scrubbedEnvironment } from '../src/tools/shell-tool.js';

// One shared computer, honest boundaries.

function setup(script) {
  const made = makeHost({ script });
  for (const id of ['agt_a', 'agt_b']) made.host.registry.create({ id, profile: { name: id.toUpperCase() } });
  return made;
}

async function runAs(host, agentId, text = 'go') {
  host.userRequest({ agent_id: agentId, text });
  await host.drain();
  return host.transcripts.all('agent', agentId).filter((e) => e.kind === 'tool_result' && e.name === 'SandboxRunCommand').at(-1)?.result;
}

test('a command runs in the agent directory and returns structured output', async () => {
  const { host } = setup(() => [call('SandboxRunCommand', { command: 'printf hello; pwd' })]);
  const result = await runAs(host, 'agt_a');
  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /^hello/);
  assert.match(result.stdout, new RegExp(path.join('agents', 'agt_a').replace(/\\/g, '\\\\')));
  assert.equal(result.cwd, '.');
  assert.equal(result.timed_out, false);
  assert.ok(host.audit.where((e) => e.type === 'tool.executed' && e.name === 'SandboxRunCommand').length === 1);
});

test('each agent gets its own working directory on the shared computer', async () => {
  const { host } = setup((ctx) => [call('SandboxRunCommand', { command: `echo ${ctx.agent_id} > who.txt; cat who.txt` })]);
  const a = await runAs(host, 'agt_a');
  const b = await runAs(host, 'agt_b');
  assert.match(a.stdout, /agt_a/);
  assert.match(b.stdout, /agt_b/);
  assert.equal(fs.readFileSync(path.join(host.workspace, 'agents', 'agt_a', 'who.txt'), 'utf8').trim(), 'agt_a');
  assert.equal(fs.readFileSync(path.join(host.workspace, 'agents', 'agt_b', 'who.txt'), 'utf8').trim(), 'agt_b');
});

test('returned cwd can be reused to read a file from the same directory', async (t) => {
  for (const cwd of [undefined, 'reports/daily']) {
    await t.test(cwd ?? 'agent home', async () => {
      let input = { command: 'printf saved > marker.txt', ...(cwd ? { cwd } : {}) };
      const { host } = setup(() => [call('SandboxRunCommand', input)]);
      const written = await runAs(host, 'agt_a');
      assert.equal(written.ok, true);

      input = { command: 'cat marker.txt', cwd: written.cwd };
      const read = await runAs(host, 'agt_a');
      assert.equal(read.ok, true, read.stderr);
      assert.equal(read.stdout, 'saved');
      assert.equal(read.cwd, written.cwd);
      assert.equal(fs.existsSync(path.join(host.workspace, 'agents', 'agt_a', 'agents')), false);
    });
  }
});

test('the environment is scrubbed so credentials never reach a command', async () => {
  process.env.BETTER_BOTS_TEST_SECRET = 'leak-me';
  try {
    const { host } = setup(() => [call('SandboxRunCommand', { command: 'echo "[$BETTER_BOTS_TEST_SECRET][$ANTHROPIC_API_KEY][$BETTER_BOTS_SANDBOX]"' })]);
    const result = await runAs(host, 'agt_a');
    assert.equal(result.stdout.trim(), '[][][1]');
  } finally {
    delete process.env.BETTER_BOTS_TEST_SECRET;
  }
  const env = scrubbedEnvironment({ home: '/x', agentId: 'agt_a' });
  // Only the scrubbed set plus the build toolchain's own variables, never the host's secrets.
  const allowed = ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME', 'HOME', 'JAVA_HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'BETTER_BOTS_AGENT_ID', 'BETTER_BOTS_SANDBOX'];
  assert.ok(Object.keys(env).every((k) => allowed.includes(k)), `unexpected variable in ${Object.keys(env)}`);
  for (const k of ['HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'BETTER_BOTS_AGENT_ID', 'BETTER_BOTS_SANDBOX', 'GRADLE_USER_HOME']) assert.ok(k in env, `${k} missing`);
});

test('a runaway command is killed at the timeout and reported honestly', async () => {
  const { host } = setup(() => [call('SandboxRunCommand', { command: 'sleep 20; echo late', timeout_ms: 1000 })]);
  const started = Date.now();
  const result = await runAs(host, 'agt_a');
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.stdout.includes('late'), false);
  assert.ok(Date.now() - started < 10_000, 'the timeout must actually end the command');
});

test('a non-zero exit is a failure with stderr preserved', async () => {
  const { host } = setup(() => [call('SandboxRunCommand', { command: 'echo bad >&2; exit 3' })]);
  const result = await runAs(host, 'agt_a');
  assert.equal(result.ok, false);
  assert.equal(result.exit_code, 3);
  assert.match(result.stderr, /bad/);
});

test('output is capped and marked truncated', async () => {
  const { host } = setup(() => [call('SandboxRunCommand', { command: `head -c ${MAX_OUTPUT_BYTES * 3} /dev/zero | tr '\\0' 'a'` })]);
  const result = await runAs(host, 'agt_a');
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length < MAX_OUTPUT_BYTES + 200);
  assert.match(result.stdout, /\[truncated \d+ bytes\]/);
});

test('commands that reach outside the workspace are refused before they run', async () => {
  const root = '/srv/better-bots/workspace';
  assert.equal(escapesWorkspace('cat /etc/passwd', root).escapes, true);
  assert.equal(escapesWorkspace('cat ../../etc/passwd', root).escapes, true);
  assert.equal(escapesWorkspace('ls ~/Desktop', root).escapes, true);
  assert.equal(escapesWorkspace(`ls ${root}/agents`, root).escapes, false);
  assert.equal(escapesWorkspace('grep -r TODO . > /dev/null', root).escapes, false);
  assert.equal(escapesWorkspace('head -c 10 /dev/urandom | od', root).escapes, false);
  assert.equal(escapesWorkspace('node --version && ls -la', root).escapes, false);

  // Reaching for the host's secrets. Without a container the guard refuses the
  // command; inside one the command runs and the file does not exist to be read.
  const { host } = setup(() => [call('SandboxRunCommand', { command: 'cat /var/lib/better-bots/better-bots.env' })]);
  const result = await runAs(host, 'agt_a');
  assert.equal(result.ok, false);
  if (host.tools.get('SandboxRunCommand').isolation.kind === 'bwrap') {
    assert.equal(result.isolation, 'bwrap');
    assert.match(result.stderr, /No such file or directory/);
  } else {
    assert.equal(result.error, 'outside_workspace');
    assert.ok(host.audit.where((e) => e.type === 'tool.failed' && e.name === 'SandboxRunCommand').length === 1);
  }
});

test('an optional cwd stays inside the agent directory', async () => {
  const { host } = setup(() => [call('SandboxRunCommand', { command: 'pwd', cwd: '../agt_b' })]);
  const result = await runAs(host, 'agt_a');
  assert.equal(result.error, 'outside_workspace');
});

test('the shell passes the sandbox permission gate without an approval card', async () => {
  const { host } = setup(() => [call('SandboxRunCommand', { command: 'echo ok' })]);
  host.userRequest({ agent_id: 'agt_a', text: 'go' });
  await host.drain();
  const explanation = host.explain(host.scheduler.runHistory().at(-1).id);
  assert.deepEqual(explanation.result.tools.map((t) => ({ name: t.name, decision: t.decision })), [{ name: 'SandboxRunCommand', decision: 'allowed' }]);
});

test('the boundary table names the shell honestly', () => {
  const { host } = setup(() => [say('ok')]);
  const row = host.computer.describe().boundaries.find((b) => b.surface.startsWith('Shell'));
  assert.ok(row);
  if (['bwrap', 'seatbelt'].includes(host.tools.get('SandboxRunCommand').isolation.kind)) {
    assert.equal(row.private, true);
    assert.match(row.boundary, /kernel namespaces|Seatbelt/);
  } else {
    assert.equal(row.private, false);
    assert.match(row.boundary, /disabled/);
  }
});

// The per-command container. Its mount plan is a pure function, so what the
// sandbox can and cannot see is tested everywhere; the live run only where
// bubblewrap exists (Linux CI, servers).
import { bwrapArgs, detectIsolation, SANDBOX_ROOT } from '../src/tools/shell-tool.js';

test('the container mount plan binds the agent read-write, the workspace read-only, and nothing of the host state', () => {
  const workspace = tmpDir();
  const cwd = path.join(workspace, 'agents', 'agt_a', 'sub');
  fs.mkdirSync(cwd, { recursive: true });
  const args = bwrapArgs({ workspace, agentId: 'agt_a', cwd, env: { PATH: '/usr/bin', HOME: `${SANDBOX_ROOT}/agents/agt_a` } });
  const pairs = (flag) => args.flatMap((a, i) => (a === flag ? [[args[i + 1], args[i + 2]]] : []));

  assert.deepEqual(pairs('--bind').map(([, dst]) => dst).sort(), [`${SANDBOX_ROOT}/agents/agt_a`], 'only its own directory is writable');
  assert.ok(pairs('--ro-bind').some(([src, dst]) => src === path.resolve(workspace) && dst === SANDBOX_ROOT), 'the workspace is visible read-only');
  assert.ok(pairs('--ro-bind').some(([src]) => src === '/usr') && pairs('--ro-bind').some(([src]) => src === '/etc'), 'the system is visible read-only');
  const sources = [...pairs('--bind'), ...pairs('--ro-bind')].map(([src]) => src);
  assert.ok(!sources.some((s) => /\/var\/lib|\/opt|\/root|\/home/.test(s)), 'no host state, code, or home directory is bound');
  assert.ok(sources.every((s) => !s.includes('agents/agt_b')), 'nothing names another agent');
  for (const ns of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--clearenv']) assert.ok(args.includes(ns), ns);
  assert.ok(args.includes('--unshare-net'), 'network effects require host-gated tools');
  assert.equal(args[args.indexOf('--chdir') + 1], `${SANDBOX_ROOT}/agents/agt_a/sub`, 'cwd is translated into the sandbox');
  assert.ok(fs.existsSync(path.join(workspace, 'shared')), 'the shared directory exists so it can be bound');
});

test('without bubblewrap the tool says so, and with an override it can be forced off', () => {
  assert.ok(['seatbelt', 'unavailable'].includes(detectIsolation({ BETTER_BOTS_BWRAP: '/nonexistent/bwrap' }).kind));
  assert.equal(detectIsolation({ BETTER_BOTS_SHELL_ISOLATION: 'process' }).kind, 'process');
  const { host } = makeHost();
  const tool = host.tools.get('SandboxRunCommand');
  assert.ok(['bwrap', 'seatbelt', 'unavailable'].includes(tool.isolation.kind));
  assert.equal(host.computer.describe().shell_isolation, tool.isolation.kind);
  const shell = host.computer.describe().boundaries.find((b) => b.surface.startsWith('Shell'));
  assert.equal(shell.private, ['bwrap', 'seatbelt'].includes(tool.isolation.kind), 'the boundary table matches reality');
});

test('inside the container the host state is simply absent (live, where bubblewrap exists)', { skip: detectIsolation().kind !== 'bwrap' && 'no bubblewrap here' }, async () => {
  const { host } = makeHost({ script: () => [call('SandboxRunCommand', { command: 'ls /var/lib/better-bots /opt 2>&1; echo mine > mine.txt; cat /proc/1/comm; pwd' })] });
  const agent = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.userRequest({ agent_id: agent.id, text: 'probe' });
  await host.drain();
  const result = host.transcripts.all('agent', agent.id).find((e) => e.kind === 'tool_result').result;
  assert.equal(result.isolation, 'bwrap');
  assert.match(result.stdout, /No such file or directory/);
  assert.match(result.stdout, /bwrap/);
  assert.match(result.stdout, new RegExp(`${SANDBOX_ROOT}/agents/agt_a`));
  assert.equal(fs.readFileSync(path.join(host.workspace, 'agents', 'agt_a', 'mine.txt'), 'utf8').trim(), 'mine', 'writes land in the real directory');
});

// The macOS profile, run for real where Seatbelt exists.
import { spawnSync } from 'node:child_process';
import { macProfile } from '../src/services/process-boundary.js';

test('Seatbelt hides the clipboard, shared temp folders and disks, and ordinary commands still run', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, () => {
  const workspace = tmpDir();
  const home = path.join(workspace, 'agents', 'agt_a');
  fs.mkdirSync(path.join(home, '.tmp'), { recursive: true });
  const outside = fs.mkdtempSync('/private/tmp/bb-seatbelt-');
  fs.writeFileSync(path.join(outside, 'other.txt'), 'not yours');
  const run = (command) => spawnSync('/usr/bin/sandbox-exec', ['-p', macProfile([home], [workspace], { network: false }), '/bin/sh', '-c', command],
    { cwd: home, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, HOME: home, TMPDIR: path.join(home, '.tmp') } });
  try {
    assert.notEqual(run('pbpaste').status, 0, 'the pasteboard service is out of reach');
    assert.notEqual(run(`cat ${outside}/other.txt`).status, 0, '/private/tmp is hidden');
    assert.notEqual(run(`cat ${outside.replace('/private', '')}/other.txt`).status, 0, '/tmp is hidden');
    assert.notEqual(run('ls /Volumes').status, 0, 'disks are hidden');
    for (const command of ['ls', 'git --version', `${JSON.stringify(process.execPath)} -e "1"`, 'echo ok > "$TMPDIR/x" && cat "$TMPDIR/x"', `ls ${JSON.stringify(workspace)}`]) {
      assert.equal(run(command).status, 0, command);
    }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
