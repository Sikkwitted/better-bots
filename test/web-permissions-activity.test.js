import test from 'node:test';
import assert from 'node:assert/strict';

// Behavioral tests for the permissions and activity panels: the real web/app.js runs
// against a stub DOM and a scripted fetch, so the assertions cover what a user
// would see and do — render, click, reverse, drill down — not source text.

// --- browser environment stubs (installed before app.js is imported) --------

function makeElement(tag) {
  // DOM text shows up as bare strings in append/replaceChildren; adopt wraps
  // them so every child has the shape the assertions and remove() expect.
  const adopt = (kid) => (typeof kid === 'string' ? { textContent: kid, children: [] } : kid);
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    textContent: '',
    className: '',
    title: '',
    hidden: false,
    disabled: false,
    type: '',
    value: '',
    href: '',
    target: '',
    rel: '',
    open: false,
    dataset: {},
    attrs: {},
    classList: null,
    append(...kids) { for (const kid of kids) { const child = adopt(kid); child.parent = node; node.children.push(child); } },
    prepend(kid) { const child = adopt(kid); child.parent = node; node.children.unshift(child); },
    insertBefore(kid) { const child = adopt(kid); child.parent = node; node.children.unshift(child); },
    replaceChildren(...kids) {
      node.children = [];
      for (const kid of kids) { const child = adopt(kid); child.parent = node; node.children.push(child); }
    },
    querySelector(sel) { return document.querySelector(sel); },
    querySelectorAll(sel) {
      const tag = sel.replace(/[^a-z]/gi, '').toUpperCase();
      const found = [];
      const walk = (n) => { for (const child of n.children ?? []) { if (child.tagName === tag) found.push(child); walk(child); } };
      walk(node);
      return found;
    },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return node.attrs[k] ?? null; },
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; },
    contains(other) {
      if (other == null) return false;
      const walk = (n) => { for (const child of n.children ?? []) { if (child === other || walk(child)) return true; } return false; };
      return walk(node);
    },
    addEventListener() {},
    focus() {},
    reset() {},
    showModal() { node.open = true; },
    close() { node.open = false; },
    // A real remove: the activity feed's 200-row cap evicts rows with
    // lastElementChild.remove(), so a no-op remove here never terminates.
    remove() {
      if (node.parent) {
        const at = node.parent.children.indexOf(node);
        if (at !== -1) node.parent.children.splice(at, 1);
        node.parent = null;
      }
    },
  };
  Object.defineProperty(node, 'ownerDocument', { get: () => globalThis.document });
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] ?? null });
  Object.defineProperty(node, 'lastChild', { get: () => node.children.at(-1) ?? null });
  Object.defineProperty(node, 'lastElementChild', { get: () => node.children.at(-1) ?? null });
  const styleBag = {};
  node.style = new Proxy({
    setProperty: (k, v) => { styleBag[k] = v; },
    getPropertyValue: (k) => styleBag[k] ?? '',
    removeProperty: (k) => { delete styleBag[k]; },
  }, {
    get: (t, key) => t[key] ?? styleBag[key] ?? '',
    set: (t, key, value) => { styleBag[key] = value; return true; },
  });
  // Forms reach their fields by name (`form.elements.schedule`), so every
  // element carries a self-populating field bag.
  node.elements = new Proxy({}, {
    get: (bag, key) => (bag[key] ??= makeElement('input')),
    has: () => true,
  });
  node.classList = {
    set: new Set(),
    add: (...cs) => { for (const c of cs) node.classList.set.add(c); },
    remove: (...cs) => { for (const c of cs) node.classList.set.delete(c); },
    toggle(c) {
      if (node.classList.set.has(c)) { node.classList.set.delete(c); return false; }
      node.classList.set.add(c);
      return true;
    },
  };
  return node;
}

const bySelector = new Map();
globalThis.document = {
  hidden: false,
  activeElement: null,
  documentElement: makeElement('html'),
  body: makeElement('body'),
  querySelector(sel) {
    if (!bySelector.has(sel)) bySelector.set(sel, makeElement(sel));
    return bySelector.get(sel);
  },
  querySelectorAll() { return []; },
  createElement(tag) { return makeElement(tag); },
  createDocumentFragment() { return makeElement('fragment'); },
  addEventListener() {},
};
globalThis.window = { addEventListener() {}, confirm: () => true, innerWidth: 1280, innerHeight: 800 };
globalThis.confirm = () => true;
globalThis.location = { hash: '', pathname: '/', search: '' };
globalThis.localStorage = (() => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
})();

class FakeEventSource {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeEventSource.instances.push(this); }
  close() { this.readyState = 2; }
}
globalThis.EventSource = FakeEventSource;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => realSetTimeout(fn, 0);
globalThis.cancelAnimationFrame = () => {};

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
const realSetTimeout = globalThis.setTimeout;

// --- scripted host -----------------------------------------------------------

const stateData = {
  version: '',
  live: false,
  model: null,
  reconciliation: [],
  previews: [],
  log_corruption: [],
  agents: [{
    id: 'agt_1', name: 'Ada', role: 'lead', lead: true, pinned: false,
    active_run: null, queued: [], inbox: 0, desk: '',
    window: { window_index: 2, vnc_url: '' },
    usage_24h: { runs: 2, input_tokens: 1500, output_tokens: 500, cache_read_input_tokens: 100, provenance: 'estimated' },
  }],
  desks: [],
  rooms: [],
  pending_approvals: [],
  blocked: [],
  automations: [],
  standing_permissions: { local: 'ask', external: 'ask', sandbox: 'always', coordination: 'never' },
  explicit_permissions: { local: false, external: true, sandbox: false, coordination: true },
  permission_ceilings: { local: 'always', external: 'ask', sandbox: 'always', coordination: 'always' },
  computer: { screens: [] },
};
const posts = [];
let explainPayload = null;

globalThis.fetch = async (route, init = {}) => {
  const json = (data) => ({ ok: true, status: 200, json: async () => data });
  if (route === '/api/state') return json(stateData);
  if (route.startsWith('/api/activity')) return json({ events: [] });
  if (route.startsWith('/api/transcript')) return json({ entries: [] });
  if (route.startsWith('/api/explain')) return json(explainPayload);
  if (init.method === 'POST') {
    posts.push({ route, body: JSON.parse(init.body) });
    return json({ ok: true });
  }
  return json({});
};

// --- import the real app once the stage is set -------------------------------

await import('../web/app.js');
await new Promise((resolve) => realSetTimeout(resolve, 5));

const textOf = (node) => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  return (node.textContent ?? '') + (node.children ?? []).map(textOf).join('');
};

function permissionCards() {
  return document.querySelector('#permissions').children.filter((c) => c.className === 'card');
}

test('the permissions panel renders every zone with its standing mode and ceiling', () => {
  const cards = permissionCards();
  assert.equal(cards.length, 4, 'one card per permission zone');
  const local = cards.find((c) => c.dataset.zone === 'local');
  assert.ok(local, 'the local zone is described');
  assert.match(textOf(local), /built-in defaults/i);
  const badge = textOf(local).match(/Built-in defaults/);
  assert.ok(badge, 'an unexplicit zone is honestly labelled defaults, not a chosen mode');
  const buttons = local.querySelectorAll('button');
  assert.equal(buttons.find((b) => b.dataset.mode === 'ask').disabled, false, 'default Ask can still be explicitly selected');
  assert.equal(buttons.find((b) => b.dataset.mode === 'always').disabled, false);
  assert.equal(buttons.find((b) => b.dataset.mode === 'never').disabled, false);
});

test('an Always choice made through an approval card is visible and reversible', async () => {
  const cards = permissionCards();
  const sandbox = cards.find((c) => c.dataset.zone === 'sandbox');
  assert.match(textOf(sandbox), /built-in defaults/i, 'an always in force is shown even when it was a default');
  const buttons = sandbox.querySelectorAll('button');
  assert.equal(buttons.find((b) => b.dataset.mode === 'always').disabled, false, 'an unexplicit default can be re-affirmed explicitly');
  const ask = buttons.find((b) => b.dataset.mode === 'ask');
  assert.equal(ask.disabled, false, 'Ask can reverse a standing Always');
  await ask.onclick();
  const applied = posts.find((p) => p.route === '/api/permissions');
  assert.deepEqual(applied.body, { zone: 'sandbox', mode: 'ask' }, 'reversal posts the zone and mode');
});

test('a standing Never is shown as an explicit choice and reverses to Ask', async () => {
  const coordination = permissionCards().find((c) => c.dataset.zone === 'coordination');
  assert.match(textOf(coordination), /Right now: Always block\./, 'Never is inspectable, not hidden');
  const ask = coordination.querySelectorAll('button').find((b) => b.dataset.mode === 'ask');
  stateData.standing_permissions.coordination = 'ask';
  stateData.explicit_permissions.coordination = true;
  await ask.onclick();
  const card = permissionCards().find((c) => c.dataset.zone === 'coordination');
  assert.match(textOf(card), /Right now: Ask me first\./, 'the reversal is reflected after the host confirms it');
  assert.equal(card.querySelectorAll('button').find((b) => b.dataset.mode === 'ask').disabled, false);
});

test('a policy ceiling blocks the more permissive choices in the panel', () => {
  const external = permissionCards().find((c) => c.dataset.zone === 'external');
  const buttons = external.querySelectorAll('button');
  const always = buttons.find((b) => b.dataset.mode === 'always');
  assert.equal(always.disabled, true, 'Always is above the ask ceiling');
  assert.match(always.title, /administrator limit/);
});

test('a rejected change reports the host error instead of pretending success', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (route, init = {}) => {
      if (route === '/api/state') return { ok: true, status: 200, json: async () => stateData };
      if (init.method === 'POST' && route === '/api/permissions') {
        return { ok: false, status: 403, json: async () => ({ error: 'ceiling_exceeded', message: 'policy ceiling for external is ask' }) };
      }
      const json = (data) => ({ ok: true, status: 200, json: async () => data });
      if (route.startsWith('/api/transcript')) return json({ entries: [] });
      return json({});
    };
    const external = permissionCards().find((c) => c.dataset.zone === 'external');
    const never = external.querySelectorAll('button').find((b) => b.dataset.mode === 'never');
    await never.onclick();
    const bannerNode = document.querySelector('#banner');
    assert.match(bannerNode.textContent, /Not applied: policy ceiling for external is ask/);
    assert.match(bannerNode.className, /bad/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('run-linked activity rows show action and target, and open the run record', async () => {
  explainPayload = {
    run: { id: 'run_9', status: 'done', lane: 'user', model: 'm1', model_provider: 'local' },
    audit: [
      { at: '2026-09-14T00:00:00Z', type: 'permission.asked', agent_id: 'agt_1', action: 'local.read_file', target: '/tmp/notes.txt' },
      { at: '2026-09-14T00:00:01Z', type: 'permission.resolved', agent_id: 'agt_1', action: 'local.read_file', target: '/tmp/notes.txt', resolution: 'allow_once' },
    ],
    result: { text: 'Read the file.', usage: { input_tokens: 10, output_tokens: 3, provenance: 'provider_reported' } },
  };
  const stream = FakeEventSource.instances.at(-1);
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T00:00:00Z', type: 'permission.asked', agent_id: 'agt_1', action: 'local.read_file', target: '/tmp/notes.txt', run_id: 'run_9' }) });
  const activity = document.querySelector('#activity');
  const row = activity.children[0];
  assert.match(textOf(row), /asked · Ada/);
  assert.match(textOf(row), /local read file · \/tmp\/notes\.txt/, 'the action and its exact target are on the row');
  assert.ok(row.classList.set.has('linked'), 'run-linked rows are marked clickable');
  assert.equal(row.onclick instanceof Function, true);

  await row.onclick();
  const dialog = document.querySelector('#explain-dialog');
  assert.equal(dialog.open, true, 'the drilldown opens');
  const rendered = textOf(dialog);
  assert.match(rendered, /Run run_9/);
  assert.match(rendered, /Authorization trail/);
  assert.match(rendered, /local read file · (→ )?\/tmp\/notes\.txt/, 'the trail shows what was asked');
  assert.match(rendered, /allow once/, 'and how it was authorized');
  assert.match(rendered, /provider-reported token counts, not billing-authoritative/, 'usage keeps its provenance and caveat');
  dialog.children.find((n) => n.tagName === 'DIV').children.find((n) => n.textContent === 'Close').onclick();
  assert.equal(dialog.open, false, 'and closes');
});

test('activity rows degrade safely on missing fields and ignore uninteresting events', () => {
  const activity = document.querySelector('#activity');
  const before = activity.children.length;
  const stream = FakeEventSource.instances.at(-1);
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T00:00:02Z', type: 'host.boot' }) });
  assert.equal(activity.children.length, before, 'uninteresting events stay out of the feed');
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T00:00:03Z', type: 'permission.blocked', agent_id: 'agt_1', basis: 'denied_earlier' }) });
  const row = activity.children[0];
  assert.match(textOf(row), /blocked · Ada/);
  assert.match(textOf(row), /denied earlier/, 'whatever detail the event carries is still shown');
  assert.ok(row.onclick instanceof Function, 'rows without a run still open the event record');
});

test('newest activity is on top and the feed keeps its 200-row cap', () => {
  const stream = FakeEventSource.instances.at(-1);
  for (let i = 0; i < 205; i += 1) {
    stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T00:01:00Z', type: 'run.usage', agent_id: 'agt_1', reason: `event-${i}` }) });
  }
  const activity = document.querySelector('#activity');
  assert.equal(activity.children.length, 200, 'the cap holds');
  assert.match(textOf(activity.children[0]), /event-204/, 'newest first');
  assert.match(textOf(activity.children.at(-1)), /event-5/, 'oldest evicted');
});

test('the usage chip labels its provenance and never claims billing authority', () => {
  const meta = document.querySelector('#chat-meta');
  const chip = meta.children.map((n) => textOf(n)).find((t) => t.includes('tok · 24h'));
  assert.match(chip, /2\.0k tok · 24h · estimated/, 'the counts say where they came from');
  const titled = meta.children.find((n) => (n.title ?? '').includes('billing-authoritative'));
  assert.ok(titled, 'the tooltip carries the billing caveat');
});

test('structured targets survive verbatim as JSON, not [object Object]', () => {
  const stream = FakeEventSource.instances.at(-1);
  stream.onmessage({ data: JSON.stringify({
    at: '2026-09-14T00:02:00Z', type: 'tool.call', agent_id: 'agt_1', action: 'local.write_file',
    target: { path: '/tmp/exact path.txt', url: 'https://host.example/x?a=1&b=2' }, run_id: 'run_t',
  }) });
  const row = document.querySelector('#activity').children[0];
  const rendered = textOf(row);
  assert.match(rendered, /"path":"\/tmp\/exact path\.txt"/, 'the exact structured target is on the row');
  assert.match(rendered, /https:\/\/host\.example\/x\?a=1&b=2/);
  assert.ok(!rendered.includes('[object Object]'), 'no lost structured detail');
});

test('linked activity rows open from the keyboard too', async () => {
  explainPayload = {
    run: { id: 'run_kb', status: 'done' }, audit: [], result: null,
  };
  const stream = FakeEventSource.instances.at(-1);
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T00:03:00Z', type: 'run.usage', agent_id: 'agt_1', reason: 'kb', run_id: 'run_kb' }) });
  const row = document.querySelector('#activity').children[0];
  assert.equal(row.attrs.role, 'button', 'rows expose a button role');
  assert.equal(row.tabIndex, 0, 'rows are reachable by keyboard');

  const dialog = document.querySelector('#explain-dialog');
  await row.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.equal(dialog.open, true, 'Enter opens the drilldown');
  dialog.close();
  await row.onkeydown({ key: ' ', preventDefault() {} });
  assert.equal(dialog.open, true, 'Space opens it too');
  dialog.close();
  await row.onkeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(dialog.open, false, 'other keys do nothing');
});

test('the drilldown shows who authorized what, and whether execution succeeded', async () => {
  explainPayload = {
    run: { id: 'run_apr', status: 'failed', lane: 'user' },
    audit: [
      { at: '2026-09-14T01:00:00Z', type: 'permission.asked', agent_id: 'agt_1', action: 'local.write_file', target: '/fixture/same-target', tool: 'ApprovalFixture', call_id: 'tc_ApprovalFixture', request_id: 'apr_1', run_id: 'run_apr' },
      { at: '2026-09-14T01:00:01Z', type: 'permission.resolved', agent_id: 'agt_1', action: 'local.write_file', target: '/fixture/same-target', actor: 'user', resolution: 'allow_once', tool: 'ApprovalFixture', call_id: 'tc_ApprovalFixture', request_id: 'apr_1', run_id: 'run_apr' },
      { at: '2026-09-14T01:00:02Z', type: 'tool.failed', agent_id: 'agt_1', tool: 'ApprovalFixture', result: { ok: false }, error: 'fixture failed after approval', run_id: 'run_apr' },
      { at: '2026-09-14T01:00:03Z', type: 'tool.executed', agent_id: 'agt_1', name: 'LocalReadFile', target: '/tmp/missing.txt', call_id: 'tc_LocalReadFile', result: { ok: false, error: 'not_found' }, run_id: 'run_apr' },
    ],
    result: { usage: { input_tokens: 5, output_tokens: 1, provenance: 'provider_reported' } },
  };
  const stream = FakeEventSource.instances.at(-1);
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T01:00:00Z', type: 'permission.asked', agent_id: 'agt_1', action: 'local.write_file', target: '/fixture/same-target', run_id: 'run_apr' }) });
  const row = document.querySelector('#activity').children[0];
  await row.onclick();
  const rendered = textOf(document.querySelector('#explain-dialog'));
  assert.match(rendered, /by user/, 'the actor is on the authorization trail');
  assert.match(rendered, /allow once/, 'the resolution is on the trail');
  assert.match(rendered, /ApprovalFixture/, 'the tool has context');
  assert.match(rendered, /call tc_ApprovalFixture/, 'the exact call is linked');
  assert.match(rendered, /request apr_1/, 'ask and resolution share their request id');
  assert.match(rendered, /result: failed/, 'a failed execution is stated');
  assert.match(rendered, /error: fixture failed after approval/, 'with its error');
  // A returned failure (tool.executed, not tool.failed): the tool name lives
  // in `name` and the reason inside `result`, and both must reach the row.
  assert.match(rendered, /LocalReadFile/, 'the executed tool name renders');
  assert.match(rendered, /error: not_found/, 'the nested returned-failure reason renders');
  assert.match(rendered, /→ \/tmp\/missing\.txt/, 'with its exact target');
});

test('deletion reports pending desktop teardown instead of implying finished cleanup', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (route, init = {}) => {
      if (route === '/api/state') return { ok: true, status: 200, json: async () => stateData };
      if (init.method === 'DELETE' && route === '/api/agents') {
        return { ok: true, status: 200, json: async () => ({ ok: true, cleanup_pending: true, status: 'cleanup_pending', message: 'Agent deleted; desktop cleanup is pending and its slot remains unavailable.' }) };
      }
      const json = (data) => ({ ok: true, status: 200, json: async () => data });
      if (route.startsWith('/api/transcript')) return json({ entries: [] });
      return json({});
    };
    const findRow = (node) => {
      if (node.oncontextmenu instanceof Function) return node;
      for (const child of node.children ?? []) { const hit = findRow(child); if (hit) return hit; }
      return null;
    };
    const row = findRow(document.querySelector('#agent-list'));
    assert.ok(row, 'an agent row with a context menu is rendered');
    row.oncontextmenu({ preventDefault() {}, clientX: 10, clientY: 10 });
    const menu = document.body.children.find((n) => n.className === 'ctx-menu');
    assert.ok(menu, 'the context menu opens');
    const del = menu.querySelectorAll('button').find((b) => b.textContent === 'Delete…');
    await del.onclick();
    const bannerNode = document.querySelector('#banner');
    assert.match(bannerNode.textContent, /desktop cleanup is pending/, 'the host message shows verbatim');
    assert.ok(!/deleted$/.test(bannerNode.textContent.trim()), 'it does not claim a finished cleanup');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an Always-to-Ask reversal persists through the real permission service', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { PermissionService } = await import('../src/services/permission-service.js');
  const clock = { now: () => Date.now(), iso: () => new Date().toISOString() };
  const audit = { record() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-perm-'));

  // The user answers a real approval card with Always (the resolver the
  // server route calls), then reverses it through the panel's endpoint.
  const service = new PermissionService({ dir, clock, audit });
  const decision = service.authorize({ agent_id: 'agt_x', action: 'local.write_file', target: '/fixture/target', scope_id: 's1' });
  assert.equal(decision.decision, 'ask');
  assert.equal(service.resolve(decision.request.id, 'always', { actor: 'user' }).ok, true);
  assert.equal(service.standingMode('local'), 'always');
  assert.equal(service.setStandingMode('local', 'ask', { actor: 'user' }), 'ask');

  // Reload: a fresh service on the same store must keep the reversal.
  const reloaded = new PermissionService({ dir, clock, audit });
  assert.equal(reloaded.standingMode('local'), 'ask', 'the reversal survives a reload');
  assert.equal(reloaded.doc.read().explicit.local, true, 'recorded as an explicit choice, not a default');
  assert.throws(() => reloaded.setStandingMode('external', 'always', { actor: 'agent' }), /only the user may change/, 'agents can never set standing modes');

  // The panel, fed from that reloaded state, reflects the persisted reversal.
  stateData.standing_permissions = { ...reloaded.doc.read().standing };
  stateData.explicit_permissions = { ...reloaded.doc.read().explicit };
  stateData.permission_ceilings = { ...reloaded.doc.read().ceiling };
  const stream = FakeEventSource.instances.at(-1);
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T02:00:00Z', type: 'memory.remembered', agent_id: 'agt_1' }) });
  await new Promise((resolve) => realSetTimeout(resolve, 260));
  const local = permissionCards().find((c) => c.dataset.zone === 'local');
  assert.match(textOf(local), /Right now: Ask me first\./, 'the panel shows the persisted, explicit Ask');
});

test('explicitly selecting Ask establishes a standing Ask policy', async () => {
  // Establish the scenario this test is about: a zone still on its unexplicit
  // default Ask (earlier tests may have mutated the shared fixture).
  stateData.standing_permissions.local = 'ask';
  stateData.explicit_permissions.local = false;
  stateData.permission_ceilings.local = 'always';
  FakeEventSource.instances.at(-1).onmessage({ data: JSON.stringify({ at: '2026-09-14T02:30:00Z', type: 'memory.remembered', agent_id: 'agt_1' }) });
  await new Promise((resolve) => realSetTimeout(resolve, 260));

  const local = permissionCards().find((c) => c.dataset.zone === 'local');
  const ask = local.querySelectorAll('button').find((b) => b.dataset.mode === 'ask');
  await ask.onclick();
  const applied = posts.filter((p) => p.route === '/api/permissions').at(-1);
  assert.deepEqual(applied.body, { zone: 'local', mode: 'ask' }, 'the explicit choice is posted');

  // The host records the choice; the panel must show a chosen policy, and the
  // badge may no longer say "defaults" for this zone.
  stateData.standing_permissions.local = 'ask';
  stateData.explicit_permissions.local = true;
  FakeEventSource.instances.at(-1).onmessage({ data: JSON.stringify({ at: '2026-09-14T02:31:00Z', type: 'memory.remembered', agent_id: 'agt_1' }) });
  await new Promise((resolve) => realSetTimeout(resolve, 260));
  const card = permissionCards().find((c) => c.dataset.zone === 'local');
  assert.match(textOf(card), /Right now: Ask me first\./);
  assert.match(textOf(card), /ask/, 'the effective badge names the chosen mode');
  assert.equal(card.querySelectorAll('button').find((b) => b.dataset.mode === 'ask').disabled, false);
});

test('the real permission service proves explicit Ask changes what actually runs', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { PermissionService } = await import('../src/services/permission-service.js');
  const clock = { now: () => Date.now(), iso: () => new Date().toISOString() };
  const audit = { record() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-perm-ask-'));
  const service = new PermissionService({ dir, clock, audit });

  // With no explicit choice, a public web read still allows (its default),
  // which is exactly why a stored default Ask must not be shown as "Ask in force".
  assert.equal(service.effectivePolicy('web.read_public').mode, 'always', 'public reads default to allow while the zone is unexplicit');
  assert.equal(service.effectivePolicy('local.read_file').mode, 'ask', 'risky local reads already ask by default');

  // Choosing Ask explicitly applies to the whole zone, default-allow included.
  assert.equal(service.setStandingMode('external', 'ask', { actor: 'user' }), 'ask');
  assert.equal(service.effectivePolicy('web.read_public').mode, 'ask', 'the explicit choice now governs what used to default to allow');
  assert.equal(new PermissionService({ dir, clock, audit }).effectivePolicy('web.read_public').mode, 'ask', 'and it persists across reload');
});

test('permission changes show actor and selected mode, and open their record without a run', async () => {
  const stream = FakeEventSource.instances.at(-1);
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T03:00:00Z', type: 'permission.standing_set', zone: 'local', mode: 'ask', actor: 'user' }) });
  const row = document.querySelector('#activity').children[0];
  const rendered = textOf(row);
  assert.match(rendered, /standing_set/, 'the change is named');
  assert.match(rendered, /local · ask · user/, 'zone, selected mode, and actor are on the row');

  await row.onclick();
  const dialog = document.querySelector('#explain-dialog');
  assert.equal(dialog.open, true, 'the record opens even without a run id');
  const fields = textOf(dialog);
  assert.match(fields, /Event permission\.standing_set/);
  assert.match(fields, /zone: local/);
  assert.match(fields, /mode: ask/);
  assert.match(fields, /actor: user/);
  dialog.children[0].children.find((n) => n.textContent === 'Close').onclick();
  assert.equal(dialog.open, false);
});

test('saved approval screenshots stay accessible after the card is gone', async () => {
  // Run-scoped: the drilldown shows the evidence the run recorded.
  explainPayload = {
    run: { id: 'run_ev', status: 'done' },
    audit: [
      { at: '2026-09-14T04:00:00Z', type: 'permission.asked', agent_id: 'agt_1', action: 'local.read_file', target: '/tmp/evidence.txt', request_id: 'apr_7', run_id: 'run_ev' },
      { at: '2026-09-14T04:00:01Z', type: 'permission.evidence_attached', agent_id: 'agt_1', request_id: 'apr_7', run_id: 'run_ev', screenshot: 'shot_evidence_1.png' },
    ],
    result: null,
  };
  const stream = FakeEventSource.instances.at(-1);
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T04:00:00Z', type: 'permission.asked', agent_id: 'agt_1', action: 'local.read_file', target: '/tmp/evidence.txt', run_id: 'run_ev' }) });
  await document.querySelector('#activity').children[0].onclick();
  const dialog = document.querySelector('#explain-dialog');
  const img = dialog.children.find((n) => n.tagName === 'IMG');
  assert.ok(img, 'the retained screenshot renders in the drilldown');
  assert.equal(img.src, '/api/screens/shot_evidence_1.png', 'served by the same authorized endpoint the card used');
  dialog.close();

  // Feed-scoped: the evidence event itself opens a record with the screenshot.
  stream.onmessage({ data: JSON.stringify({ at: '2026-09-14T04:00:05Z', type: 'permission.evidence_attached', agent_id: 'agt_1', request_id: 'apr_9', screenshot: 'shot_card_9.png' }) });
  const row = document.querySelector('#activity').children[0];
  await row.onclick();
  const eventDialog = document.querySelector('#explain-dialog');
  const eventImg = eventDialog.children.find((n) => n.tagName === 'IMG');
  assert.ok(eventImg, 'the feed-level evidence record shows the screenshot too');
  assert.equal(eventImg.src, '/api/screens/shot_card_9.png');
  assert.match(textOf(eventDialog), /request_id: apr_9/);
  eventDialog.close();
});

 test('selected permission is visibly active and remains clickable', async () => {
  stateData.standing_permissions.external = 'always';
  stateData.explicit_permissions.external = true;
  FakeEventSource.instances.at(-1).onmessage({data:JSON.stringify({type:'memory.remembered'})});
  await new Promise(resolve=>realSetTimeout(resolve,260));
  const card=permissionCards().find(c=>c.dataset.zone === 'external');
  const button=card.querySelectorAll('button').find(b=>b.dataset.mode==='always');
  assert.equal(button.disabled,false);
  assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.ok(button.classList.set.has('selected'));
  await button.onclick();
  assert.deepEqual(posts.at(-1).body,{zone:'external',mode:'always'});
});
