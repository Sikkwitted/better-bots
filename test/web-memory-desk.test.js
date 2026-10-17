import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('desk memory picker stays inside its desk and sends the chosen agent to recall', async () => {
  class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.hidden = false; this.text = ''; }
    get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join('') : this.text; }
    set textContent(value) { this.replaceChildren(); this.text = String(value); }
    replaceChildren(...children) { this.children = children; this.text = ''; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this[name] = String(value); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    querySelector() { return new Node('button'); }
  }
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Node(selector === '#memory-agent' ? 'select' : 'div'));
    return nodes.get(selector);
  };
  const agents = [
    { id: 'research-a', name: 'Ada', desk: 'Research' },
    { id: 'research-b', name: 'Bea', desk: 'Research' },
    { id: 'ops-a', name: 'Cal', desk: 'Ops' },
  ];
  const state = { agents, selectedKind: 'agent', selected: 'ops-a' };
  const calls = [];
  const context = vm.createContext({
    state, $,
    agentById: (id) => agents.find((agent) => agent.id === id),
    el: (tag, cls, value) => { const node = new Node(tag); node.className = cls; if (value != null) node.textContent = value; return node; },
    jobs: { close() {} }, showPane() {}, banner() {}, document: { createTextNode: (value) => new Node(value) },
    FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.values[name]; } },
    api: async (method, route, body) => {
      calls.push({ method, route, body });
      if (method === 'GET') return { counts: { own: 0, project: 0, user: 0 }, engine: 'test', retention: { counts: {} }, standing: [], facts: [] };
      return { results: [] };
    },
  });
  vm.runInContext(source.slice(source.indexOf('const memoryPanel ='), source.indexOf("$('#open-settings').onclick")), context);
  const run = (code) => vm.runInContext(code, context);

  run("openDeskMemory('Research')");
  await new Promise((resolve) => setImmediate(resolve));
  const picker = $('#memory-agent');
  assert.equal($('#memory-agent-row').hidden, false);
  assert.deepEqual(picker.children.map((option) => option.value), ['research-a', 'research-b']);
  assert.equal(picker.value, 'research-a');
  assert.equal(calls.at(-1).route, '/api/memory?agent_id=research-a');

  picker.value = 'research-b';
  picker.listeners.change({ target: picker });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal($('#memory-name').textContent, 'Bea');
  assert.equal(calls.at(-1).route, '/api/memory?agent_id=research-b');
  await $('#memory-search').listeners.submit({ preventDefault() {}, target: { values: { q: 'launch' } } });
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal(calls.at(-1).route, '/api/memory/search');
  assert.equal(calls.at(-1).body.agent_id, 'research-b');
  assert.equal(calls.at(-1).body.query, 'launch');

  const before = calls.length;
  picker.value = 'ops-a';
  picker.listeners.change({ target: picker });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, before, 'a different desk cannot be selected through the desk picker');

  run('closeMemory()');
  $('#open-memory').onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal($('#memory-agent-row').hidden, true);
  assert.equal(calls.at(-1).route, '/api/memory?agent_id=ops-a');
});
