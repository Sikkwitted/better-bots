import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const avatarSource = fs.readFileSync(new URL('../web/avatar.js', import.meta.url), 'utf8');

function harness() {
  const document = { activeElement: null };
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = { setProperty() {} }; this.className = ''; this.srcWrites = 0; }
    get classList() { return { contains: (s) => this.className.split(' ').includes(s), add: (s) => { if (!this.classList.contains(s)) this.className += ` ${s}`; }, toggle: (s, on) => { this.className = this.className.split(' ').filter((x) => x !== s).concat(on ? [s] : []).join(' '); } }; }
    get firstChild() { return this.children[0] ?? null; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
    get childElementCount() { return this.children.length; }
    get textContent() { return this.children.length ? this.children.map((n) => n.textContent).join('') : this.text ?? ''; }
    set textContent(s) { this.replaceChildren(); this.text = String(s); }
    get src() { return this.attributes.src; }
    set src(s) { this.srcWrites++; this.attributes.src = s; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    remove() { if (this.contains(document.activeElement)) document.activeElement = null; if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }
    insertBefore(n, ref) { if (n === ref) return; n.remove(); const i = ref ? this.children.indexOf(ref) : this.children.length; this.children.splice(i, 0, n); n.parentNode = this; }
    replaceChildren(...nodes) { for (const n of [...this.children]) n.remove(); this.append(...nodes); this.text = ''; }
    querySelector(sel) { const matches = (n) => sel.startsWith('.') ? n.classList.contains(sel.slice(1)) : n.tagName === sel.toUpperCase(); for (const n of this.children) { if (matches(n)) return n; const child = n.querySelector(sel); if (child) return child; } return null; }
    focus() { document.activeElement = this; }
  }
  document.createElement = (tag) => new Node(tag);
  const nodes = new Map();
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, new Node('div')); return nodes.get(sel); };
  $('#jobs-panel').hidden = true;
  const state = { agents: [{ id: 'a', name: 'Ada', desk: 'One' }, { id: 'b', name: 'Bea', desk: 'Two' }], rooms: [], selected: 'a', selectedKind: 'agent' };
  const clicks = [], menus = [];
  const context = vm.createContext({ startingRooms: new Set(), renderQuickReasoning() {}, desktopViewer: {update() {}}, requestAnimationFrame() {}, followTranscript() {}, document, $, state, localStorage: { getItem: () => null, setItem() {} }, modelCatalog: { data: { providers: [] } }, modelLabel: () => 'model', toggleSettings: (a) => clicks.push(a), select: (...args) => clicks.push(args), openDeskMemory: (desk) => clicks.push({ deskMemory: desk }), agentMenu: (a) => a, roomMenu: (r) => r, openMenu: (e, a) => menus.push(a), inboxChip: () => new Node('span') });
  vm.runInContext(avatarSource.replaceAll('export ', ''), context);
  vm.runInContext(source.slice(source.indexOf('const el ='), source.indexOf('const state =')), context);
  vm.runInContext(source.slice(source.indexOf('function agentById'), source.indexOf('// ----------------------------------------------------------------- avatars')), context);
  vm.runInContext(source.slice(source.indexOf('function agentFace'), source.indexOf('// ------------------------------------------------------------ context menu')), context);
  vm.runInContext(source.slice(source.indexOf('function memberFaces('), source.indexOf('function select(')), context);
  vm.runInContext(source.slice(source.indexOf('function renderHead()'), source.indexOf('// -------------------------------------------------------------- transcript')), context);
  const run = (s) => vm.runInContext(s, context);
  return { document, $, state, clicks, menus, run, render: () => run('renderAgents(); renderHead();') };
}

test('header face survives thought/inbox/phase refreshes and clicks edit current state', () => {
  const h = harness(); h.render();
  const button = h.$('#chat-title').querySelector('button'), img = button.querySelector('img');
  button.focus(); const writes = img.srcWrites;
  h.state.agents[0] = { ...h.state.agents[0], name: 'Ada updated', inbox: 2, active_run: { thought: 'typing now', lane: 'chat' } };
  h.render();
  assert.equal(h.$('#chat-title').querySelector('button'), button);
  assert.equal(button.querySelector('img'), img);
  assert.equal(h.document.activeElement, button);
  assert.equal(img.srcWrites, writes, 'non-visual state does not reload the face');
  assert.equal(button.getAttribute('aria-label'), "Change Ada updated's avatar");
  button.onclick(); assert.equal(h.clicks.at(-1), h.state.agents[0]);
  h.state.agents[0].active_run.phase = 'typing'; h.render();
  assert.equal(button.querySelector('img'), img); assert.equal(img.srcWrites, writes, 'a phase is a class, not a new file');
  assert.equal(img.classList.contains('is-typing'), true); assert.match(img.src, /\.png\?v=/);
  h.render(); assert.equal(img.srcWrites, writes);
  h.state.agents[0].color = '#FE3E51'; h.render(); assert.equal(img.srcWrites, writes + 1);
  assert.equal(img.classList.contains('is-typing'), true);
  h.state.selected = 'b'; h.render(); h.$('#chat-title').querySelector('button').onclick();
  assert.equal(h.clicks.at(-1), h.state.agents[1]);
});

test('roster rows and desk dividers stay attached while labels, selection and menus update', () => {
  const h = harness(); h.render();
  const list = h.$('#agent-list'), divider = list.children[0], button = list.children[1].firstChild, img = button.querySelector('img');
  const other = list.children[3]; button.focus();
  h.render(); assert.equal(list.children[0], divider); assert.equal(h.document.activeElement, button);
  const writes = img.srcWrites;
  h.state.agents[0] = { ...h.state.agents[0], name: 'Renamed', role: 'New role', pinned: true, pin_scope: 'desk', inbox: 3, active_run: { lane: 'chat', thought: 'hi' } };
  h.state.selected = 'b'; h.render();
  assert.equal(list.children[1].firstChild, button); assert.equal(button.querySelector('img'), img);
  assert.equal(h.document.activeElement, button); assert.equal(list.children[3], other);
  assert.equal(img.srcWrites, writes); assert.equal(button.getAttribute('aria-current'), 'false');
  assert.match(button.textContent, /RenamedNew role/); assert.match(button.textContent, /✉ 3/);
  button.onclick(); assert.deepEqual(h.clicks.at(-1), ['agent', 'a']);
  button.oncontextmenu({ preventDefault() {} }); assert.equal(h.menus.at(-1), h.state.agents[0]);
  h.state.agents[0].active_run.phase = 'typing'; h.render(); assert.equal(button.querySelector('img'), img); assert.equal(img.srcWrites, writes);
  assert.equal(img.classList.contains('is-typing'), true);
  h.state.agents[0].active_run.phase = 'thinking'; h.render();
  assert.equal(img.classList.contains('is-thinking'), true); assert.equal(img.classList.contains('is-typing'), false);
  h.state.agents[1].inbox = 9; h.render(); assert.equal(h.document.activeElement, button);
  divider.firstChild.onclick(); assert.equal(list.children[0], divider); assert.match(divider.textContent, /One · 1/);
  divider.firstChild.onclick(); assert.equal(list.children[1].firstChild, button);
});

test('adding/removing a row does not detach an unaffected focused row; rail pins remain live', () => {
  const h = harness(); h.state.agents[0] = { ...h.state.agents[0], pinned: true, pin_scope: 'rail' }; h.render();
  const pinned = h.$('#pinned-list').firstChild.firstChild, img = pinned.querySelector('img'); pinned.focus();
  h.state.agents.push({ id: 'c', name: 'Cee', pinned: true, pin_scope: 'rail', pinned_at: 'later' }); h.render();
  assert.equal(h.document.activeElement, pinned);
  h.state.agents[0] = { ...h.state.agents[0], inbox: 7, active_run: { phase: 'typing', lane: 'chat' } }; h.render();
  assert.equal(h.$('#pinned-list').firstChild.firstChild, pinned); assert.equal(pinned.querySelector('img'), img);
  assert.equal(h.document.activeElement, pinned);
  h.state.agents.pop(); h.render(); assert.equal(h.document.activeElement, pinned);
  h.state.agents[0].pin_scope = 'desk'; h.render();
  assert.equal(h.$('#agent-list').children[1].firstChild, pinned, 'pin scope changes reuse the agent row');
  assert.equal(pinned.querySelector('img'), img);
  h.state.agents[0].active_run = null; h.render();
  assert.equal(pinned.querySelector('.working-bubble'), null);
  assert.equal(img.classList.contains('pulsing'), false);
});

for (const pinned of [false, true]) {
  test(`group rows retain controls and member faces with current profiles (pinned=${pinned})`, () => {
    const h = harness();
    h.state.rooms = [{ id: 'r', purpose: 'Team', member_ids: ['a', 'b'], pinned }];
    const render = () => h.run('renderAgents(); renderRooms();');
    const list = () => h.$(h.state.rooms[0].pinned ? '#pinned-list' : '#room-list');
    render();
    const button = list().firstChild.firstChild, faces = button.querySelector('.members-row');
    const [a, b] = faces.children, writes = a.srcWrites;
    button.focus(); render();
    assert.equal(list().firstChild.firstChild, button);
    assert.equal(h.document.activeElement, button);
    h.state.agents[0] = { ...h.state.agents[0], active_run: { thought: 'new thought' } };
    render();
    assert.equal(button.querySelector('img'), a); assert.equal(a.srcWrites, writes);
    assert.equal(a.classList.contains('pulsing'), true);
    h.state.agents[0] = { ...h.state.agents[0], name: 'Renamed', color: '#FE3E51', active_run: { phase: 'typing' } };
    h.state.rooms[0] = { ...h.state.rooms[0], purpose: 'New team', memory: 'members' };
    render();
    assert.equal(list().firstChild.firstChild, button); assert.equal(button.querySelector('img'), a);
    assert.equal(a.title, 'Renamed'); assert.equal(a.srcWrites, writes + 1);
    assert.match(button.textContent, /New teamRenamed, Bea · private/);
    assert.equal(h.document.activeElement, button);
    assert.equal(a.classList.contains('is-typing'), true);
    render(); assert.equal(a.srcWrites, writes + 1);
    h.state.rooms[0] = { ...h.state.rooms[0], extra: 'current object' }; render();
    button.oncontextmenu({ preventDefault() {} }); assert.equal(h.menus.at(-1), h.state.rooms[0]);
    button.onclick(); assert.deepEqual(h.clicks.at(-1), ['room', 'r']);
    h.state.rooms[0].pinned = !pinned; render();
    assert.equal(list().firstChild.firstChild, button); assert.equal(button.querySelector('img'), a);
    h.state.rooms[0].member_ids = ['b', 'a', 'unknown']; render();
    assert.deepEqual(faces.children.slice(0, 2), [b, a]); assert.equal(faces.children[2].title, 'unknown');
    h.state.rooms[0].member_ids = ['a']; render(); assert.deepEqual(faces.children, [a]);
    h.state.agents[0].active_run = null; render(); assert.equal(a.srcWrites, writes + 1);
    assert.equal(a.classList.contains('pulsing'), false); assert.equal(a.classList.contains('is-typing'), false);
  });
}

test('room header member images survive refreshes and update in membership order', () => {
  const h = harness();
  h.state.rooms = [{ id: 'r', purpose: 'Team', member_ids: ['a', 'b'] }];
  h.state.selectedKind = 'room'; h.state.selected = 'r'; h.render();
  const title = h.$('#chat-title'), faces = title.querySelector('.members-row'), [a, b] = faces.children;
  const writes = a.srcWrites;
  h.state.agents[0].active_run = { thought: 'hi' }; h.render();
  assert.equal(title.querySelector('.members-row'), faces); assert.equal(faces.firstChild, a);
  assert.equal(a.srcWrites, writes);
  h.state.agents[0].name = 'Renamed'; h.state.agents[0].active_run.phase = 'typing';
  h.state.rooms[0].memory = 'members'; h.state.rooms[0].purpose = 'Updated'; h.render();
  assert.equal(faces.firstChild, a); assert.equal(a.srcWrites, writes); assert.equal(a.title, 'Renamed');
  assert.equal(a.classList.contains('is-typing'), true);
  assert.match(title.textContent, /UpdatedRenamed, Bea · private to members/);
  h.render(); assert.equal(a.srcWrites, writes);
  h.state.rooms[0].member_ids = ['b', 'a']; h.render(); assert.deepEqual(faces.children, [b, a]);
  h.state.selectedKind = 'agent'; h.state.selected = 'a'; h.render(); assert.ok(title.querySelector('button'));
});

test('an agent saved with the retired bald hair renders the default haired face', () => {
  const h = harness(); h.state.agents[0].hair = 'none'; h.render();
  const button = h.$('#chat-title').firstChild, img = button.firstChild;
  assert.doesNotMatch(img.src, /bald/); assert.match(img.src, /^\/avatars\/avatar-round-plain-51FFCD\.png\?v=/);
  assert.equal(img.onerror, undefined, 'no fallback handler is needed');
  const writes = img.srcWrites;
  h.state.agents[0] = { ...h.state.agents[0], active_run: { thought: 'more' } }; h.render();
  assert.equal(img.srcWrites, writes);
  assert.equal(img.classList.contains('pulsing'), true);
  h.state.agents[0].hair = 'dark'; h.render();
  assert.equal(button.firstChild, img); assert.equal(img.srcWrites, writes, 'none and dark are the same face');
  h.state.selected = null; h.render(); assert.match(h.$('#chat-title').textContent, /No bot selected/);
  h.state.selected = 'a'; h.render(); h.$('#chat-title').firstChild.onclick();
  assert.equal(h.clicks.at(-1), h.state.agents[0]);
});


test('a saved folded desk cannot hide the last remaining unpinned agent', () => {
  const h = harness();
  h.state.agents = [
    { ...h.state.agents[0], id: 'morgan', name: 'Morgan', desk: '', pinned: true, pinned_at: '2026-09-01', pin_scope: 'rail' },
    { ...h.state.agents[0], id: 'riley', name: 'Riley', desk: '', pinned: false, pinned_at: null, pin_scope: null },
    { ...h.state.agents[0], id: 'removed', name: 'Removed', desk: 'Old team', pinned: false, pin_scope: null },
  ];
  h.run("foldedDesks.add(''); renderAgents();");
  assert.ok(!h.$('#agent-list').textContent.includes('Riley'));
  h.state.agents.pop();
  h.run('renderAgents();');
  assert.ok(h.$('#agent-list').textContent.includes('Riley'));
});

test('every visible desk offers Memory, even a single desk or one with only a rail-pinned agent', () => {
  const h = harness(); h.render();
  const list = h.$('#agent-list');
  assert.equal(list.children[0].children[1].getAttribute('aria-label'), 'Open One desk memory');
  assert.equal(list.children[2].children[1].getAttribute('aria-label'), 'Open Two desk memory');
  list.children[2].children[1].onclick();
  assert.deepEqual(h.clicks.at(-1), { deskMemory: 'Two' });
  h.state.agents = [{ ...h.state.agents[0], pin_scope: 'rail', pinned: true }];
  h.render();
  assert.equal(list.children.length, 1);
  assert.equal(list.firstChild.children[1].getAttribute('aria-label'), 'Open One desk memory');
  list.firstChild.children[1].onclick();
  assert.deepEqual(h.clicks.at(-1), { deskMemory: 'One' });
});
