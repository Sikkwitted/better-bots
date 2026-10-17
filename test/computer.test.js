import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, say, call } from './helpers.js';

// One shared sandbox computer with per-agent screens: window ownership, capacity,
// and what the person can see.

function setup(window_count = 2) {
  const made = makeHost({ script: () => [say('ok')], window_count });
  for (const id of ['agt_a', 'agt_b', 'agt_c']) {
    made.host.registry.create({ id, profile: { name: id.toUpperCase() } });
  }
  return made;
}

test('each agent gets a distinct window on one shared computer', () => {
  const { host } = setup(3);
  const a = host.computer.assignWindow('agt_a');
  const b = host.computer.assignWindow('agt_b');
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.assignment.window_index, b.assignment.window_index);
  assert.equal(a.assignment.computer_id, b.assignment.computer_id);
  assert.notEqual(a.assignment.vnc_url, b.assignment.vnc_url);
  assert.notEqual(a.assignment.owner_token, b.assignment.owner_token);
});

test('an owner token prevents window theft', () => {
  const { host } = setup(3);
  const a = host.computer.assignWindow('agt_a').assignment;
  host.computer.assignWindow('agt_b');

  assert.throws(
    () => host.computer.useWindow('agt_b', { window_index: a.window_index, owner_token: a.owner_token, action: 'click' }),
    /does not own window/,
  );
  assert.ok(host.audit.where((e) => e.type === 'computer.window_theft_blocked').length === 1);
  assert.equal(host.computer.verifyOwner('agt_b', a.window_index, a.owner_token), false);
  assert.equal(host.computer.verifyOwner('agt_a', a.window_index, a.owner_token), true);
  assert.equal(host.computer.useWindow('agt_a', { window_index: a.window_index, owner_token: a.owner_token, action: 'click' }).ok, true);
});

test('exhaustion is reported honestly with real fallbacks', async () => {
  const { host } = setup(2);
  host.computer.assignWindow('agt_a');
  host.computer.assignWindow('agt_b');
  const third = host.computer.assignWindow('agt_c');

  assert.equal(third.ok, false);
  assert.equal(third.reason, 'no_monitor_available');
  assert.match(third.detail, /every monitor on shared computer/);
  assert.deepEqual(third.options, [
    'queue_the_computer_use_step',
    'fall_back_to_non_visual_tools',
    'reuse_a_released_window',
    'tell_the_user_the_screen_is_unavailable',
  ]);

  await host.computer.releaseWindow('agt_a');
  const retry = host.computer.assignWindow('agt_c');
  assert.equal(retry.ok, true, 'a released window can be reused');
});

test('the OpenScreen tool surfaces exhaustion instead of faking success', async () => {
  const { host } = makeHost({ script: () => [call('OpenScreen', {})], window_count: 1 });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'B' } });

  host.userRequest({ agent_id: 'agt_a', text: 'open a screen' });
  await host.drain();
  host.userRequest({ agent_id: 'agt_b', text: 'open a screen' });
  await host.drain();

  const bResult = host.transcripts.all('agent', 'agt_b').find((e) => e.kind === 'tool_result' && e.name === 'OpenScreen');
  assert.equal(bResult.result.ok, false);
  assert.equal(bResult.result.reason, 'no_monitor_available');
});

test('an assignment survives a reassignment request', () => {
  const { host } = setup(3);
  const first = host.computer.assignWindow('agt_a');
  const again = host.computer.assignWindow('agt_a');
  assert.equal(again.reused, true);
  assert.equal(again.assignment.window_index, first.assignment.window_index);
  assert.equal(again.assignment.owner_token, first.assignment.owner_token);
});

test('the sandbox tool cannot escape its workspace', async () => {
  const { host } = makeHost({ script: () => [call('SandboxWriteFile', { path: '../../escape.txt', content: 'nope' })] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'escape' });
  await host.drain();

  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.error, 'outside_workspace');
});
