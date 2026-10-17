import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

async function jobsModule() {
  assert.ok(existsSync(new URL('../web/jobs.js', import.meta.url)), 'Jobs behavior module exists');
  return import('../web/jobs.js');
}
const now = () => Date.parse('2030-01-01T00:00:00Z');
const agents = [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }];
const job = { id: 'aut_1', agent_id: 'a', name: 'Check', text: '<img src=x onerror=alert(1)>', due_at: '2030-01-02T12:00:00Z', every_ms: null, cron: null, timezone: null, fired: false, fires: 0 };
const values = { agent_id: 'a', name: ' Check ', text: ' report ', schedule: 'once', due_at: '2030-01-02T12:00', minutes: '1', cron: '0 7 * * 1-5', timezone: 'America/Chicago', consent: true };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Only the DOM boundary is doubled; the actual panel handlers, validation,
// rendering, and request ordering run unchanged. innerHTML is forbidden.
class Node {
  constructor(doc, tag = 'div') { this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.text = ''; this.isConnected = true; this.listeners = {}; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); if (typeof node === 'object') node.parentNode = this; } }
  replaceChildren(...nodes) { if (this.ownerDocument.activeElement !== this && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; this.children = []; this.append(...nodes); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((n) => typeof n === 'string' ? n : n.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  set disabled(value) { this._disabled = value; if (value && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  get disabled() { return this._disabled; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.children.some((n) => typeof n === 'object' && n.contains(node)); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  async emit(type, detail = {}) { const event = { preventDefault() {}, target: this, ...detail }; return (this.listeners[type] ?? this[`on${type}`])?.(event); }
  querySelector(sel) { return this.ownerDocument.nodes[sel.slice(1)]; }
  querySelectorAll(sel) { return this.children.flatMap((n) => typeof n === 'object' ? [...(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(n.tagName) && sel.includes(n.tagName.toLowerCase()) ? [n] : []), ...n.querySelectorAll(sel)] : []); }
}
async function setup({ api = async () => ({ automations: [job] }), confirm = () => true } = {}) {
  const { createJobsPanel } = await jobsModule();
  const doc = { nodes: {}, activeElement: null, createElement(tag) { return new Node(this, tag); } };
  doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  const make = (id, tag = 'div') => (doc.nodes[id] = doc.createElement(tag));
  const panel = make('jobs-panel'); panel.hidden = true;
  for (const id of ['jobs-heading', 'jobs-list', 'jobs-status', 'jobs-error', 'jobs-form-error', 'jobs-once-fields', 'jobs-interval-fields', 'jobs-cron-fields']) panel.append(make(id));
  for (const id of ['jobs-close', 'jobs-new', 'jobs-refresh', 'jobs-cancel', 'jobs-save']) panel.append(make(id, 'button'));
  const form = make('jobs-form', 'form'); form.hidden = true; panel.append(form);
  form.elements = {};
  for (const [key, value] of Object.entries(values)) {
    const node = make(`job-${key}`, key === 'schedule' || key === 'agent_id' ? 'select' : 'input');
    node.value = typeof value === 'string' ? value : ''; node.checked = key === 'consent' && value;
    form.elements[key] = node; form.append(node);
  }
  form.reset = () => { for (const node of Object.values(form.elements)) { node.value = ''; node.checked = false; } form.elements.schedule.value = 'once'; form.elements.timezone.value = 'UTC'; form.elements.minutes.value = '1'; };
  const calls = [], visibility = [];
  const controller = createJobsPanel({ panel, api: (...args) => { calls.push(args); return api(...args); }, getAgents: () => agents, confirm, now, onVisibilityChange: (...args) => visibility.push(args) });
  const fill = () => { for (const [key, value] of Object.entries(values)) { form.elements[key].value = value; if (key === 'consent') form.elements[key].checked = value; } };
  return { controller, doc, panel, form, calls, visibility, fill, n: (id) => doc.nodes[id] };
}

test('creation requires paid-work opt-in, a real agent, and a nonblank prompt', async () => {
  const { jobPayload } = await jobsModule();
  assert.throws(() => jobPayload({ ...values, consent: false }, agents, now()), /paid|consent|confirm/i);
  assert.throws(() => jobPayload({ ...values, agent_id: 'missing' }, agents, now()), /bot/i);
  for (const text of ['', '  ', null, 42]) assert.throws(() => jobPayload({ ...values, text }, agents, now()), /prompt/i);
});

test('once and interval creation require explicit future UTC starts, never an accidental now', async () => {
  const { jobPayload } = await jobsModule();
  assert.deepEqual(jobPayload(values, agents, now()), { agent_id: 'a', name: 'Check', text: 'report', due_at: '2030-01-02T12:00:00.000Z' });
  for (const schedule of ['once', 'interval']) {
    for (const due_at of ['', 'bad', '2029-12-31T12:00', '2030-02-30T12:00']) assert.throws(() => jobPayload({ ...values, schedule, due_at }, agents, now()), /future|date|start/i);
  }
  assert.equal(jobPayload({ ...values, schedule: 'interval' }, agents, now()).every_ms, 60_000);
  for (const minutes of ['0.5', '-1', '', 'Infinity']) assert.throws(() => jobPayload({ ...values, schedule: 'interval', minutes }, agents, now()), /minute/i);
});

test('cron creation sends only the expression and validated timezone, not a start or interval', async () => {
  const { jobPayload } = await jobsModule();
  assert.deepEqual(jobPayload({ ...values, schedule: 'cron', due_at: '' }, agents, now()), { agent_id: 'a', name: 'Check', text: 'report', cron: '0 7 * * 1-5', timezone: 'America/Chicago' });
  assert.throws(() => jobPayload({ ...values, schedule: 'cron', cron: '* * * * * *' }, agents, now()), /five|5/);
  assert.throws(() => jobPayload({ ...values, schedule: 'cron', timezone: 'Mars/Olympus' }, agents, now()), /time.?zone/i);
});

test('viewing is GET-only, safely shows orphan/fired jobs and dispatch counts, and filters one agent', async () => {
  const h = await setup({ api: async () => ({ automations: [job, { ...job, id: 'orphan', agent_id: 'gone', fired: true, fires: 3 }] }) });
  await h.controller.open(null, h.n('jobs-new'));
  assert.deepEqual(h.calls.map(([method, route]) => [method, route]), [['GET', '/api/automations']]);
  assert.equal(h.n('jobs-list').children.length, 2);
  const text = h.n('jobs-list').textContent;
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
  assert.match(text, /unavailable/i); assert.match(text, /gone/); assert.match(text, /fired/i); assert.match(text, /dispatch/i); assert.match(text, /3/); assert.match(text, /UTC/);
  await h.controller.open('a', h.n('jobs-new'));
  assert.equal(h.n('jobs-list').children.length, 1);
  assert.match(h.n('jobs-heading').textContent, /Ada/);
});

test('refresh preserves the open draft, consent, and focused input while updating the list', async () => {
  const h = await setup(); await h.controller.open('a');
  await h.n('jobs-new').emit('click'); h.fill(); h.form.elements.text.value = 'unsaved'; h.form.elements.text.focus();
  await h.controller.refresh();
  h.controller.update({ agents, automations: [{ ...job, fires: 8 }] });
  assert.equal(h.form.hidden, false); assert.equal(h.form.elements.text.value, 'unsaved'); assert.equal(h.form.elements.consent.checked, true);
  assert.equal(h.doc.activeElement, h.form.elements.text); assert.match(h.n('jobs-list').textContent, /8/);
});

test('older GET replies and errors cannot replace a newer state snapshot', async () => {
  const request = deferred(); const h = await setup({ api: () => request.promise });
  const opening = h.controller.open(null);
  assert.match(h.n('jobs-status').textContent, /loading/i);
  h.controller.update({ agents, automations: [{ ...job, name: 'Fresh snapshot' }] });
  request.resolve({ automations: [{ ...job, name: 'Stale reply' }] }); await opening;
  assert.match(h.n('jobs-list').textContent, /Fresh snapshot/); assert.doesNotMatch(h.n('jobs-list').textContent, /Stale reply/);
  const bad = deferred(); const failing = await setup({ api: () => bad.promise });
  const pending = failing.controller.open(null); failing.controller.update({ agents, automations: [job] }); bad.reject(new Error('stale failure')); await pending;
  assert.equal(failing.n('jobs-error').hidden, true);
});

test('loading failure is retryable and an empty result is explained', async () => {
  let fail = true; const h = await setup({ api: async () => { if (fail) throw new Error('Offline'); return { automations: [] }; } });
  await h.controller.open(null); assert.match(h.n('jobs-error').textContent, /Offline/);
  fail = false; await h.n('jobs-refresh').emit('click');
  assert.equal(h.n('jobs-error').hidden, true); assert.match(h.n('jobs-list').textContent, /no routines/i);
});

test('create submits once, exposes saving, requires confirmation, and resets only after success', async () => {
  const saving = deferred(); const confirmations = []; let stored = [];
  const h = await setup({ api: async (method) => {
    if (method === 'POST') { const created = await saving.promise; stored = [created]; return created; }
    return { automations: stored };
  }, confirm: (text) => { confirmations.push(text); return true; } });
  await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill();
  const pending = h.form.emit('submit'); await h.form.emit('submit');
  assert.equal(h.calls.filter(([m]) => m === 'POST').length, 1);
  assert.match(confirmations[0], /paid|cost/i); assert.match(h.n('jobs-save').textContent, /saving/i);
  assert.equal(h.form.elements.text.disabled, true);
  saving.resolve(job); await pending;
  assert.deepEqual(h.controller.items, [job]);
  assert.equal(h.form.hidden, true); assert.equal(h.form.elements.consent.checked, false); assert.ok(h.doc.activeElement === h.n('jobs-new'), 'successful create returns focus to New job');
});

test('cancelled confirmation sends nothing; failed create keeps the draft and allows retry', async () => {
  let approve = false;
  const h = await setup({ api: async (method) => { if (method === 'POST') throw new Error('Invalid cron'); return { automations: [] }; }, confirm: () => approve });
  await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill(); await h.form.emit('submit');
  assert.equal(h.calls.filter(([m]) => m === 'POST').length, 0);
  approve = true; await h.form.emit('submit');
  assert.equal(h.form.hidden, false); assert.equal(h.form.elements.text.value, ' report '); assert.equal(h.form.elements.text.disabled, false); assert.match(h.n('jobs-form-error').textContent, /Invalid cron/);
});

test('successful removal reconciles unrelated updates even when state retries were invalidated', async () => {
  const unrelated = { ...job, id: 'aut_other', name: 'Unrelated addition' };
  let removed = false;
  const h = await setup({ api: async (method) => {
    if (method === 'DELETE') { removed = true; return job; }
    return { automations: removed ? [unrelated] : [job] };
  } });
  await h.controller.open(null);
  await h.n('jobs-list').querySelectorAll('button')[0].emit('click');
  assert.deepEqual(h.controller.items.map(item => item.id), [unrelated.id]);
  assert.match(h.n('jobs-status').textContent, /cancelled/i);
});

test('remove confirms queued/active work is cancelled, deletes by id, and restores useful focus', async () => {
  const confirmations = []; let approve = false; let removed = false;
  const h = await setup({ confirm: (text) => { confirmations.push(text); return approve; }, api: async (method) => {
    if (method === 'DELETE') { removed = true; return job; }
    return { automations: removed ? [] : [job] };
  } });
  await h.controller.open(null);
  const remove = h.n('jobs-list').querySelectorAll('button')[0]; remove.focus(); await remove.emit('click');
  assert.equal(h.calls.filter(([m]) => m === 'DELETE').length, 0);
  assert.match(confirmations[0], /queued/i); assert.match(confirmations[0], /active/i); assert.match(confirmations[0], /cancels queued and active/i);
  assert.match(confirmations[0], /already performed are preserved/i);
  approve = true; await remove.emit('click');
  assert.deepEqual(h.calls.find(([m]) => m === 'DELETE'), ['DELETE', '/api/automations', { automation_id: 'aut_1' }]);
  assert.ok(h.doc.activeElement === h.n('jobs-new'), 'successful remove returns focus to New job');
});

test('closing/Escape returns focus to the opener and late replies never reopen the panel', async () => {
  const pending = deferred(); const h = await setup({ api: () => pending.promise }); const opener = h.doc.createElement('button');
  const opening = h.controller.open(null, opener); assert.equal(h.doc.activeElement, h.n('jobs-close'));
  await h.panel.emit('keydown', { key: 'Escape' });
  assert.equal(h.panel.hidden, true); assert.equal(h.doc.activeElement, opener);
  pending.resolve({ automations: [job] }); await opening; assert.equal(h.panel.hidden, true);
});

test('a completed mutation invalidates earlier GETs and state snapshots, and clears loading', async () => {
  const late = deferred(); let gets = 0;
  const h = await setup({ api: async (method) => method === 'GET' ? (++gets === 1 ? { automations: [job] } : gets === 2 ? late.promise : { automations: [] }) : job });
  await h.controller.open(null);
  const pending = h.controller.refresh(); const oldRevision = h.controller.revision;
  const remove = h.n('jobs-list').querySelectorAll('button')[0]; remove.focus(); await remove.emit('click');
  late.resolve({ automations: [job] }); await pending;
  h.controller.update({ agents, automations: [job] }, oldRevision);
  assert.equal(h.controller.items.length, 0);
  assert.equal(h.n('jobs-list').getAttribute('aria-busy'), 'false');
});

test('failed removal retains the job and restores keyboard focus for retry', async () => {
  const h = await setup({ api: async (method) => { if (method === 'DELETE') throw new Error('Offline'); return { automations: [job] }; } });
  await h.controller.open(null);
  const remove = h.n('jobs-list').querySelectorAll('button')[0]; remove.focus(); await remove.emit('click');
  assert.match(h.n('jobs-error').textContent, /Offline/);
  assert.equal(h.controller.items.length, 1); assert.equal(remove.disabled, false); assert.ok(h.doc.activeElement === remove, 'failed remove restores its button focus');
});

test('switching views keeps an existing draft target rather than silently scheduling another agent', async () => {
  const h = await setup(); await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill();
  h.form.elements.agent_id.value = 'b'; h.form.elements.text.value = 'Draft for Bea';
  await h.controller.open('a');
  assert.equal(h.form.elements.agent_id.value, 'b'); assert.equal(h.form.elements.text.value, 'Draft for Bea');
  h.controller.update({ agents: [agents[0]], automations: [job] });
  assert.equal(h.form.elements.agent_id.value, 'b'); assert.match(h.form.elements.agent_id.textContent, /Unavailable bot/);
});

test('schedule changes disable hidden required fields without erasing their values', async () => {
  const h = await setup(); await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill();
  h.form.elements.schedule.value = 'cron'; await h.form.elements.schedule.emit('change');
  assert.equal(h.form.elements.due_at.disabled, true); assert.equal(h.form.elements.minutes.disabled, true);
  assert.equal(h.form.elements.cron.disabled, false); assert.equal(h.form.elements.timezone.disabled, false);
  h.form.elements.schedule.value = 'interval'; await h.form.elements.schedule.emit('change');
  assert.equal(h.form.elements.due_at.disabled, false); assert.equal(h.form.elements.minutes.disabled, false);
  assert.equal(h.form.elements.cron.disabled, true); assert.equal(h.form.elements.due_at.value, '2030-01-02T12:00');
});

test('a late create reply cannot roll back a newer dispatched snapshot', async () => {
  const post = deferred(); let stored = [];
  const h = await setup({ api: (method) => method === 'POST' ? post.promise : Promise.resolve({ automations: stored }) });
  await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill(); const pending = h.form.emit('submit');
  stored = [{ ...job, fired: true, fires: 1 }];
  h.controller.update({ agents, automations: stored });
  post.resolve(job); await pending;
  assert.equal(h.controller.items[0].fired, true); assert.equal(h.controller.items[0].fires, 1);
});

test('a GET started during a mutation cannot leave the list busy after the mutation succeeds', async () => {
  const post = deferred(); const late = deferred(); let gets = 0;
  const h = await setup({ api: (method) => method === 'POST' ? post.promise : (++gets === 2 ? late.promise : Promise.resolve({ automations: gets === 1 ? [] : [job] })) });
  await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill(); const saving = h.form.emit('submit');
  const loading = h.controller.refresh(); post.resolve(job); await saving; late.resolve({ automations: [] }); await loading;
  assert.equal(h.controller.items.length, 1); assert.equal(h.n('jobs-list').getAttribute('aria-busy'), 'false');
});

for (const removal of ['panel', 'external']) {
  test(`a late create acknowledgement cannot resurrect a job removed by ${removal} after SSE exposed it`, async () => {
    const post = deferred(); let stored = [];
    const h = await setup({ api: async (method, route, body) => {
      if (method === 'POST') return post.promise;
      if (method === 'DELETE') { stored = stored.filter((item) => item.id !== body.automation_id); return job; }
      return { automations: stored };
    } });
    await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill();
    const pending = h.form.emit('submit');
    stored = [job]; h.controller.update({ agents, automations: stored });
    assert.equal(h.controller.items.length, 1, 'SSE exposes the created job before POST acknowledges');
    if (removal === 'panel') {
      const remove = h.n('jobs-list').querySelectorAll('button')[0]; remove.focus(); await remove.emit('click');
      assert.equal(h.controller.items.length, 0, 'DELETE acknowledged while creation is still pending');
    } else {
      stored = []; // Another client removed it; its SSE snapshot has not arrived yet.
    }
    post.resolve(job); await pending;
    assert.deepEqual(h.controller.items, []);
    assert.match(h.n('jobs-list').textContent, /no routines/i);
    assert.doesNotMatch(h.n('jobs-status').textContent, /automatic work is scheduled/i);
    assert.equal(h.form.hidden, true); assert.equal(h.form.elements.consent.checked, false);
    assert.equal(h.calls.filter(([method]) => method === 'POST').length, 1);
  });
}

test('confirmed creation stays successful when its authoritative list refresh fails', async () => {
  let created = false;
  const h = await setup({ api: async (method) => {
    if (method === 'POST') { created = true; return job; }
    if (created) throw new Error('Offline');
    return { automations: [] };
  } });
  await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill(); await h.form.emit('submit');
  assert.equal(h.form.hidden, true); assert.equal(h.form.elements.consent.checked, false);
  assert.equal(h.n('jobs-form-error').hidden, true);
  assert.match(h.n('jobs-error').textContent, /Offline.*Refresh/);
  assert.match(h.n('jobs-status').textContent, /routine created/i);
  assert.doesNotMatch(h.n('jobs-status').textContent, /not confirmed|could not create|scheduled/i);
  assert.equal(h.calls.filter(([method]) => method === 'POST').length, 1);
});

test('SSE removing the last orphan moves list focus to enabled Close when New job is disabled', async () => {
  const orphan = { ...job, agent_id: 'gone' };
  const h = await setup({ api: async () => ({ automations: [orphan] }) });
  await h.controller.open(); h.controller.update({ agents: [], automations: [orphan] });
  const remove = h.n('jobs-list').querySelectorAll('button')[0]; remove.focus();
  h.controller.update({ agents: [], automations: [] });
  assert.equal(h.n('jobs-new').disabled, true);
  assert.ok(h.doc.activeElement === h.n('jobs-close'), 'focus lands on enabled Close, not body or a detached control');
});

test('a create reconciliation cannot overwrite newer SSE state or a newly opened draft', async () => {
  const read = deferred(); let gets = 0;
  const h = await setup({ api: async (method) => method === 'POST' ? job : (++gets === 1 ? { automations: [] } : read.promise) });
  await h.controller.open('a'); await h.n('jobs-new').emit('click'); h.fill();
  const pending = h.form.emit('submit'); await new Promise(setImmediate);
  await h.n('jobs-new').emit('click'); h.fill(); h.form.elements.text.value = 'Next draft'; h.form.elements.text.focus();
  const other = { ...job, id: 'other', name: 'Other schedule' };
  h.controller.update({ agents, automations: [other] });
  read.resolve({ automations: [job] }); await pending;
  assert.deepEqual(h.controller.items, [other]);
  assert.equal(h.form.hidden, false); assert.equal(h.form.elements.text.value, 'Next draft');
  assert.equal(h.form.elements.consent.checked, true); assert.ok(h.doc.activeElement === h.form.elements.text);
});

test('jobs status retains cancellation counts across refresh and state updates', async () => {
  const cancellation = { cancelled_runs: ['r1'], stopping_runs: ['r2'], reconciliation_required: [{ run_id: 'r2' }] };
  const { controller, n } = await setup({ api: async () => ({ automations: [], automation_cancellations: [cancellation] }) });
  await controller.open();
  assert.match(n('jobs-status').textContent, /1 runs cancelled; 1 still stopping; 1 actions need reconciliation/);
  controller.update({ automations: [], automation_cancellations: [{ ...cancellation, stopping_runs: [] }] });
  assert.match(n('jobs-status').textContent, /0 still stopping; 1 actions need reconciliation/);
});
