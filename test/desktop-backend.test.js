import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { XvfbDesktop, displayFor } from '../src/services/desktop-backend.js';
import { tmpDir } from './helpers.js';

function browserHarness(onLaunch) {
  const screenshots = [];
  let child;
  const backend = new XvfbDesktop({
    dir: tmpDir(),
    browser: '/opt/browser/firefox',
    spawn: (command, args, options) => {
      child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => onLaunch(child, options));
      return child;
    },
    execFile: async (command, args) => {
      if (command === 'scrot') screenshots.push(args.at(-1));
      return { stdout: '' };
    },
    sleep: async () => {},
  });
  backend.monitors.set(2, { index: 2, ready: true, processes: [] });
  return { backend, screenshots, get child() { return child; } };
}

test('open_url reports an unavailable browser executable instead of successful blank desktop', async () => {
  const { backend, screenshots } = browserHarness((child) => {
    child.emit('error', Object.assign(new Error('spawn /opt/browser/firefox ENOENT'), { code: 'ENOENT' }));
  });
  await assert.rejects(backend.perform(2, 'open_url', { url: 'https://example.com' }), /firefox.*could not start.*ENOENT/);
  assert.equal(screenshots.length, 0);
});

test('open_url preserves bounded browser stderr when launch exits unsuccessfully', async () => {
  const { backend, screenshots } = browserHarness((child) => {
    child.stderr.emit('data', Buffer.from('x'.repeat(10_000)));
    child.stderr.emit('data', Buffer.from('\nsnap-confine: cannot change profile under NoNewPrivileges\n'));
    child.emit('exit', 1, null);
  });
  await assert.rejects(backend.perform(2, 'open_url', { url: 'https://example.com' }), (error) => {
    assert.match(error.message, /firefox.*exited.*1.*snap-confine: cannot change profile under NoNewPrivileges/s);
    assert.ok(error.message.length < 3_000);
    return true;
  });
  assert.equal(screenshots.length, 0);
});

test('open_url reports a browser terminated by signal', async () => {
  const { backend } = browserHarness((child) => child.emit('exit', null, 'SIGKILL'));
  await assert.rejects(backend.perform(2, 'open_url', { url: 'https://example.com' }), /firefox.*SIGKILL/);
});

// On Linux the browser runs inside a sandbox that exposes only /usr and /etc, so
// this real-process case can only launch a Node installed there (a distribution
// or NodeSource package), not one from a version manager or CI's tool cache.
const nodeOutsideSandbox = process.platform === 'linux' && !fs.realpathSync(process.execPath).startsWith('/usr/');

test('a real process rejecting browser arguments reports its exit and stderr', { skip: nodeOutsideSandbox && 'Node is not under /usr, so the sandbox cannot run it' }, async () => {
  let closed;
  // The browser is launched through the filesystem boundary, which binds the
  // display's X socket read-only. No real Xvfb runs in this test — the process
  // rejects its arguments before it would ever open the display — but the
  // socket path has to exist for the bind to succeed, otherwise the container
  // dies with its own "can't find source path" error and the browser's real
  // exit code and stderr never surface. A plain file is enough; take it away
  // again so a real Xvfb can have the display later.
  const socketDir = '/tmp/.X11-unix';
  const socket = `${socketDir}/X${displayFor(2).slice(1)}`;
  const createdSocket = !fs.existsSync(socket);
  if (createdSocket) {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o1777 });
    fs.writeFileSync(socket, '');
  }
  try {
    const backend = new XvfbDesktop({
      dir: tmpDir(),
      browser: process.execPath,
      spawn: (...args) => {
        const child = spawn(...args);
        closed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('The test process did not close within two seconds.')), 2_000);
          child.once('close', () => { clearTimeout(timer); resolve(); });
        });
        return child;
      },
      sleep: async () => closed,
      execFile: async () => { throw new Error('A failed browser must not produce a successful screenshot.'); },
    });
    backend.monitors.set(2, { index: 2, ready: true, processes: [] });
    await assert.rejects(backend.perform(2, 'open_url', { url: 'https://example.com' }), /exited.*exit 9.*bad option: --new-window/s);
  } finally {
    if (createdSocket) fs.rmSync(socket, { force: true });
  }
});

test('open_url keeps a live browser and a clean handoff to an existing browser successful', async () => {
  for (const cleanHandoff of [false, true]) {
    const { backend, screenshots } = browserHarness((child) => {
      if (cleanHandoff) child.emit('exit', 0, null);
    });
    const result = await backend.perform(2, 'open_url', { url: 'https://example.com' });
    assert.equal(result.performed, true);
    assert.equal(result.display, ':12');
    assert.equal(screenshots.length, 1);
  }
});
test('second Firefox URL navigates the owned window without spawning a locked-profile process', async () => {
 let launches = 0;
 const {backend}=browserHarness(()=>launches++);
 const commands=[];
 backend.execFile=async(command,args)=>{commands.push(args);return {stdout:args[0]==='search'&&launches?'12345\n':''};};
 await backend.perform(2,'open_url',{url:'https://example.com/first'});
 await backend.perform(2,'open_url',{url:'https://example.com/second'});
 assert.equal(launches,1);
 assert.ok(commands.some(args=>args.includes('https://example.com/second')));
 assert.ok(commands.some(args=>args.includes('12345')&&args.includes('ctrl+l')));
});

test('a browser opened from the desktop icon is reused by the bot',async()=>{
 let launches=0;const {backend}=browserHarness(()=>launches++);const commands=[];
 backend.execFile=async(command,args)=>{commands.push(args);return {stdout:args[0]==='search'?'12345\n':''};};
 await backend.perform(2,'open_url',{url:'https://example.com/from-desktop'});
 assert.equal(launches,0);
 assert.ok(commands.some(args=>args.includes('https://example.com/from-desktop')));
});


test('Stop between browser navigation steps prevents typing and submitting the URL', async () => {
  const { backend } = browserHarness(() => {});
  const controller = new AbortController();
  const calls = [];
  backend.execFile = async (command, args, options) => {
    calls.push(args);
    assert.equal(options.signal, controller.signal);
    if (args[0] === 'search') return { stdout: '123' };
    if (args[0] === 'windowactivate') controller.abort(new Error('stopped'));
    options.signal.throwIfAborted();
    return { stdout: '' };
  };
  await assert.rejects(backend.perform(2, 'open_url', { url: 'https://example.com' }, { signal: controller.signal }), /stopped/);
  assert.equal(calls.length, 2);
});

test('Stop interrupts a pending desktop paint wait', async () => {
  const { backend } = browserHarness(() => {});
  const controller = new AbortController();
  backend.sleep = () => new Promise(() => {});
  backend.execFile = async () => { queueMicrotask(() => controller.abort(new Error('stopped'))); return { stdout: '' }; };
  await assert.rejects(backend.perform(2, 'click', { x: 1, y: 1 }, { signal: controller.signal }), /stopped/);
});
