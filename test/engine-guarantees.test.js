import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, say, call, tmpDir } from './helpers.js';
import { fixedClock } from '../src/core/clock.js';
import { LANES } from '../src/services/run-scheduler.js';
import { ToolRegistry, validateInput } from '../src/tools/registry.js';

// Engine guarantees the other test files do not cover: run lanes, tool policy,
// provider failures, restricted profiles and the like.

test('the four run lanes are distinguishable and ordered', async () => {
  const order = [];
  const { host } = makeHost({ script: (ctx) => { order.push(ctx.payload.kind); return [say('ok')]; } });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });

  // Enqueue in deliberately reversed priority order.
  host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'background', payload: { kind: 'background' } });
  host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'automation', payload: { kind: 'automation_task' } });
  host.deliverPeerMessage({ sender_id: 'agt_b', target_id: 'agt_a', text: 'peer note' });
  host.userRequest({ agent_id: 'agt_a', text: 'user turn' });

  await host.drain();
  assert.deepEqual(order.slice(0, 4), ['user_request', 'agent_wake', 'automation_task', 'background']);
  assert.deepEqual(LANES, ['user', 'agent', 'automation', 'background']);
});

test('an automation wakes on a schedule rather than masquerading as a peer', async () => {
  const { host, clock } = makeHost({ script: () => [say('swept')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });

  const due = new Date(clock.now() + 60_000).toISOString();
  host.scheduleAutomation({ agent_id: 'agt_a', name: 'nightly-sweep', text: 'sweep the queue', due_at: due });
  assert.equal(host.tickAutomations().length, 0, 'nothing fires before it is due');

  clock.advance(61_000);
  const fired = host.tickAutomations();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].lane, 'automation');

  await host.drain();
  const note = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'agent_text');
  assert.equal(note.text, 'swept');
  assert.equal(host.tickAutomations().length, 0, 'an automation fires once');
});

test('a host wake never pretends the user typed it', async () => {
  const seen = [];
  const { host } = makeHost({ script: (ctx) => { seen.push(ctx); return [say('ok')]; } });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });

  host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'the handoff', priority: true, priority_reason: 'stop' });
  await host.drain();

  const wake = seen.find((s) => s.payload.kind === 'agent_wake');
  const turn = wake.messages.at(-1).content;
  assert.match(turn, /<host_wake>/);
  assert.match(turn, /This is not the user speaking/);
  assert.match(turn, /agent message from agt_a/);
  assert.match(turn, /PRIORITY traffic, reason: stop/);
});

test('tool inputs are typed and validated before any side effect', async () => {
  const { host } = makeHost({ script: () => [call('SandboxWriteFile', { path: 'a.txt' })] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.userRequest({ agent_id: 'agt_a', text: 'write badly' });
  await host.drain();

  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result');
  assert.equal(result, undefined, 'nothing ran');
  assert.equal(host.audit.where((e) => e.type === 'tool.invalid_input').length, 1);

  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'string', enum: ['x', 'y'] } } };
  assert.equal(validateInput(schema, { a: 'ok' }).ok, true);
  assert.equal(validateInput(schema, {}).ok, false);
  assert.equal(validateInput(schema, { a: 'ok', b: 'nope' }).ok, false);
  assert.equal(validateInput(schema, { a: 'ok', c: 'z' }).ok, false);
  assert.equal(validateInput(schema, { a: 'ok', surprise: 1 }).ok, false);
});

test('every tool declares the six things a tool must declare', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  for (const tool of host.tools.tools.values()) {
    assert.ok(tool.name, 'stable name');
    assert.ok(tool.input_schema?.type === 'object', 'typed input schema');
    assert.ok(tool.description, 'description');
    assert.ok(tool.side_effect, 'side-effect description');
    assert.ok('permission' in tool, 'permission policy');
    assert.equal(typeof tool.handler, 'function', 'result format via handler');
  }
});

test('deleting an agent requires explicit user confirmation', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  assert.throws(() => host.registry.delete('agt_a'), /requires confirm/);
  assert.throws(() => host.registry.delete('agt_a', { confirm: true, actor: 'agent' }), /only the user/);
  assert.equal(host.registry.delete('agt_a', { confirm: true, actor: 'user' }).deleted, true);
  assert.equal(host.registry.list().length, 0);
});

test('the teammate directory exposes names and roles, never transcripts', async () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada', role: 'researcher' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo', role: 'builder' } });
  host.transcripts.append('agent', 'agt_b', { kind: 'user_message', text: 'bo-secret' });

  const directory = host.registry.visibleTo('agt_a');
  assert.deepEqual(directory, [{ id: 'agt_b', name: 'Bo', role: 'builder' }]);
  assert.ok(!JSON.stringify(directory).includes('bo-secret'));
});

test('the user can see what happened and why', async () => {
  const { host } = makeHost({ script: () => [call('SandboxWriteFile', { path: 'x.txt', content: 'hi', expected_revision: 'missing', operation_id: 'initial-write' }), say('wrote it')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'do the thing' });
  await host.drain();

  const explanation = host.explain(run.id);
  assert.equal(explanation.run.status, 'completed');
  assert.equal(explanation.run.lane, 'user');
  assert.ok(explanation.audit.some((e) => e.type === 'tool.executed' && e.name === 'SandboxWriteFile'));
  assert.match(explanation.result.text, /^wrote it/);
  assert.deepEqual(explanation.result.tools, [{ name: 'SandboxWriteFile', decision: 'allowed', target: 'x.txt' }]);

  const status = host.status();
  assert.equal(status.agents[0].name, 'Ada');
  assert.equal(status.standing_permissions.local, 'ask');
  assert.match(status.computer.warning, /not imply a private file system/);
  assert.throws(() => host.explain('run_nope'), /unknown run/);
});

test('explain joins exact approval requests, including legacy resolutions, and shows execution outcomes', async () => {
  const { host } = makeHost({ script: () => [call('ApprovalFixture', {})] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.approval_mode = 'wait';
  let fail = false, resolution = 'allow_once', legacy = false, effects = 0;
  host.tools.register({ name: 'ApprovalFixture', description: 'Local test fixture', side_effect: 'fixture only',
    input_schema: { type: 'object' }, permission: { action: 'local.write_file', target: () => '/fixture/same-target' },
    handler: () => { effects++; if (fail) throw new Error('fixture failed after approval'); return { ok: true }; } });
  const record = host.audit.record.bind(host.audit);
  host.audit.record = (type, data) => {
    // Emit the pre-fix durable event shape while still using the actual resolver.
    if (legacy && type === 'permission.resolved') {
      const { run_id, scope_id, call_id, tool, ...old } = data;
      return record(type, old);
    }
    return record(type, data);
  };
  const authorize = host.permissions.authorize.bind(host.permissions);
  host.permissions.authorize = args => {
    const decision = authorize(args);
    if (decision.decision === 'ask') assert.equal(host.permissions.resolve(decision.request.id, resolution).ok, true);
    return decision;
  };
  const runs = [];
  for (const scenario of [{ resolution: 'allow_once' }, { resolution: 'deny', legacy: true }, { resolution: 'allow_once', fail: true }]) {
    ({ resolution, legacy = false, fail = false } = scenario);
    const run = host.userRequest({ agent_id: 'agt_a', text: 'same action' });
    runs.push(run); await host.drain();
  }
  assert.equal(effects, 2, 'denial must prevent execution');
  const all = host.audit.all();
  for (const [index, run] of runs.entries()) {
    const explanation = host.explain(run.id);
    const asked = explanation.audit.find(e => e.type === 'permission.asked');
    const resolved = explanation.audit.find(e => e.type === 'permission.resolved');
    assert.ok(asked && resolved);
    assert.equal(resolved.request_id, asked.request_id);
    assert.equal(resolved.run_id, run.id);
    assert.equal(resolved.actor, 'user');
    assert.equal(resolved.resolution, index === 1 ? 'deny' : 'allow_once');
    assert.equal(resolved.action, 'local.write_file');
    assert.equal(resolved.target, '/fixture/same-target');
    assert.equal(resolved.call_id, 'tc_ApprovalFixture');
    assert.equal(resolved.tool, 'ApprovalFixture');
    assert.ok(explanation.audit.indexOf(asked) < explanation.audit.indexOf(resolved));
    assert.equal(explanation.audit.filter(e => e.type === 'permission.resolved').length, 1);
    assert.ok(explanation.audit.every(e => !e.request_id || e.request_id === asked.request_id));
    const persisted = all.find(e => e.id === resolved.id);
    assert.equal(persisted.run_id, index === 1 ? undefined : run.id, 'legacy enrichment is read-only');
    const executed = explanation.audit.find(e => e.type === 'tool.executed');
    const failed = explanation.audit.find(e => e.type === 'tool.failed');
    if (index === 0) assert.equal(executed.result.ok, true);
    if (index === 1) { assert.equal(executed, undefined); assert.equal(failed, undefined); }
    if (index === 2) { assert.equal(failed.result.ok, false); assert.match(failed.error, /fixture failed/); }
  }
});

test('an interrupted run records why it stopped and whether output is reusable', async () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });

  for (const [reason, expected] of [['stop', 'abandon'], ['supersede', 'abandon'], ['safety', 'abandon'], ['time_critical', 'abandon']]) {
    const run = host.scheduler.enqueue({ agent_id: 'agt_b', lane: 'background', payload: { kind: 'bg' } });
    host.scheduler.active.set('agt_b', { run: { ...run, lane: 'background' }, signal: { abort() {} } });
    const outcome = host.scheduler.interrupt('agt_b', { reason });
    assert.equal(outcome.interrupted, true);
    assert.equal(outcome.resume_policy, expected, `${reason} -> ${expected}`);
    host.scheduler.active.delete('agt_b');
  }
});

test('a failed run is still visible and explainable', async () => {
  const { host } = makeHost({ script: () => { throw new Error('provider exploded'); } });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'hi' });
  await host.drain();

  const explanation = host.explain(run.id);
  assert.equal(explanation.run.status, 'failed');
  assert.equal(explanation.result.status, 'failed');
  assert.match(explanation.result.error, /provider exploded/);
  assert.ok(host.audit.where((e) => e.type === 'run.model_failed').length === 1);
  // And in the chat itself, where the person is looking — not only in the audit.
  const shown = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'run_failed');
  assert.match(shown?.error ?? '', /provider exploded/);
});

// `tools: policy.allowed_tools(agent.id)`: a tool the user has
// set to `never` is absent from the prompt, not offered and then refused.
test('tools whose zone is set to never are not shown to the model at all', async () => {
  const { host } = makeHost();
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  const names = () => host.tools.describeFor(host.registry.get(agent.id)).map((t) => t.name);
  assert.ok(names().includes('LocalReadFile'), 'ask-mode tools are offered');
  host.permissions.setStandingMode('local', 'never');
  assert.ok(!names().some((n) => n.startsWith('Local')), 'never-mode tools disappear');
  assert.ok(names().includes('SandboxReadFile') && names().includes('Remember'), 'other zones and ungated tools stay');
  host.permissions.setStandingMode('local', 'ask');
  assert.ok(names().includes('LocalReadFile'), 'and come back when the user relents');
});

test('saved restricted profiles still get memory without gaining other tools', () => {
  const { host } = makeHost();
  const agent = host.registry.create({ profile: { name: 'Restricted', allowed_tools: ['ReadReportStatus'] } });
  const names = host.tools.describeFor(host.registry.get(agent.id)).map((tool) => tool.name);
  assert.ok(names.includes('Remember'));
  assert.ok(names.includes('Recall'));
  assert.ok(!names.includes('SendToAgent'));
  const newDeskAgent = host.registry.create({ profile: { name: 'New desk bot', desk: 'New Desk', allowed_tools: [] } });
  const newDeskTools = host.tools.describeFor(host.registry.get(newDeskAgent.id)).map((tool) => tool.name);
  assert.deepEqual(newDeskTools.sort(), ['Recall', 'Remember']);
  assert.equal(host.tools.allowedFor(host.tools.get('SendToAgent'), host.registry.get(agent.id)), false);
  for (const name of ['Remember', 'Recall']) {
    const builtIn = host.tools.get(name);
    const replacement = { ...builtIn, integration: 'untrusted', handler: () => ({ ok: true }) };
    assert.equal(host.tools.allowedFor(replacement, host.registry.get(agent.id)), false);
    assert.throws(() => host.tools.register(replacement), /reserved for the built-in memory tool/);
    assert.equal(host.tools.unregister(name), false);
    assert.equal(host.tools.get(name), builtIn);
    assert.throws(() => new ToolRegistry({ audit: host.audit }).register(replacement), /reserved for the built-in memory tool/);
  }
});

test('a turn that runs out of steps mid-work is continued, not declared done', async () => {
  const { Host, MAX_MODEL_STEPS, MAX_CONTINUATIONS } = await import('../src/host.js');
  const { ScriptedAdapter } = await import('../src/model/scripted-adapter.js');
  // A model that never stops calling a harmless tool — makeHost's helper would
  // say "done" after the first step, which is exactly the case this is not about.
  let steps = 0;
  const adapter = new ScriptedAdapter(() => { steps += 1; return [call('Remember', { text: `fact ${steps}`, tier: 'note' })]; });
  const host = new Host({ dir: tmpDir('steps'), adapter, clock: fixedClock(), window_count: 3 });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.userRequest({ agent_id: 'agt_a', text: 'build the thing' });
  await host.drain();
  const notes = host.transcripts.all('agent', 'agt_a').filter((e) => e.kind === 'system_note');
  assert.ok(notes.some((e) => /Paused at the \d+-step budget/.test(e.text)), 'the pause is visible in the chat');
  assert.ok(host.audit.where((e) => e.type === 'run.continued').length >= 1, 'a continuation run was queued');
  assert.ok(host.audit.where((e) => e.type === 'run.continuation_exhausted').length === 1, 'and it is bounded');
  assert.ok(steps <= MAX_MODEL_STEPS * (MAX_CONTINUATIONS + 1) + 1, `steps ${steps} stayed within the cap`);
});
