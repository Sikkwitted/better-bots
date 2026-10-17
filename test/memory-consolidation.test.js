import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryConsolidation, parseJsonObject } from '../src/services/memory-consolidation.js';
import { makeHost } from './helpers.js';

// The scripted model answers the proposer and the verifier separately, told apart
// by their system prompts, so each test decides what each of the two calls says.
function hostWith({ propose, verify }) {
  const { host, adapter, clock } = makeHost();
  adapter.script = (ctx) => {
    const system = ctx.settings.system ?? '';
    if (system.includes('maintain an assistant')) return [{ type: 'text', text: JSON.stringify(propose(ctx)) }];
    if (system.includes('strict fact-checker')) return [{ type: 'text', text: JSON.stringify(verify(ctx)) }];
    return [{ type: 'text', text: 'ok' }];
  };
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const remember = (text, tier = 'log') => host.memory.remember({ scope: 'user', owner_id: 'user', writer_agent_id: 'agt_a', tier, text });
  return { host, adapter, clock, remember };
}

const approveAll = (ctx) => ({ verdicts: [...ctx.messages[0].content.matchAll(/Claim (\d+):/g)].map((m) => ({ claim: Number(m[1]), supported: true })) });

test('a verified summary is committed, cites real memory, and reaches the prompt as settled knowledge', async () => {
  const { host, remember } = hostWith({
    propose: () => ({ statements: [{ text: 'Alex prefers dark mode.', evidence: ['E1'] }, { text: 'Alex wants short replies.', evidence: ['E2'] }] }),
    verify: approveAll,
  });
  const a = remember('Alex said he prefers dark mode in every app');
  const b = remember('Alex asked for short replies, no essays');
  const [result] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.equal(result.outcome, 'committed');
  assert.equal(result.statements, 2);

  const stored = host.consolidation.doc.read().banks['user-user'];
  assert.deepEqual(stored.statements.flatMap((s) => s.evidence).sort(), [a.id, b.id].sort(), 'citations resolve to the saved facts');
  const recall = await host.memory.recall({ agent_id: 'agt_a', scopes: [{ scope: 'user', owner_id: 'user' }], query: '' });
  const known = recall.standing.find((k) => k.scope === 'user');
  assert.equal(known.verified, true);
  assert.match(known.text, /dark mode/);
  assert.equal(host.audit.where((e) => e.type === 'memory.synthesis_committed').length, 1);
});

test('a citation to evidence that was never shown rejects the whole proposal', async () => {
  const { host, remember } = hostWith({
    propose: () => ({ statements: [{ text: 'Alex prefers dark mode.', evidence: ['E1'] }, { text: 'Alex lives in Paris.', evidence: ['E9'] }] }),
    verify: approveAll,
  });
  remember('Alex prefers dark mode'); remember('Alex likes short replies');
  const [result] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.reason, 'unknown_evidence_citation');
  assert.equal(host.consolidation.standing('user', 'user'), null, 'nothing changed');
});

test('a statement without any citation is rejected', async () => {
  const { host, remember } = hostWith({ propose: () => ({ statements: [{ text: 'Alex is great.', evidence: [] }] }), verify: approveAll });
  remember('one'); remember('two');
  const [result] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.equal(result.reason, 'uncited_statement');
});

test('the verifier sees each claim beside its cited evidence; unsupported claims are dropped', async () => {
  let shown = '';
  const { host, remember } = hostWith({
    propose: () => ({ statements: [{ text: 'Alex prefers dark mode.', evidence: ['E1'] }, { text: 'Alex hates all colours.', evidence: ['E1'] }] }),
    verify: (ctx) => { shown = ctx.messages[0].content; return { verdicts: [{ claim: 1, supported: true }, { claim: 2, supported: false, reason: 'not stated' }] }; },
  });
  remember('Alex said he prefers dark mode'); remember('Alex uses a Mac');
  const [result] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.match(shown, /Claim 1: Alex prefers dark mode\.\nCited evidence:\n {2}E1: /);
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.dropped, ['Alex hates all colours.']);
  assert.doesNotMatch(host.consolidation.standing('user', 'user').text, /hates/);
});

test('when the verifier approves nothing, or answers nonsense, the old knowledge stays', async () => {
  let verdict = { verdicts: [] };
  const { host, clock, remember } = hostWith({
    propose: () => ({ statements: [{ text: 'Alex prefers dark mode.', evidence: ['E1'] }] }),
    verify: () => verdict,
  });
  remember('Alex prefers dark mode'); remember('Alex uses a Mac');
  verdict = approveAll({ messages: [{ content: 'Claim 1:' }] });
  await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  const before = host.consolidation.standing('user', 'user').text;

  remember('Alex switched to light mode');
  clock.advance(25 * 3_600_000);
  verdict = { verdicts: [{ claim: 1, supported: false }] };
  const [rejected] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.equal(rejected.reason, 'verification_did_not_approve');
  assert.equal(host.consolidation.standing('user', 'user').text, before);

  remember('another fact');
  clock.advance(25 * 3_600_000);
  verdict = 'not json';
  const [unreadable] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.equal(unreadable.reason, 'verification_unreadable');
  assert.equal(host.consolidation.standing('user', 'user').text, before);
});

test('memory that changes while the run is checking is not summarised from stale evidence', async () => {
  let addDuringVerify = null;
  const { host, remember } = hostWith({
    propose: () => ({ statements: [{ text: 'Alex prefers dark mode.', evidence: ['E1'] }] }),
    verify: (ctx) => { addDuringVerify?.(); return approveAll(ctx); },
  });
  remember('Alex prefers dark mode'); remember('Alex uses a Mac');
  addDuringVerify = () => { addDuringVerify = null; remember('Alex now prefers light mode'); };
  const [result] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.equal(result.outcome, 'requeued');
  assert.equal(host.consolidation.standing('user', 'user'), null);
  assert.equal(host.audit.where((e) => e.type === 'memory.synthesis_requeued').length, 1);
  assert.ok(host.consolidation.doc.read().banks['user-user'].retry_at, 'it will be tried again soon');
});

test('a bank is consolidated at most daily, and only when its evidence changed', async () => {
  let calls = 0;
  const { host, clock, remember } = hostWith({
    propose: () => { calls += 1; return { statements: [{ text: 'Alex prefers dark mode.', evidence: ['E1'] }] }; },
    verify: approveAll,
  });
  const banks = [{ scope: 'user', owner_id: 'user' }];
  remember('only one fact');
  assert.equal((await host.consolidation.run(banks)).length, 0, 'too little evidence to summarise');
  remember('Alex prefers dark mode');
  await host.consolidation.run(banks);
  assert.equal(calls, 1);
  await host.consolidation.run(banks);
  remember('a new fact');
  await host.consolidation.run(banks);
  assert.equal(calls, 1, 'not again within the day');
  clock.advance(25 * 3_600_000);
  await host.consolidation.run(banks);
  assert.equal(calls, 2);
  clock.advance(25 * 3_600_000);
  await host.consolidation.run(banks);
  assert.equal(calls, 2, 'nothing new, nothing spent');
  assert.equal(MemoryConsolidation.key('user', 'user'), 'user-user');
});

test('consolidation uses the host default model, never a bot\'s pinned one, and private memory stays private', async () => {
  let settings;
  const { host } = hostWith({
    propose: (ctx) => { settings = ctx.settings; return { statements: [{ text: 'Ada reviews pull requests.', evidence: ['E1'] }] }; },
    verify: approveAll,
  });
  // An expensive pinned model: housekeeping must not use it.
  host.registry.updateProfile('agt_a', { model: 'claude-opus-5-5', model_provider: 'anthropic' });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  host.memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'I review pull requests every morning' });
  host.memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'I use the review checklist' });
  const results = await host.consolidateMemory({ force: true });
  assert.ok(results.some((r) => r.scope === 'agent' && r.owner_id === 'agt_a' && r.outcome === 'committed'));
  assert.equal(settings.model, undefined);
  assert.equal(settings.provider, undefined);
  assert.equal(settings.reasoning_effort, 'low', 'cheap, and accepted by every provider');
  const bo = await host.memory.recall({ agent_id: 'agt_b', query: '' });
  assert.ok(!bo.standing.some((k) => /pull requests/.test(k.text)));
});

test('a failing model is retried with growing waits, not every ten minutes forever', async () => {
  const { host, clock, remember } = hostWith({ propose: () => { throw new Error('provider down'); }, verify: approveAll });
  remember('one'); remember('two');
  const banks = [{ scope: 'user', owner_id: 'user' }];
  const waits = [];
  for (let i = 0; i < 9; i += 1) {
    const before = clock.now();
    const [r] = await host.consolidation.run(banks);
    assert.equal(r.outcome, 'failed');
    const retry = Date.parse(host.consolidation.doc.read().banks['user-user'].retry_at);
    waits.push((retry - before) / 60_000);
    clock.advance(retry - before);
  }
  assert.deepEqual(waits, [10, 20, 40, 80, 160, 320, 640, 1280, 1440]);
});

test('an unreadable reply is recorded with a short snippet; a bare verdict list is accepted', async () => {
  let reply = 'I think they are all fine';
  const { host, clock, remember } = hostWith({ propose: () => ({ statements: [{ text: 'Alex uses a Mac.', evidence: ['E1'] }] }), verify: () => reply });
  remember('Alex uses a Mac'); remember('Alex likes tea');
  const [bad] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.equal(bad.reason, 'verification_unreadable');
  assert.match(host.audit.where((e) => e.type === 'memory.synthesis_rejected').at(-1).reply, /all fine/);
  remember('Alex drinks tea daily');
  clock.advance(25 * 3_600_000);
  reply = [{ claim: 1, supported: true }];
  const [ok] = await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
  assert.equal(ok.outcome, 'committed');
});

test('model answers wrapped in prose or code fences still parse', () => {
  assert.deepEqual(parseJsonObject('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJsonObject('no json here'), null);
});

test('housekeeping can be pointed at a chosen provider and model', async () => {
  process.env.BETTER_BOTS_CONSOLIDATE_PROVIDER = 'deepseek';
  process.env.BETTER_BOTS_CONSOLIDATE_MODEL = 'deepseek-flash';
  try {
    let settings;
    const { host, remember } = hostWith({ propose: (ctx) => { settings = ctx.settings; return { statements: [{ text: 'Alex uses a Mac.', evidence: ['E1'] }] }; }, verify: approveAll });
    remember('Alex uses a Mac'); remember('Alex likes tea');
    await host.consolidation.run([{ scope: 'user', owner_id: 'user' }]);
    assert.equal(settings.provider, 'deepseek');
    assert.equal(settings.model, 'deepseek-flash');
  } finally {
    delete process.env.BETTER_BOTS_CONSOLIDATE_PROVIDER;
    delete process.env.BETTER_BOTS_CONSOLIDATE_MODEL;
  }
});
