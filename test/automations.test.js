import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, say } from './helpers.js';
import { MIN_AUTOMATION_INTERVAL_MS } from '../src/host.js';

// Work that must happen later or on a schedule is an automation wake: the
// automation lane is woken by a schedule or rule. Runs are cancellable.

function setup() {
  const made = makeHost({ script: () => [say('done')] });
  made.host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  return made;
}

test('a schedule fires on every interval and never replays windows it missed', async () => {
  const { host, clock } = setup();
  const start = clock.now();
  const item = host.scheduleAutomation({ agent_id: 'agt_a', name: 'pulse', text: 'check in', due_at: new Date(start + 60_000).toISOString(), every_ms: 60_000 });
  assert.equal(host.tickAutomations().length, 0);
  clock.advance(60_000);
  assert.equal(host.tickAutomations().length, 1);
  await host.drain();
  // The host was "down" for four windows: exactly one wake, and the next due time is in the future.
  clock.advance(4 * 60_000 + 5_000);
  assert.equal(host.tickAutomations().length, 1);
  const stored = host.listAutomations().find((a) => a.id === item.id);
  assert.equal(stored.fires, 2);
  assert.equal(stored.fired, false);
  assert.ok(Date.parse(stored.due_at) > clock.now());
  assert.equal(host.audit.where((e) => e.type === 'automation.fired').length, 2);
});

test('a one-shot automation still fires exactly once', () => {
  const { host, clock } = setup();
  host.scheduleAutomation({ agent_id: 'agt_a', name: 'once', text: 'go' });
  assert.equal(host.tickAutomations().length, 1);
  clock.advance(120_000);
  assert.equal(host.tickAutomations().length, 0);
  assert.equal(host.listAutomations()[0].fired, true);
});

test('intervals under a minute are refused and a schedule can be cancelled', () => {
  const { host, clock } = setup();
  assert.throws(() => host.scheduleAutomation({ agent_id: 'agt_a', name: 'hot', text: 'x', every_ms: MIN_AUTOMATION_INTERVAL_MS - 1 }), /at least/);
  const item = host.scheduleAutomation({ agent_id: 'agt_a', name: 'pulse', text: 'x', every_ms: 60_000 });
  host.cancelAutomation(item.id);
  clock.advance(120_000);
  assert.equal(host.tickAutomations().length, 0);
  assert.deepEqual(host.listAutomations(), []);
  assert.ok(host.audit.where((e) => e.type === 'automation.cancelled').length === 1);
  assert.equal(host.cancelAutomation(item.id).cancellation.requested, true);
  assert.throws(() => host.cancelAutomation('unknown'), /unknown automation/);
});

test('invalid explicit due dates are rejected before persistence or dispatch', () => {
  const { host } = setup();
  for (const due_at of ['', 'not a date', 123, false, {}, []]) {
    assert.throws(() => host.scheduleAutomation({ agent_id: 'agt_a', text: 'check', due_at }), /due_at/);
  }
  assert.deepEqual(host.listAutomations(), []);
  assert.deepEqual(host.tickAutomations(), []);
});

test('blank or non-string automation prompts are rejected before persistence', () => {
  const { host } = setup();
  for (const text of [undefined, null, '', '  \n ', 42, {}, ['go']]) {
    assert.throws(() => host.scheduleAutomation({ agent_id: 'agt_a', text }), /prompt|text/);
  }
  assert.deepEqual(host.listAutomations(), []);
});

test('date validation retains omitted/null starts, past starts, and cron ignoring due_at', () => {
  const { host, clock } = setup();
  for (const due_at of [undefined, null]) {
    const item = host.scheduleAutomation({ agent_id: 'agt_a', text: 'go', due_at });
    assert.equal(item.due_at, clock.iso());
  }
  const past = '2020-01-01T00:00:00Z';
  assert.equal(host.scheduleAutomation({ agent_id: 'agt_a', text: 'go', due_at: past }).due_at, past);
  const cron = host.scheduleAutomation({ agent_id: 'agt_a', text: 'go', cron: '0 7 * * *', due_at: 'ignored' });
  assert.ok(Date.parse(cron.due_at) > clock.now());
});
