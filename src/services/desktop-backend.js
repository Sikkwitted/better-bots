import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { prepareDesktopHome } from './desktop-home.js';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopCommand } from './process-boundary.js';
import { detectIsolation, scrubbedEnvironment } from '../tools/shell-tool.js';
import { DockerDesktop } from './docker-desktop.js';

// This machine IS the shared sandbox
// computer. A monitor is an X display on it with its own VNC endpoint, bound to
// loopback so it is reached over the same SSH tunnel as the console. Files and
// the terminal stay shared; only the screens are separate. No
// containers: isolation of the file system is a different layer, and pretending
// a screen provides it would be fake computer isolation.
//
// Two backends share one contract:
//   PlaceholderDesktop  bookkeeping only (macOS, tests, hosts without X tools)
//   XvfbDesktop         real displays: Xvfb + fluxbox + x11vnc, driven by xdotool

function waitForPaint(sleep, ms, signal) {
  signal?.throwIfAborted();
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return sleep(ms); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export const DESKTOP_TOOLS = ['Xvfb', 'x11vnc', 'xdotool', 'scrot', 'fluxbox', 'pcmanfm', 'xterm', 'dbus-run-session'];
export const SCREEN_ACTIONS = ['screenshot', 'open_url', 'click', 'type', 'key', 'move'];
const FIRST_DISPLAY = 10;
const FIRST_VNC_PORT = 5900;

// A monitor writes one PNG per action and nothing ever removed them, so on an
// unattended box this directory grew until the disk was full. Rolling cap: keep
// the newest N per monitor. Sorted by mtime so it is chronological for every
// naming scheme (Xvfb stamps an epoch; Docker stamps a UUID).
const DEFAULT_SHOTS_KEPT = 48;

/**
 * Best-effort pruning. Never throws: a failed unlink must not take the
 * screenshot it was cleaning up after down with it. Returns what it removed.
 */
export function pruneShots(dir, prefix, keep = DEFAULT_SHOTS_KEPT) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const ours = names.filter((name) => name.startsWith(prefix));
  if (ours.length <= keep) return [];
  const stamped = ours
    .map((name) => {
      let mtime = 0;
      try { mtime = Number(fs.statSync(path.join(dir, name), { bigint: true }).mtimeNs) / 1e6; } catch { /* unreadable */ }
      return { name, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);
  const dropped = stamped.slice(0, ours.length - keep).map((entry) => entry.name);
  for (const name of dropped) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
  }
  return dropped;
}

export function displayFor(index) {
  return `:${FIRST_DISPLAY + index}`;
}

export function vncPortFor(index) {
  return FIRST_VNC_PORT + index;
}

export function probeVnc(port) {
  return new Promise(resolve => {
    const socket = net.connect({host:'127.0.0.1',port});
    let header = '', settled = false;
    const finish = ready => {if(settled)return;settled=true;socket.destroy();resolve(ready);};
    socket.setTimeout(500,()=>finish(false));
    socket.on('error',()=>finish(false));socket.on('end',()=>finish(false));
    socket.on('data',chunk=>{header+=chunk.toString('ascii');if(header.length>=12)finish(/^RFB \d{3}\.\d{3}\n/.test(header));});
  });
}

/** How a person reaches monitor N from their own machine. */
export function viewingInstructions(index, sshTarget = '<user>@<host>') {
  const port = vncPortFor(index);
  return `ssh -N -L ${port}:127.0.0.1:${port} ${sshTarget}   then open vnc://127.0.0.1:${port}`;
}

/** One computer-use action becomes one xdotool invocation. Pure, so it is testable. */
export function xdotoolArgs(action, detail = {}) {
  const num = (value, label) => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
    return String(Math.round(n));
  };
  switch (action) {
    case 'click': {
      const button = detail.button === 'right' ? '3' : detail.button === 'middle' ? '2' : '1';
      const args = detail.x !== undefined && detail.y !== undefined ? ['mousemove', num(detail.x, 'x'), num(detail.y, 'y')] : [];
      return [...args, 'click', ...(detail.double ? ['--repeat', '2'] : []), button];
    }
    case 'move':
      return ['mousemove', num(detail.x, 'x'), num(detail.y, 'y')];
    case 'type': {
      const text = String(detail.text ?? '');
      if (!text) throw new Error('type needs text');
      return ['type', '--delay', '20', '--', text.slice(0, 4_000)];
    }
    case 'key': {
      const key = String(detail.key ?? '').trim();
      if (!/^[A-Za-z0-9_+]{1,40}$/.test(key)) throw new Error('key must be an X keysym such as Return, Tab, ctrl+l');
      return ['key', key];
    }
    default:
      throw new Error(`no xdotool mapping for ${action}`);
  }
}

export class PlaceholderDesktop {
  constructor({ vnc_base = 'vnc://sandbox-1' } = {}) {
    this.kind = 'placeholder';
    this.vnc_base = vnc_base;
  }

  vncUrl(index) {
    return `${this.vnc_base}/window/${index}`;
  }

  async ensureMonitor(index) {
    return { index, real: false, vnc_url: this.vncUrl(index) };
  }

  async perform(index, action) {
    return {
      performed: false,
      note: `screen ${index} is bookkeeping on this host: no display server is installed, so "${action}" was recorded but nothing was drawn`,
    };
  }

  release() {}

  async shutdown() {}
}

export class XvfbDesktop {
  constructor({
    dir,
    workspace = path.join(dir, 'workspace'),
    isolation = detectIsolation(),
    width = 1280,
    height = 800,
    browser = process.env.BETTER_BOTS_BROWSER ?? 'firefox',
    ssh_target = process.env.BETTER_BOTS_SSH_TARGET ?? '<user>@<host>',
    spawn = nodeSpawn,
    execFile = promisify(nodeExecFile),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    probe = probeVnc,
    shots_kept = Number(process.env.BETTER_BOTS_SHOTS_KEPT) || DEFAULT_SHOTS_KEPT,
  }) {
    this.kind = 'xvfb';
    this.supportsParking = true;
    this.dir = dir;
    this.workspace = workspace;
    fs.mkdirSync(workspace, { recursive: true });
    this.isolation = isolation;
    this.width = width;
    this.height = height;
    this.browser = browser;
    this.ssh_target = ssh_target;
    this.spawn = spawn;
    this.execFile = execFile;
    this.sleep = sleep;
    this.probeVnc = probe;
    this.monitors = new Map();
    this.processStates = new WeakMap();
    this.shots = path.join(dir, 'computer', 'shots');
    this.shots_kept = shots_kept;
    fs.mkdirSync(this.shots, { recursive: true });
  }

  vncUrl(index) {
    return `vnc://127.0.0.1:${vncPortFor(index)}`;
  }

  #env(index) {
    const home = path.join(this.dir, 'computer', 'monitors', String(index), 'home');
    fs.mkdirSync(home, { recursive: true });
    return { ...scrubbedEnvironment({ home, agentId: `monitor_${index}` }), DISPLAY: displayFor(index), HOME: home, XDG_RUNTIME_DIR: home };
  }

  #start(index, command, args, env, { captureStderr = false } = {}) {
    if (command === 'fluxbox' || command === 'dbus-run-session' || command === this.browser) {
      ({ command, args } = desktopCommand({ command, args, home: env.HOME, workspace: this.workspace, display: env.DISPLAY, isolation: this.isolation, browser:this.browser }));
    }
    const child = this.spawn(command, args, { env, stdio: captureStderr ? ['ignore', 'ignore', 'pipe'] : 'ignore', detached: false });
    const state = { error: null, exitCode: null, signal: null, stderr: '' };
    this.processStates.set(child, state);
    if (captureStderr) {
      child.stderr?.on('data', (chunk) => { state.stderr = (state.stderr + chunk.toString()).slice(-4_000); });
      child.stderr?.unref?.();
    }
    // A monitor must not keep the host process alive on its own.
    child.unref?.();
    child.on('exit', (code, signal) => {
      state.exitCode = code;
      state.signal = signal;
      const monitor = this.monitors.get(index);
      if (monitor) monitor.processes = monitor.processes.filter((p) => p !== child);
    });
    child.on('error', (error) => { state.error = error; });
    return child;
  }

  /** Brings a display, a window manager, and its VNC endpoint up, once. */
  async ensureMonitor(index, {agentId} = {}) {
    const existing = this.monitors.get(index);
    if (existing?.ready) return { index, real: true, vnc_url: this.vncUrl(index), display: displayFor(index), view: viewingInstructions(index, this.ssh_target) };
    if (fs.existsSync(`/tmp/.X11-unix/X${String(displayFor(index)).slice(1)}`)) throw new Error('existing_desktop_requires_restart: refusing to adopt processes outside the new filesystem boundary');
    if (!['bwrap', 'seatbelt'].includes(this.isolation.kind)) throw new Error('filesystem_isolation_required: refusing an unprotected desktop');
    if (agentId) {
      const saved = this.savedHome(agentId);
      if (fs.existsSync(saved)) {
        const home = path.join(this.dir, 'computer', 'monitors', String(index), 'home');
        if (fs.existsSync(home)) throw new Error('desktop_profile_conflict: refusing to overwrite a desktop profile');
        fs.mkdirSync(path.dirname(home), {recursive:true});
        fs.renameSync(saved, home);
      }
    }
    const env = this.#env(index);
    const display = displayFor(index);
    fs.mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 });
    const xvfb = this.#start(index, 'Xvfb', [display, '-screen', '0', `${this.width}x${this.height}x24`, '-nolisten', 'tcp', '-ac'], env);
    const monitor = { index, ready: false, processes: [xvfb] };
    this.monitors.set(index, monitor);
    let displayReady = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await this.execFile('xdotool', ['getdisplaygeometry'], { env, timeout: 2_000 });
        displayReady = true;
        break;
      } catch {
        await this.sleep(100);
      }
    }
    if (!displayReady) {
      await this.release(index, {preserveFor:agentId});
      this.monitors.delete(index);
      throw new Error(`display ${display} did not come up`);
    }
    prepareDesktopHome(env.HOME, this.browser);
    monitor.processes.push(this.#start(index, 'fluxbox', [], env));
    monitor.processes.push(this.#start(index, 'dbus-run-session', ['--', 'pcmanfm', '--desktop', '--profile=better-bots'], env, {captureStderr:true}));
    let desktopReady = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await this.execFile('xdotool', ['search', '--onlyvisible', '--class', 'pcmanfm'], {env,timeout:2000});
        desktopReady = true; break;
      } catch { await this.sleep(100); }
    }
    if (!desktopReady) {
      await this.release(index, {preserveFor:agentId});
      throw new Error('Desktop icons and file manager did not start. Reconnect to retry.');
    }
    monitor.processes.push(this.#start(index, 'x11vnc', ['-display', display, '-rfbport', String(vncPortFor(index)), '-localhost', '-forever', '-shared', '-nopw', '-quiet', '-noxdamage'], env));
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await this.probeVnc(vncPortFor(index))) { monitor.ready = true; break; }
      await this.sleep(100);
    }
    if (!monitor.ready) {
      await this.release(index, {preserveFor:agentId});
      throw new Error('Desktop viewing service did not start. Reconnect to retry.');
    }
    return { index, real: true, vnc_url: this.vncUrl(index), display, view: viewingInstructions(index, this.ssh_target) };
  }

  async screenshot(index) {
    const env = this.#env(index);
    const file = path.join(this.shots, `window-${index}-${Date.now()}.png`);
    await this.execFile('scrot', ['--overwrite', file], { env, timeout: 10_000 });
    pruneShots(this.shots, `window-${index}-`, this.shots_kept);
    return path.basename(file);
  }

  /** Drives one monitor; every action ends with a screenshot so the record shows what happened. */
  async perform(index, action, detail = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (!SCREEN_ACTIONS.includes(action)) throw new Error(`unknown screen action ${action}; use one of ${SCREEN_ACTIONS.join(', ')}`);
    await this.ensureMonitor(index);
    signal?.throwIfAborted();
    const env = this.#env(index);
    if (action === 'open_url') {
      const url = new URL(String(detail.url ?? ''));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('open_url needs an http or https URL');
      const monitor = this.monitors.get(index);
      const previous = monitor.browser && this.processStates.get(monitor.browser);
      let window;
      if (this.browser.includes('firefox')) {
        try {
          const {stdout} = await this.execFile('xdotool', ['search', '--onlyvisible', '--class', 'firefox'], {env,timeout:10_000,signal});
          window = String(stdout).trim().split(/\s+/).find(id => /^\d+$/.test(id));
        } catch { /* No visible browser yet. */ }
        if (!window && previous && !previous.error && previous.exitCode === null && !previous.signal) throw new Error('Firefox is running but has no visible window to navigate');
      }
      signal?.throwIfAborted();
      if (window) {
        await this.execFile('xdotool', ['windowactivate', '--sync', window, 'key', '--clearmodifiers', 'ctrl+l'], { env, timeout: 10_000, signal });
        await this.execFile('xdotool', xdotoolArgs('type', { text: url.toString() }), { env, timeout: 10_000, signal });
        await this.execFile('xdotool', ['key', '--clearmodifiers', 'Return'], { env, timeout: 10_000, signal });
        await waitForPaint(this.sleep, Math.min(10_000, Math.max(0, Number(detail.wait_ms) || 4_000)), signal);
        signal?.throwIfAborted();
        return { performed: true, display: displayFor(index), screenshot: await this.screenshot(index) };
      }
      fs.mkdirSync(path.join(env.HOME, 'browser-profile'), { recursive: true });
      const browser = this.#start(index, this.browser, [...(this.browser.includes('firefox') ? ['--no-remote', '--profile', path.join(env.HOME, 'browser-profile')] : []), '--new-window', url.toString()], env, { captureStderr: true });
      monitor.processes.push(browser);
      monitor.browser = browser;
      await waitForPaint(this.sleep, Math.min(10_000, Math.max(0, Number(detail.wait_ms) || 4_000)), signal);
      signal?.throwIfAborted();
      const started = this.processStates.get(browser);
      if (started.error) {
        throw new Error(`${this.browser} could not start on display ${displayFor(index)}: ${started.error.code ?? ''} ${started.error.message}`.slice(0, 2_000));
      }
      if (started.signal || (started.exitCode !== null && started.exitCode !== 0)) {
        const reason = started.signal ? `signal ${started.signal}` : `exit ${started.exitCode}`;
        const stderr = started.stderr.trim().slice(-2_000);
        throw new Error(`${this.browser} exited before opening the browser on display ${displayFor(index)} (${reason})${stderr ? `: ${stderr}` : ''}`);
      }
      // A clean launcher exit can mean the URL was handed to an existing browser.
    } else if (action !== 'screenshot') {
      await this.execFile('xdotool', xdotoolArgs(action, detail), { env, timeout: 10_000, signal });
      await waitForPaint(this.sleep, Math.min(10_000, Math.max(0, Number(detail.wait_ms) || 500)), signal);
      signal?.throwIfAborted();
    }
    const screenshot = await this.screenshot(index);
    return { performed: true, display: displayFor(index), screenshot };
  }

  savedHome(agentId) {
    return path.join(this.dir, 'computer', 'parked', crypto.createHash('sha256').update(agentId).digest('hex'), 'home');
  }

  async release(index, {preserveFor} = {}) {
    const monitor = this.monitors.get(index);
    // Never erase a profile while an orphaned display may still have it open.
    if (!monitor && fs.existsSync(`/tmp/.X11-unix/X${String(displayFor(index)).slice(1)}`)) {
      throw new Error('desktop_cleanup_required: orphaned display must exit before reassignment');
    }
    await Promise.all((monitor?.processes ?? []).map(child => new Promise((resolve, reject) => {
      const state = this.processStates.get(child);
      if (state && (state.error || state.exitCode !== null || state.signal)) return resolve();
      if (!child.once) { child.kill('SIGTERM'); return resolve(); } // injected test process
      const timer = setTimeout(() => {
        child.removeListener('exit', done);
        reject(new Error('desktop_cleanup_required: process did not exit'));
      }, 2000);
      const done = () => { clearTimeout(timer); resolve(); };
      child.once('exit', done);
      try { child.kill('SIGTERM'); } catch (error) { clearTimeout(timer); reject(error); }
    })));
    const home = path.join(this.dir, 'computer', 'monitors', String(index), 'home');
    if (preserveFor && fs.existsSync(home)) {
      const saved = this.savedHome(preserveFor);
      if (fs.existsSync(saved)) throw new Error('desktop_profile_conflict: parked profile already exists');
      fs.mkdirSync(path.dirname(saved), {recursive:true});
      fs.renameSync(home, saved);
    } else if (!preserveFor) fs.rmSync(home, { recursive: true, force: true });
    this.monitors.delete(index);
  }

  async shutdown() {
    for (const monitor of this.monitors.values()) {
      for (const child of monitor.processes) {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
      }
    }
    this.monitors.clear();
  }
}

/** Real displays where the tools exist and the platform can run them; bookkeeping elsewhere. */
export function detectDesktopBackend({ platform = process.platform, env = process.env, which = whichOnPath } = {}) {
  if (env.BETTER_BOTS_DESKTOP === 'docker') return 'docker';
  if (env.BETTER_BOTS_DESKTOP === 'placeholder') return 'placeholder';
  if (env.BETTER_BOTS_DESKTOP === 'xvfb') return 'xvfb';
  if (platform !== 'linux') return 'placeholder';
  return DESKTOP_TOOLS.every((tool) => which(tool)) ? 'xvfb' : 'placeholder';
}

function whichOnPath(binary) {
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, binary)));
}

export function createDesktopBackend({ dir, workspace = path.join(dir, 'workspace'), vnc_base, kind = detectDesktopBackend() }) {
  if (kind === 'docker') return new DockerDesktop({ dir, workspace });
  return kind === 'xvfb' ? new XvfbDesktop({ dir, workspace }) : new PlaceholderDesktop({ vnc_base });
}
