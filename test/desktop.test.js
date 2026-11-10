import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';
import { call, oneStep, say, tmpDir } from './helpers.js';
import { detectDesktopBackend, displayFor, PlaceholderDesktop, SCREEN_ACTIONS, vncPortFor, viewingInstructions, xdotoolArgs, XvfbDesktop } from '../src/services/desktop-backend.js';

// This machine is the shared sandbox computer,
// each monitor is a display on it with its own loopback VNC endpoint, and the
// ownership gate runs before the backend ever sees an action.

class FakeDesktop {
  constructor() { this.kind = 'fake'; this.calls = []; this.shots = 0; }
  vncUrl(index) { return `vnc://fake/${index}`; }
  async ensureMonitor(index) { this.calls.push(['ensure', index]); return { index, real: true, vnc_url: this.vncUrl(index), view: 'tunnel then vnc' }; }
  async perform(index, action, detail) { this.calls.push(['perform', index, action, detail]); this.shots += 1; return { performed: true, screenshot: `window-${index}-${this.shots}.png` }; }
  release(index) { this.calls.push(['release', index]); }
  async shutdown() { this.calls.push(['shutdown']); }
}

function hostWith(desktop, script) {
  const dir = tmpDir();
  const host = new Host({ dir, adapter: new ScriptedAdapter(oneStep(script)), clock: fixedClock(), window_count: 2, desktop });
  for (const id of ['agt_a', 'agt_b']) host.registry.create({ id, profile: { name: id.toUpperCase() } });
  return host;
}

test('display and port numbering never collide between monitors', () => {
  assert.equal(displayFor(0), ':10');
  assert.equal(displayFor(2), ':12');
  assert.equal(vncPortFor(0), 5900);
  assert.equal(vncPortFor(2), 5902);
  assert.match(viewingInstructions(1, 'alex@vps'), /-L 5901:127\.0\.0\.1:5901 alex@vps.*vnc:\/\/127\.0\.0\.1:5901/);
});

test('computer-use actions map to exact xdotool invocations and reject nonsense', () => {
  assert.deepEqual(xdotoolArgs('click', { x: 10.4, y: 20 }), ['mousemove', '10', '20', 'click', '1']);
  assert.deepEqual(xdotoolArgs('click', { button: 'right' }), ['click', '3']);
  assert.deepEqual(xdotoolArgs('type', { text: 'hello' }), ['type', '--delay', '20', '--', 'hello']);
  assert.deepEqual(xdotoolArgs('key', { key: 'ctrl+l' }), ['key', 'ctrl+l']);
  assert.throws(() => xdotoolArgs('key', { key: 'rm -rf /' }), /keysym/);
  assert.throws(() => xdotoolArgs('click', { x: 'a', y: 1 }), /number/);
  assert.throws(() => xdotoolArgs('dance'), /no xdotool mapping/);
  assert.deepEqual(SCREEN_ACTIONS, ['screenshot', 'open_url', 'click', 'type', 'key', 'move']);
});

test('the backend is chosen honestly: real displays only where the tools exist', () => {
  const all = () => true;
  const none = () => false;
  assert.equal(detectDesktopBackend({ platform: 'linux', env: {}, which: all }), 'xvfb');
  assert.equal(detectDesktopBackend({ platform: 'linux', env: {}, which: none }), 'placeholder');
  assert.equal(detectDesktopBackend({ platform: 'darwin', env: {}, which: all }), 'placeholder');
  assert.equal(detectDesktopBackend({ platform: 'linux', env: { BETTER_BOTS_DESKTOP: 'placeholder' }, which: all }), 'placeholder');
  assert.equal(detectDesktopBackend({ platform: 'darwin', env: { BETTER_BOTS_DESKTOP: 'xvfb' }, which: none }), 'xvfb');
});

test('the placeholder backend says plainly that it draws nothing', async () => {
  const backend = new PlaceholderDesktop({ vnc_base: 'vnc://sandbox-1' });
  assert.equal(backend.vncUrl(1), 'vnc://sandbox-1/window/1');
  assert.equal((await backend.ensureMonitor(1)).real, false);
  const outcome = await backend.perform(1, 'click');
  assert.equal(outcome.performed, false);
  assert.match(outcome.note, /bookkeeping/);
});

test('OpenScreen brings the monitor up and tells the person how to view it', async () => {
  const desktop = new FakeDesktop();
  const host = hostWith(desktop, () => [call('OpenScreen', {})]);
  host.userRequest({ agent_id: 'agt_a', text: 'open a screen' });
  await host.drain();
  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.name === 'OpenScreen').result;
  assert.equal(result.ok, true);
  assert.equal(result.live, true);
  assert.equal(result.vnc_url, 'vnc://fake/0');
  assert.equal(result.view, 'tunnel then vnc');
  assert.deepEqual(desktop.calls, [['ensure', 0]]);
  assert.equal(host.computer.describe().desktop, 'fake');
});

test('UseScreen drives the display through the backend and records the screenshot', async () => {
  const desktop = new FakeDesktop();
  const host = hostWith(desktop, (ctx) => {
    const window = host.computer.assignments().find((w) => w.agent_id === ctx.agent_id);
    return window
      ? [call('UseScreen', { window_index: window.window_index, owner_token: window.owner_token, action: 'open_url', detail: { url: 'https://example.com' } })]
      : [call('OpenScreen', {})];
  });
  host.userRequest({ agent_id: 'agt_a', text: 'open' });
  await host.drain();
  host.userRequest({ agent_id: 'agt_a', text: 'browse' }); // runs without a card by default
  await host.drain();
  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.name === 'UseScreen').result;
  assert.equal(result.ok, true);
  assert.equal(result.performed, true);
  assert.equal(result.screenshot, 'window-0-1.png');
  assert.deepEqual(desktop.calls.at(-1), ['perform', 0, 'open_url', { url: 'https://example.com' }]);
  assert.equal(host.computer.assignments()[0].last_screenshot, 'window-0-1.png');
  assert.equal(host.status().agents.find((a) => a.id === 'agt_a').window.last_screenshot, 'window-0-1.png');
});

test('window theft is stopped before the backend is touched', async () => {
  const desktop = new FakeDesktop();
  const host = hostWith(desktop, () => [say('ok')]);
  const a = host.computer.assignWindow('agt_a').assignment;
  await assert.rejects(
    host.computer.performWindowAction('agt_b', { window_index: a.window_index, owner_token: a.owner_token, action: 'click', detail: { x: 1, y: 1 } }),
    /does not own window/,
  );
  assert.equal(desktop.calls.some((c) => c[0] === 'perform'), false);
  const failing = { ...desktop, perform: async () => { throw new Error('xdotool exploded'); } };
  Object.setPrototypeOf(failing, FakeDesktop.prototype);
  host.computer.backend = failing;
  const outcome = await host.computer.performWindowAction('agt_a', { window_index: a.window_index, owner_token: a.owner_token, action: 'click', detail: { x: 1, y: 1 } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'screen_action_failed');
  assert.ok(host.audit.where((e) => e.type === 'computer.window_action_failed').length === 1);
});

test('releasing a window hands the monitor back to the backend', async () => {
  const desktop = new FakeDesktop();
  const host = hostWith(desktop, () => [say('ok')]);
  host.computer.assignWindow('agt_a');
  await host.computer.releaseWindow('agt_a');
  assert.deepEqual(desktop.calls.at(-1), ['release', 0]);
});

test('the Xvfb backend spawns exactly the expected processes and screenshots after every action', async () => {
  const spawned = [];
  const executed = [];
  const fakeChild = () => ({ on() {}, kill() { spawned.push('kill'); } });
  const backend = new XvfbDesktop({
    dir: tmpDir(),
    spawn: (command, args) => { spawned.push([command, ...args]); return fakeChild(); },
    execFile: async (command, args) => { executed.push([command, ...args]); return { stdout: '' }; },
    sleep: async () => {},
    browser: 'firefox', isolation: { kind: 'bwrap', bwrap: '/test/bwrap' },
    ssh_target: 'alex@vps',
    probe: async () => true,
  });
  const monitor = await backend.ensureMonitor(1);
  assert.equal(monitor.real, true);
  assert.equal(monitor.vnc_url, 'vnc://127.0.0.1:5901');
  assert.match(monitor.view, /5901/);
  assert.deepEqual(spawned.map((s) => s[0]), ['Xvfb', '/test/bwrap', '/test/bwrap', 'x11vnc']);
  assert.ok(spawned[0].includes(':11') && spawned[0].includes('1280x800x24'));
  assert.ok(spawned[3].includes('-localhost') && spawned[3].includes('5901'));

  const outcome = await backend.perform(1, 'open_url', { url: 'https://example.com' });
  assert.equal(outcome.performed, true);
  assert.match(outcome.screenshot, /^window-1-\d+\.png$/);
  assert.equal(spawned.at(-1)[0], '/test/bwrap');
  assert.ok(spawned.at(-1).includes('--no-remote'));
  assert.deepEqual(spawned.at(-1).slice(-2), ['--new-window', 'https://example.com/']);
  assert.equal(executed.at(-1)[0], 'scrot');

  await backend.perform(1, 'click', { x: 5, y: 6 });
  assert.deepEqual(executed.at(-2), ['xdotool', 'mousemove', '5', '6', 'click', '1']);
  await assert.rejects(backend.perform(1, 'open_url', { url: 'file:///etc/passwd' }), /http or https/);
  await assert.rejects(backend.perform(1, 'dance'), /unknown screen action/);
  assert.equal(path.basename(backend.shots), 'shots');
  await backend.shutdown();
  assert.ok(spawned.filter((s) => s === 'kill').length >= 3);
});

test('agents are told to browse with their real browser only when one exists and is theirs to use', async () => {
  const systemFor = async (desktop, profile = {}) => {
    const adapter = new ScriptedAdapter(oneStep(() => [say('ok')]));
    const host = new Host({ dir: tmpDir(), adapter, clock: fixedClock(), window_count: 1, ...(desktop ? { desktop } : {}) });
    host.registry.create({ id: 'agt_a', profile: { name: 'A', ...profile } });
    host.userRequest({ agent_id: 'agt_a', text: 'look something up' });
    await host.drain();
    return adapter.calls[0].settings.system;
  };
  const hint = /You have your own real web browser/;
  assert.match(await systemFor(new FakeDesktop()), hint);
  assert.doesNotMatch(await systemFor(new PlaceholderDesktop({ vnc_base: 'vnc://x' })), hint, 'a placeholder draws nothing');
  assert.doesNotMatch(await systemFor(new FakeDesktop(), { allowed_tools: ['WebReadPublic'] }), hint, 'scoped out of the browser');
});
