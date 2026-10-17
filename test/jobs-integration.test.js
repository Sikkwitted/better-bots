import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { withApprovalStatus } from '../web/chat-presentation.js';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
function refreshHarness() {
  const requests = [], failures = [], calls = [];
  const snapshots = [];
  const state = { agents: [], rooms: [], approvals: [], automations: [], selectedKind: 'agent', selected: null };
  const jobs = { revision: 0, items: [], update(data, expected) { if (expected !== this.revision) return false; this.revision++; this.items = data.automations; snapshots.push(data); return true; } };
  const context = vm.createContext({ withApprovalStatus, state, jobs, api: (...args) => { calls.push(args); return new Promise((resolve, reject) => { requests.push(resolve); failures.push(reject); }); }, $: () => ({}), clearTimeout() {}, setTimeout() {}, renderAgents() {}, renderRooms() {}, renderApprovals() {}, renderPermissions() {}, renderHead() {}, renderComposer() {} });
  vm.runInContext(source.slice(source.indexOf('// ------------------------------------------------------------------- state ---'), source.indexOf('function agentById')), context);
  const data = (name) => ({ agents: [{ id: 'a', name }], rooms: [], pending_approvals: [], automations: [{ id: name }], live: false });
  return { requests, failures, calls, snapshots, state, jobs, data, context, refresh: () => vm.runInContext('refresh()', context) };
}

test('state refresh publishes automations to Jobs without another execution request', async () => {
  const h = refreshHarness(); const pending = h.refresh(); h.requests[0](h.data('fresh')); await pending;
  assert.equal(h.state.automations[0]?.id, 'fresh');
  assert.equal(h.snapshots.length, 1);
});

test('out-of-order state replies cannot restore stale jobs or agents', async () => {
  const h = refreshHarness(); const first = h.refresh(); const second = h.refresh();
  h.requests[1](h.data('new')); await second; h.requests[0](h.data('old')); await first;
  assert.equal(h.state.agents[0].name, 'new'); assert.equal(h.state.automations[0]?.id, 'new');
});

test('a state request started before a Jobs mutation cannot resurrect the removed schedule', async () => {
  const h = refreshHarness(); const pending = h.refresh(); h.jobs.revision++; h.jobs.items = [];
  h.requests[0](h.data('removed')); await new Promise(setImmediate);
  assert.equal(h.snapshots.length, 0); assert.deepEqual(h.state.automations, []);
  h.requests[1]?.({ ...h.data('current'), automations: [] }); await pending;
  assert.deepEqual(h.state.automations, []);
});

test('the final SSE state response rejected after a mutation acknowledgement is reconciled on an idle host', async () => {
  const h = refreshHarness();
  h.jobs.revision++; // Mutation starts before the SSE-triggered GET.
  const pending = h.refresh();
  const other = { id: 'other-job', agent_id: 'b', fires: 7 };
  const snapshot = { ...h.data('Bea updated'), automations: [{ id: 'removed' }, other] };
  h.jobs.revision++; h.jobs.items = []; // DELETE acknowledgement invalidates that GET.
  h.requests[0](snapshot); await new Promise(setImmediate);
  assert.deepEqual(h.state.automations, [], 'the rejected snapshot never restores the deleted job');
  h.requests[1]?.({ ...snapshot, automations: [other] }); await pending;
  assert.deepEqual(h.state.automations, [other], 'fresh read captures unrelated agent scheduling changes without another SSE event');
  assert.equal(h.state.agents[0].name, 'Bea updated');
  assert.ok(h.calls.every(([method, route]) => method === 'GET' && route === '/api/state'));
});

test('overlapping rejected state replies coalesce to one fresh read, which cannot override a newer state', async () => {
  const h = refreshHarness(); const first = h.refresh(); const second = h.refresh(); const latest = h.refresh();
  h.jobs.revision++; h.jobs.items = [];
  h.requests[0](h.data('oldest')); h.requests[1](h.data('older')); h.requests[2](h.data('removed'));
  await Promise.all([first, second]); await new Promise(setImmediate);
  assert.equal(h.requests.length, 4, 'only the latest rejected response starts reconciliation');
  const newer = h.refresh(); h.requests[4](h.data('newest')); await newer;
  h.requests[3](h.data('late-reconciliation')); await latest;
  assert.equal(h.state.automations[0].id, 'newest'); assert.equal(h.state.agents[0].name, 'newest');
});

test('a reconciliation invalidated again is bounded rather than polling indefinitely', async () => {
  const h = refreshHarness(); const pending = h.refresh();
  h.jobs.revision++; h.requests[0](h.data('removed')); await new Promise(setImmediate);
  h.jobs.revision++; h.requests[1]?.(h.data('also-stale')); await pending;
  assert.deepEqual(h.state.automations, []); assert.equal(h.snapshots.length, 0);
  assert.equal(h.requests.length, 2, 'one follow-up at most per latest state refresh');
  const next = h.refresh(); h.requests.at(-1)(h.data('later-event')); await next;
  assert.equal(h.state.automations[0].id, 'later-event');
});

test('a failed reconciliation preserves acknowledged Jobs state and does not loop', async () => {
  const h = refreshHarness(); const pending = h.refresh();
  h.jobs.revision++; h.requests[0](h.data('removed')); await new Promise(setImmediate);
  const rejected = assert.rejects(pending, /Offline/);
  h.failures[1]?.(new Error('Offline')); await rejected;
  assert.deepEqual(h.state.automations, []); assert.equal(h.requests.length, 2);
});

test('automation SSE events refresh the Jobs snapshot without running a schedule', async () => {
  const h = refreshHarness(); let tick;
  Object.assign(h.context, { EventSource: function () {}, pushActivity() {}, loadTranscript() {}, setTimeout(fn) { tick = fn; } });
  vm.runInContext(source.slice(source.indexOf("const stream = new EventSource"), source.indexOf('// EventSource reconnects')), h.context);
  for (const type of ['automation.scheduled', 'automation.fired', 'automation.cancelled']) {
    vm.runInContext(`stream.onmessage({ data: JSON.stringify({ type: '${type}' }) })`, h.context);
    const pending = tick(); h.requests.at(-1)(h.data(type)); await pending;
    assert.equal(h.state.automations[0].id, type);
  }
});

test('both Jobs entry points share one panel and restore the original three-pane navigation', () => {
  const nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, { hidden: false, setAttribute(k, v) { this[k] = v; } }); return nodes.get(id); };
  let options; const opened = []; const panes = []; let dirty = false; let answer = true;
  const context = vm.createContext({ agentSettingsDirty: () => dirty, confirm: () => answer, $, state: { agents: [], selectedKind: 'agent', selected: 'a' }, api() {}, createJobsPanel(config) { options = config; return { open: (...args) => opened.push(args) }; }, closeSettings() {}, closeMemory() {}, renderHead() {}, showPane: (name) => panes.push(name) });
  vm.runInContext(source.slice(source.indexOf('// -------------------------------------------------------------------- jobs ---'), source.indexOf('// ------------------------------------------------------------------- state ---')), context);
  $('#all-jobs').onclick({ currentTarget: $('#all-jobs') }); $('#open-jobs').onclick({ currentTarget: $('#open-jobs') });
  assert.deepEqual(opened.map(([id]) => id), [null, 'a']);
  // Unsaved bot settings are never dropped silently when opening Jobs.
  dirty = true; answer = false;
  $('#all-jobs').onclick({ currentTarget: $('#all-jobs') }); $('#open-jobs').onclick({ currentTarget: $('#open-jobs') });
  assert.equal(opened.length, 2, 'declining the discard prompt keeps the settings open');
  dirty = false;
  options.onVisibilityChange(true, null);
  assert.equal($('#transcript').hidden, true); assert.equal($('#composer').hidden, true); assert.equal(panes.at(-1), 'chat');
  options.onVisibilityChange(false, null, true);
  assert.equal($('#transcript').hidden, false); assert.equal($('#all-jobs')['aria-expanded'], 'false'); assert.equal(panes.at(-1), 'agents');
});
