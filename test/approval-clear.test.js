import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const start = source.indexOf('let approvalsSnapshot =');
const end = source.indexOf('\nfunction ', source.indexOf('function renderApprovals()') + 1);
function fixture(state, fail = '') {
  const elements = [], calls = [], errors = [];
  let refreshed = 0;
  const el = (tag, cls, text) => {
    const node = { tag, text, append() {}, replaceChildren() {}, addEventListener() {} };
    elements.push(node); return node;
  };
  const context = vm.createContext({ state: { approvals: [], ...state }, el, $: () => el('div'), agentById: () => null,
    crypto: { randomUUID: () => 'test-decision' },
    api: async (...args) => { calls.push(args); if (args[2].report_id === fail) throw Error('test failure'); },
    refresh: async () => { refreshed++; }, banner: message => errors.push(message),
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext('renderApprovals()', context);
  return { elements, calls, errors, refreshed: () => refreshed };
}
test('bulk clear remains for blocker-only cards and clears all reports despite one failure', async () => {
  const f = fixture({ blocked: [{ id: 'one', reason: 'other' }, { id: 'two', reason: 'other' }] }, 'one');
  const button = f.elements.find(e => e.text === 'Clear all tasks and reports');
  assert.ok(button); await button.onclick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1][2].report_id, 'two');
  assert.equal(f.refreshed(), 1); assert.equal(button.disabled, false); assert.equal(f.errors.length, 1);
});
test('mixed clear abandons interrupted work and resolves reports without approving actions', async () => {
  const f = fixture({ reconciliation: [{ kind: 'memory', id: 'memory1', revision: 'rev', record: {} }], blocked: [{ id: 'report', reason: 'other' }] });
  await f.elements.find(e => e.text === 'Clear all tasks and reports').onclick();
  assert.equal(f.calls[0][1], '/api/reconciliation'); assert.equal(f.calls[0][2].outcome, 'abandoned');
  assert.equal(f.calls[1][1], '/api/blocked/resolve'); assert.equal(f.calls.length, 2);
});

test('public-page refusal notices do not imply desktop takeover or a paused agent', async () => {
  const f = fixture({ blocked: [{ id: 'web', reason: 'other', detail: 'WebReadPublic (example.org) refused access (HTTP 403).', screenshot: 'desktop.png', view: 'desktop-command' }] });
  assert.ok(f.elements.some(e => e.text?.includes('couldn’t read a public page')));
  assert.ok(f.elements.some(e => e.text?.includes('does not pause the bot')));
  assert.ok(!f.elements.some(e => e.tag === 'img'));
  const dismiss = f.elements.find(e => e.text === 'Dismiss notice');
  await dismiss.onclick();
  assert.deepEqual(f.calls.map(call => call[1]), ['/api/blocked/resolve']);
});
