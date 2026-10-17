import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, reopenHost, call } from './helpers.js';
import { ACTION_POLICY, APPROVAL_TTL_MS } from '../src/services/permission-service.js';
const input = { agent_id: 'agt_a', action: 'sandbox.write_file', target: 'shared/x', scope_id: 'r1', run_id: 'r1', call_id: 'c1', tool: 'Writer', input_hash: 'exact' };

for (const [action, policy] of Object.entries(ACTION_POLICY).filter(([,p]) => p.default !== 'user_only')) {
  test(`${action}: all nine standing/ceiling combinations are enforced`, () => {
    const { host } = makeHost(); const p = host.permissions;
    const rank = { never: 0, ask: 1, always: 2 };
    for (const mode of ['always', 'ask', 'never']) for (const ceiling of ['always', 'ask', 'never']) {
      // Deliberately retain an over-permissive stored mode: the gate itself must clamp it.
      p.doc.update((s) => { s.standing[policy.zone] = mode; s.explicit[policy.zone] = true; s.ceiling[policy.zone] = ceiling; return s; });
      const decision = p.authorize({ ...input, action, scope_id: `${mode}-${ceiling}` });
      assert.equal(decision.decision, ['blocked', 'ask', 'allowed'][Math.min(rank[mode],rank[ceiling],policy.per_call ? 1 : 2)]);
    }
  });
}

test('fresh defaults preserve public/sandbox reads and ask for private or consequential actions', () => {
  const { host } = makeHost();
  for (const [action, policy] of Object.entries(ACTION_POLICY)) {
    assert.equal(host.permissions.authorize({ ...input, action }).decision, policy.default === 'allow' ? 'allowed' : policy.default === 'ask' ? 'ask' : 'blocked');
  }
});

test('saved explicit settings and conservative legacy migration survive restart', () => {
  const { host, dir } = makeHost();
  host.permissions.setStandingMode('sandbox', 'never');
  assert.equal(reopenHost({ dir }).host.permissions.authorize(input).decision, 'blocked');
  host.permissions.doc.update((s) => { delete s.explicit; s.standing.external = 'ask'; return s; });
  const reopened = reopenHost({ dir }).host;
  assert.equal(reopened.permissions.authorize({ ...input, action: 'web.read_public' }).decision, 'ask');
  assert.equal(reopened.permissions.authorize(input).decision, 'blocked');
});

test('unsupported zones/modes and agent-originated policy changes cannot mutate state', () => {
  const { host } = makeHost(); const p = host.permissions; const before = p.doc.read();
  assert.throws(() => p.setStandingMode('unknown', 'always'), /zone/);
  assert.throws(() => p.setCeiling('unknown', 'always'), /zone/);
  assert.throws(() => p.setStandingMode('sandbox', 'invalid'), /mode/);
  assert.throws(() => p.setCeiling('sandbox', 'invalid'), /mode/);
  assert.throws(() => p.setStandingMode('sandbox', 'always', { actor: 'agent' }), /user/);
  assert.deepEqual(p.doc.read(), before);
});

test('grant matches the exact call, tool, arguments, run, agent, action, target and scope; previews do not spend it', () => {
  const { host, dir } = makeHost(); const p = host.permissions; p.setStandingMode('sandbox', 'ask');
  const request = p.authorize(input).request; p.resolve(request.id, 'allow_once');
  for (const key of ['call_id','tool','input_hash','run_id','agent_id','scope_id','target']) assert.equal(p.authorize({ ...input, [key]: 'different' }).decision, 'ask', key);
  assert.equal(p.authorize({ ...input, action: 'sandbox.read_file' }).decision, 'ask');
  assert.equal(p.authorize({ ...input, consume: false }).basis, 'allow_once');
  assert.equal(p.authorize({ ...input, consume: false }).basis, 'allow_once');
  assert.equal(p.authorize(input).basis, 'allow_once');
  assert.equal(reopenHost({ dir }).host.permissions.authorize(input).decision, 'ask', 'consumption is durable');
});

test('grant expiry, retirement, denials and a later Never remain authoritative', () => {
  for (const change of ['expiry', 'retire', 'deny', 'never', 'ceiling']) {
    const { host, clock } = makeHost(); const p = host.permissions; p.setStandingMode('sandbox', 'ask');
    const request = p.authorize(input).request; p.resolve(request.id, change === 'deny' ? 'deny' : 'allow_once');
    if (change === 'expiry') clock.advance(APPROVAL_TTL_MS + 1);
    if (change === 'retire') p.retireScope(input.scope_id);
    if (change === 'never') p.setStandingMode('sandbox', 'never');
    if (change === 'ceiling') p.setCeiling('sandbox', 'never');
    assert.equal(p.authorize(input).decision, ['expiry','retire'].includes(change) ? 'ask' : 'blocked');
  }
});

test('pending asks coalesce but no approval resolution bypasses a current ceiling', () => {
  const { host } = makeHost(); const p = host.permissions; p.setStandingMode('sandbox', 'ask');
  const request = p.authorize(input).request;
  assert.equal(p.authorize(input).request.id, request.id);
  p.setCeiling('sandbox', 'never');
  assert.equal(p.resolve(request.id, 'allow_once').ok, false);
  assert.equal(p.resolve(request.id, 'always').ok, false);
  assert.equal(p.doc.read().grants.length, 0);
});

async function toolHost() {
  const made = makeHost({ script: () => [call('Probe', { value: 'exact' })] });
  made.host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  made.host.approval_mode = 'wait';
  let executions = 0;
  made.host.tools.register({ name: 'Probe', description: 'test', side_effect: 'test', permission: { action: 'sandbox.write_file', target: () => 'exact' }, input_schema: { type: 'object' }, handler: () => { executions++; return { ok: true }; } });
  return { ...made, executions: () => executions };
}

test('a resolved allow-once executes exactly once through the host final check', async () => {
  const made = await toolHost(); const p = made.host.permissions; p.setStandingMode('sandbox', 'ask');
  const authorize = p.authorize.bind(p);
  p.authorize = (args) => { const result = authorize(args); if (result.decision === 'ask') p.resolve(result.request.id, 'allow_once'); return result; };
  made.host.userRequest({ agent_id: 'agt_a', text: 'go' }); await made.host.drain();
  assert.equal(made.executions(), 1);
  assert.equal(made.host.audit.where((e) => e.type === 'permission.allowed' && e.basis === 'allow_once').length, 1);
});

for (const boundary of ['pending', 'after_preview']) test(`policy tightening at ${boundary} prevents handler execution`, async () => {
  const made = await toolHost(); const p = made.host.permissions;
  if (boundary === 'pending') p.setStandingMode('sandbox', 'ask');
  const authorize = p.authorize.bind(p);
  p.authorize = (args) => {
    const result = authorize(args);
    if ((boundary === 'pending' && result.decision === 'ask') || (boundary === 'after_preview' && args.consume === false && result.decision === 'allowed')) p.setCeiling('sandbox', 'never');
    return result;
  };
  made.host.userRequest({ agent_id: 'agt_a', text: 'go' }); await made.host.drain();
  assert.equal(made.executions(), 0);
});

test('new turns retire old grants and pending cards; restart retires unfinished terminal scopes', async () => {
  const made = await toolHost(); const p = made.host.permissions; p.setStandingMode('sandbox', 'ask');
  const old = p.authorize(input).request; p.resolve(old.id, 'allow_once');
  const pending = p.authorize({ ...input, scope_id: 'old', run_id: 'old' }).request;
  p.setStandingMode('sandbox', 'never');
  made.host.userRequest({ agent_id: 'agt_a', text: 'new' }); await made.host.drain();
  assert.equal(p.doc.read().grants.length, 0);
  assert.equal(p.getRequest(pending.id).resolution, 'retired');
  p.setStandingMode('sandbox', 'ask');
  const run = made.host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'agent', payload: {} });
  run.status = 'running'; made.host.scheduler.checkpoint(run, 'execution_started');
  const stranded = p.authorize({ ...input, scope_id: run.id, run_id: run.id }).request;
  const reopened = reopenHost({ dir: made.dir }).host; reopened.recover();
  assert.equal(reopened.permissions.getRequest(stranded.id).resolution, 'retired');
});
