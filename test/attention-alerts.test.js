import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionSnapshot, attentionChanges } from '../web/attention-alerts.js';

const agent = (id, name, run = null) => ({ id, name, active_run: run });
const snap = (state) => attentionSnapshot({ agents: [], approvals: [], blocked: [], ...state });

test('the first snapshot after loading announces nothing', () => {
  const next = snap({ approvals: [{ id: 'apr_1', agent_id: 'a', tool: 'SandboxRunCommand' }] });
  assert.deepEqual(attentionChanges(null, next), []);
});

test('a turn the person asked for announces when it finishes', () => {
  const before = snap({ agents: [agent('a', 'Ada', { id: 'run_1', lane: 'user' })] });
  const after = snap({ agents: [agent('a', 'Ada')] });
  assert.deepEqual(attentionChanges(before, after).map((c) => [c.key, c.title, c.agent_id]), [['finished:run_1', 'Ada finished', 'a']]);
});

test('a background routine finishing is not a summons', () => {
  const before = snap({ agents: [agent('a', 'Ada', { id: 'run_1', lane: 'automation' })] });
  assert.deepEqual(attentionChanges(before, snap({ agents: [agent('a', 'Ada')] })), []);
});

test('the next queued turn starting means the previous one finished', () => {
  const before = snap({ agents: [agent('a', 'Ada', { id: 'run_1', lane: 'user' })] });
  const after = snap({ agents: [agent('a', 'Ada', { id: 'run_2', lane: 'user' })] });
  assert.deepEqual(attentionChanges(before, after).map((c) => c.key), ['finished:run_1']);
  assert.deepEqual(attentionChanges(after, after), []);
});

test('a new approval card or stuck card is announced once, with what it is about', () => {
  const agents = [agent('a', 'Ada', { id: 'run_1', lane: 'user' })];
  const before = snap({ agents });
  const after = snap({
    agents,
    approvals: [{ id: 'apr_1', agent_id: 'a', action: 'sandbox.run_command' }],
    blocked: [{ id: 'blk_1', agent_id: 'a', reason: 'captcha', detail: 'A CAPTCHA is in the way' }, { id: 'blk_0', agent_id: 'a', detail: 'old', resolved_at: '2026-10-01T00:00:00Z' }],
  });
  const changes = attentionChanges(before, after, { describeApproval: (r) => `Ada wants to ${r.action}` });
  assert.deepEqual(changes.map((c) => [c.key, c.title, c.body]), [
    ['approval:apr_1', 'Ada needs your approval', 'Ada wants to sandbox.run_command'],
    ['blocked:blk_1', 'Ada is stuck', 'A CAPTCHA is in the way'],
  ]);
  assert.deepEqual(attentionChanges(after, after), []);
  assert.equal(after.attention, 2, 'the Dock badge counts what is waiting, not resolved history');
});
