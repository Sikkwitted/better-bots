import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_AT, COMPACT_SYSTEM, contextWindowFor, needsCompaction, splitForCompaction, applyCompaction, previousSummary, DEFAULT_CONTEXT_WINDOW } from '../src/context-compaction.js';
import { makeHost, say, call } from './helpers.js';

const BIG = 'x'.repeat(3_000);

// A long task: ten distinct steps, each returning ~3 KB, on a model whose window
// is 6,000 tokens. Without compaction the prompt grows past the window.
function longTask({ summary = () => [say('SUMMARY: read files 1-6, all fine; next read 7-10.')] } = {}) {
  const { host, adapter } = makeHost();
  host.tools.register({ name: 'ReadChunk', description: 'fixture', side_effect: 'none', permission: null,
    input_schema: { type: 'object' }, handler: ({ n }) => ({ ok: true, n, text: BIG }) });
  let step = 0;
  adapter.script = (ctx) => {
    if (ctx.settings.system === COMPACT_SYSTEM) return summary(ctx);
    step += 1;
    return step <= 10 ? [call('ReadChunk', { n: step })] : [say('all ten read')];
  };
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada', context_window: 6_000 } });
  return { host, adapter };
}

test('a turn that reaches 70% of the context window is compacted and keeps going', async () => {
  const { host, adapter } = longTask();
  const run = host.userRequest({ agent_id: 'agt_a', text: 'read all ten chunks' });
  await host.drain();

  assert.equal(host.explain(run.id).result.status, 'completed');
  assert.equal(host.explain(run.id).result.text, 'all ten read');
  const compactions = host.audit.where((e) => e.type === 'run.compacted');
  assert.ok(compactions.length >= 1);
  assert.ok(compactions[0].tokens_before >= 6_000 * COMPACT_AT);

  // Every prompt the agent saw stayed under the window, and the summary rode along.
  const turns = adapter.calls.filter((c) => c.settings.system !== COMPACT_SYSTEM);
  for (const c of turns) assert.ok(JSON.stringify(c.messages).length / 4 < 6_000, 'stayed under the window');
  const after = turns.find((c) => JSON.stringify(c.messages).includes('SUMMARY: read files 1-6'));
  assert.ok(after, 'the summary replaced the older steps');
  assert.equal(after.messages.filter((m) => m.role === 'assistant').length, 2, 'the latest two steps are kept as they were');
  assert.ok(host.transcripts.all('agent', 'agt_a').some((e) => e.kind === 'system_note' && /Compacted \d+ earlier steps?/.test(e.text)));
});

test('below 70% of the window nothing is compacted and no summary is requested', async () => {
  const { host } = longTask({ summary: () => { throw new Error('summariser down'); } });
  host.registry.updateProfile('agt_a', { context_window: 60_000 });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'read' });
  await host.drain();
  assert.equal(host.explain(run.id).result.status, 'completed');
  assert.equal(host.audit.where((e) => e.type === 'run.compacted').length, 0);
  assert.equal(host.audit.where((e) => e.type === 'run.compaction_failed').length, 0);
});

test('a failed summary is recorded and the turn still finishes', async () => {
  const { host } = longTask({ summary: () => { throw new Error('summariser down'); } });
  const run = host.userRequest({ agent_id: 'agt_a', text: 'read' });
  await host.drain();
  assert.equal(host.explain(run.id).result.status, 'completed');
  assert.ok(host.audit.where((e) => e.type === 'run.compaction_failed').length >= 1);
});

test('the threshold is 70%, the provider\'s own count wins when it is higher, and the window is configurable', () => {
  assert.equal(COMPACT_AT, 0.7);
  assert.equal(needsCompaction({ reportedTokens: 69_999, system: '', messages: [], window: 100_000 }).due, false);
  assert.equal(needsCompaction({ reportedTokens: 70_000, system: '', messages: [], window: 100_000 }).due, true);
  assert.equal(needsCompaction({ reportedTokens: 0, system: 'x'.repeat(280_000), messages: [], window: 100_000 }).due, true);
  assert.equal(contextWindowFor({ context_window: 200_000 }, {}), 200_000);
  assert.equal(contextWindowFor({}, { BETTER_BOTS_CONTEXT_WINDOW: '400000' }), 400_000);
  assert.equal(contextWindowFor({}, {}), DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextWindowFor({ context_window: 'junk' }, {}), DEFAULT_CONTEXT_WINDOW);
});

test('compacting again replaces the earlier summary instead of stacking them', () => {
  const step = (n) => [{ role: 'assistant', content: '', tool_calls: [{ id: `c${n}`, name: 'T', input: { n } }] }, { role: 'tool_results', results: [{ call_id: `c${n}`, name: 'T', output: { n } }] }];
  const base = [{ role: 'user', content: 'do it' }];
  const messages = [...base, ...step(1), ...step(2), ...step(3)];
  const split = splitForCompaction(messages, 1);
  assert.equal(split.steps, 1);
  const once = applyCompaction(split, 'first summary');
  const twice = applyCompaction(splitForCompaction([...once, ...step(4), ...step(5)], 1), 'second summary');
  assert.equal(previousSummary(twice[0].content), 'second summary');
  assert.equal((twice[0].content.match(/compacted="true"/g) ?? []).length, 1);
  assert.ok(twice[0].content.startsWith('do it'));
  assert.equal(splitForCompaction([...base, ...step(1), ...step(2)], 1), null, 'two steps or fewer: nothing to compact');
});
