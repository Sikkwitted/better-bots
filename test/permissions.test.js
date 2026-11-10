import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, reopenHost, say, call } from './helpers.js';
import { ACTION_POLICY, APPROVAL_TTL_MS, ZONES } from '../src/services/permission-service.js';

// Allow once, Always, Deny, and Never each behave correctly.

function setup() {
  const made = makeHost({ script: () => [say('ok')] });
  made.host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  // The approval tests below exercise a zone the user switched to Ask.
  made.host.permissions.setStandingMode('local', 'ask', { actor: 'user' });
  return made;
}

test('bots work without asking by default: every zone starts at Always', () => {
  const { host } = makeHost();
  for (const zone of ZONES) assert.equal(host.permissions.standingMode(zone), 'always', zone);
  for (const [action, policy] of Object.entries(ACTION_POLICY)) {
    const decision = host.permissions.authorize({ agent_id: 'agt_a', action, target: 'exact', scope_id: 's1' });
    if (policy.default === 'user_only') assert.equal(decision.decision, 'blocked', action);
    else assert.deepEqual([decision.decision, decision.basis], ['allowed', 'default_allow'], action);
  }
  assert.equal(host.permissions.pendingRequests().length, 0, 'nothing waits on a card');
});

test('upgrading switches zones nobody chose to Always and keeps every zone the user chose', () => {
  const { host, dir } = makeHost();
  host.permissions.setStandingMode('external', 'ask', { actor: 'user' });
  // A state file from the ask-first release: unchosen zones were stored as ask.
  host.permissions.doc.update((s) => { s.standing.local = 'ask'; s.standing.sandbox = 'ask'; return s; });
  const reopened = reopenHost({ dir }).host.permissions;
  assert.equal(reopened.standingMode('local'), 'always');
  assert.equal(reopened.standingMode('sandbox'), 'always');
  assert.equal(reopened.standingMode('external'), 'ask', 'a choice the user made is kept');
  assert.equal(reopened.authorize({ agent_id: 'agt_a', action: 'external.pay', target: 'invoice-42', scope_id: 's1' }).decision, 'ask');
});

test('the first-open notice is accepted once, by the user, and survives a restart', () => {
  const { host, dir } = makeHost();
  assert.equal(host.status().autonomy_acknowledged, false);
  assert.throws(() => host.permissions.acknowledgeAutonomy({ actor: 'agent' }), /only the user/);
  assert.equal(host.status().autonomy_acknowledged, false);
  const at = host.permissions.acknowledgeAutonomy({ actor: 'user' });
  assert.ok(at);
  assert.equal(host.permissions.acknowledgeAutonomy({ actor: 'user' }), at, 'accepting again keeps the first time');
  assert.equal(host.audit.where((e) => e.type === 'permission.autonomy_acknowledged').length, 2);
  assert.equal(reopenHost({ dir }).host.status().autonomy_acknowledged, true);
});

test('Allow once is scoped to agent, action, target, and scope', () => {
  const { host } = setup();
  const ask = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/x', scope_id: 's1' });
  host.permissions.resolve(ask.request.id, 'allow_once', { actor: 'user' });

  // Same everything: allowed, and the grant is consumed.
  const first = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/x', scope_id: 's1' });
  assert.equal(first.decision, 'allowed');
  assert.equal(first.basis, 'allow_once');

  // A different target is a different question.
  const otherTarget = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/y', scope_id: 's1' });
  assert.equal(otherTarget.decision, 'ask');
  // A different scope is a different turn.
  const otherScope = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/x', scope_id: 's2' });
  assert.equal(otherScope.decision, 'ask');
  // Repetition did not become consent.
  const repeat = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/x', scope_id: 's1' });
  assert.equal(repeat.decision, 'ask', 'an allow-once grant is spent, not standing');
});

test('Always changes the standing mode; Never blocks outright', () => {
  const { host } = setup();
  const ask = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/x', scope_id: 's1' });
  assert.equal(host.permissions.resolve(ask.request.id, 'always', { actor: 'user' }).ok, true);
  assert.equal(host.permissions.standingMode('local'), 'always');
  assert.equal(
    host.permissions.authorize({ agent_id: 'agt_a', action: 'local.write_file', target: '/tmp/z', scope_id: 's9' }).basis,
    'standing_always',
  );

  const ask2 = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/q', scope_id: 's2' });
  assert.equal(ask2.decision, 'allowed', 'standing always short-circuits the card');
  host.permissions.setStandingMode('local', 'never', { actor: 'user' });
  const blocked = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/q', scope_id: 's3' });
  assert.equal(blocked.decision, 'blocked');
  assert.equal(blocked.basis, 'standing_never');
});

test('Deny is remembered for the current direction only', () => {
  const { host } = setup();
  const ask = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.write_file', target: '/tmp/w', scope_id: 's1' });
  host.permissions.resolve(ask.request.id, 'deny', { actor: 'user' });
  assert.equal(
    host.permissions.authorize({ agent_id: 'agt_a', action: 'local.write_file', target: '/tmp/w', scope_id: 's1' }).basis,
    'denied_earlier',
  );
  host.permissions.retireScope('s1');
  assert.equal(
    host.permissions.authorize({ agent_id: 'agt_a', action: 'local.write_file', target: '/tmp/w', scope_id: 's2' }).decision,
    'ask',
  );
});

test('a pending ask expires after ten minutes', () => {
  const { host, clock } = setup();
  const ask = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/x', scope_id: 's1' });
  assert.equal(host.permissions.pendingRequests().length, 1);

  clock.advance(APPROVAL_TTL_MS + 1000);
  assert.equal(host.permissions.pendingRequests().length, 0);
  const late = host.permissions.resolve(ask.request.id, 'allow_once', { actor: 'user' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
});

test('an administrator ceiling caps what the user may choose', () => {
  const { host } = setup();
  host.permissions.setStandingMode('local', 'always', { actor: 'user' });
  host.permissions.setCeiling('local', 'ask', { actor: 'admin' });
  assert.equal(host.permissions.standingMode('local'), 'ask', 'lowering the ceiling clamps the current setting');

  assert.throws(() => host.permissions.setStandingMode('local', 'always', { actor: 'user' }), /ceiling/);
  const ask = host.permissions.authorize({ agent_id: 'agt_a', action: 'local.read_file', target: '/tmp/x', scope_id: 's1' });
  const blocked = host.permissions.resolve(ask.request.id, 'always', { actor: 'user' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'ceiling_exceeded');
  assert.throws(() => host.permissions.setCeiling('local', 'always', { actor: 'user' }), /administrator/);
});

test('changing a standing permission is a user-only decision', () => {
  const { host } = setup();
  assert.throws(() => host.permissions.setStandingMode('local', 'always', { actor: 'agent' }), /only the user/);
  assert.throws(() => host.permissions.resolve('apr_nope', 'allow_once', { actor: 'agent' }), /only the user/);
  const decision = host.permissions.authorize({
    agent_id: 'agt_a', action: 'policy.change_standing', target: 'local', scope_id: 's1',
  });
  assert.equal(decision.decision, 'blocked');
  assert.equal(decision.basis, 'user_only_decision');
});

test('destructive and external actions each have their own policy and need an exact target', () => {
  const { host } = setup();
  for (const action of ['external.publish', 'external.pay', 'external.send', 'external.delete']) {
    const vague = host.permissions.authorize({ agent_id: 'agt_a', action, target: '', scope_id: 's1' });
    assert.equal(vague.basis, 'exact_target_required', `${action} must name its target`);
    const exact = host.permissions.authorize({ agent_id: 'agt_a', action, target: 'invoice-42', scope_id: 's1' });
    assert.equal(exact.decision, 'allowed', `${action} runs without asking by default`);
  }
  host.permissions.setStandingMode('external', 'ask', { actor: 'user' });
  assert.equal(host.permissions.authorize({ agent_id: 'agt_a', action: 'external.pay', target: 'invoice-42', scope_id: 's1' }).decision, 'ask');
  assert.equal(host.permissions.policyFor('external.pay').high_risk, true);
});

test('sandbox work is allowed inside the workspace without a card', () => {
  const { host } = setup();
  const decision = host.permissions.authorize({ agent_id: 'agt_a', action: 'sandbox.write_file', target: 'a.txt', scope_id: 's1' });
  assert.equal(decision.decision, 'allowed');
  assert.equal(decision.basis, 'default_allow');
});

test('a blocked tool call never reaches its handler', async () => {
  const { host } = makeHost({ script: () => [call('LocalWriteFile', { path: '/tmp/should-not-exist-better-bots', content: 'x' })] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.permissions.setStandingMode('local', 'never', { actor: 'user' });

  host.userRequest({ agent_id: 'agt_a', text: 'write it' });
  await host.drain();

  const { existsSync } = await import('node:fs');
  assert.equal(existsSync('/tmp/should-not-exist-better-bots'), false, 'Never is a real block, not advice');
  assert.equal(host.audit.where((e) => e.type === 'tool.executed').length, 0);
});
