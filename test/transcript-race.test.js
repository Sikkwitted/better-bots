import { presentChatEntries, groupChatActivity, withApprovalStatus, roomProgress } from '../web/chat-presentation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the shipped transcript loader with deferred HTTP responses. The DOM
// substitute records visible entries; layout/scroll behavior is tested separately.
function transcript() {
  const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('// -------------------------------------------------------------- transcript');
  const end = source.indexOf('// Re-rendering must not close', start);
  if (start < 0 || end < start) throw new Error('Transcript section boundaries not found');

  function node(tag = 'div', text = '') {
    return {
      tag, text, children: [], dataset: {}, style: {}, listeners: {},
      scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
      append(...children) {
        for (const child of children) {
          if (child.tag === 'fragment') this.append(...child.children);
          else this.children.push(child);
        }
      },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(name, handler) { this.listeners[name] = handler; },
    };
  }
  const view = node();
  view.id = 'transcript';
  const content = node();
  content.id = 'transcript-content';
  view.append(content);
  function find(id, root = view) {
    if (root.id === id) return root;
    for (const child of root.children) {
      const found = find(id, child);
      if (found) return found;
    }
    return null;
  }
  const frames = [];
  const observers = [];
  const requests = [];
  const state = { selected: 'agt_a', selectedKind: 'agent' };
  const context = vm.createContext({ presentChatEntries, groupChatActivity, withApprovalStatus, roomProgress,
    state,
    $: (selector) => find(selector.slice(1)),
    document: {
      createDocumentFragment: () => node('fragment'),
      createElement: (tag) => node(tag),
    },
    window: { addEventListener() {} },
    el: (tag, _className, text) => node(tag, text),
    renderEntry: (entry) => ({ ...node('message', entry.text), entryId: entry.id }),
    workingGroup: () => node('details'),
    agentById: (id) => ({ id, name: id, active_run: null }),
    api: (method, route) => new Promise((resolve) => requests.push({ method, route, resolve })),
    ResizeObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {}, setTimeout, clearTimeout,
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    state, requests, view,
    resize: () => observers.forEach((callback) => callback()),
    event: (name, detail = {}) => view.listeners[name]?.(detail),
    load: () => vm.runInContext('loadTranscript()', context),
    messages() {
      while (frames.length) frames.shift()();
      const texts = [];
      function visit(root) {
        if (root.tag === 'message') texts.push(root.text);
        root.children.forEach(visit);
      }
      visit(view);
      return texts;
    },
  };
}

const message = (id, text) => ({ id, kind: 'user_message', text });

test('switching agents keeps the selected conversation when an earlier response arrives last', async () => {
  const ui = transcript();
  const previous = ui.load();
  ui.state.selected = 'agt_b';
  const selected = ui.load();

  ui.requests[1].resolve({ entries: [message('b1', 'Message for B')] });
  await selected;
  assert.deepEqual(ui.messages(), ['Message for B']);

  ui.requests[0].resolve({ entries: [message('a1', 'Stale message for A')] });
  await previous;
  assert.deepEqual(ui.messages(), ['Message for B'], 'a late response must not replace the selected agent\'s messages');
});

test('overlapping refreshes cannot replace a newer transcript with an older snapshot', async () => {
  const ui = transcript();
  const older = ui.load();
  const newer = ui.load();

  ui.requests[1].resolve({ entries: [message('a1', 'Earlier message'), message('a2', 'Newest message')] });
  await newer;
  assert.deepEqual(ui.messages(), ['Earlier message', 'Newest message']);

  ui.requests[0].resolve({ entries: [message('a1', 'Earlier message')] });
  await older;
  assert.deepEqual(ui.messages(), ['Earlier message', 'Newest message'], 'out-of-order completion must not remove the latest message');
});

test('layout-generated scroll events keep following the bottom when the thinking panel grows', () => {
  const ui = transcript();
  ui.view.scrollTop = 600;
  ui.view.clientHeight = 300;
  ui.event('scroll');
  ui.resize();
  ui.messages();
  assert.equal(ui.view.dataset.stick, '1', 'layout changes must not count as the reader scrolling up');
  assert.equal(ui.view.scrollTop, ui.view.scrollHeight);
});

test('deliberate upward scrolling pauses following until the reader returns to the bottom', () => {
  const ui = transcript();
  ui.view.scrollTop = 600;
  ui.event('wheel', { deltaY: -120 });
  ui.view.scrollTop = 350;
  ui.event('scroll');
  ui.resize();
  ui.messages();
  assert.equal(ui.view.dataset.stick, '0');
  assert.equal(ui.view.scrollTop, 350, 'reading older messages must survive a layout resize');
  ui.event('wheel', { deltaY: 300 });
  ui.view.scrollTop = 600;
  ui.event('scroll');
  assert.equal(ui.view.dataset.stick, '1');
});
