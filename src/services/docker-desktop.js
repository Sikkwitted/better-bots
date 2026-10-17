import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SCREEN_ACTIONS, xdotoolArgs, pruneShots } from './desktop-backend.js';

const execute = promisify(execFile);
export const DESKTOP_IMAGE = 'better-bots-desktop:1';

/** Real Linux work surfaces inside Docker Desktop's VM on macOS.
 * Only the workspace is mounted, read-only. No Docker socket or host state is
 * exposed. Each surface has a separate network, processes, home and loopback view.
 */
export class DockerDesktop {
  constructor({ dir, workspace, image = DESKTOP_IMAGE, docker = 'docker' }) {
    this.kind = 'docker';
    this.note = 'Real desktops in Docker Desktop: separate containers and browser sessions; only the workspace is shared read-only. View opens noVNC for user takeover.';
    this.dir = dir; this.workspace = workspace; this.image = image; this.docker = docker;
    fs.mkdirSync(workspace, { recursive: true });
    this.owner = createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 16);
    this.shots = path.join(dir, 'computer', 'shots'); fs.mkdirSync(this.shots, { recursive: true });
    this.monitors = new Map(); this.pending = new Map();
  }

  name(index) {
    if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('invalid desktop index');
    return `better-bots-${this.owner}-${index}`;
  }

  async command(args, timeout = 30000) {
    try { return await execute(this.docker, args, { timeout, maxBuffer: 1024 * 1024 }); }
    catch (error) { throw new Error(`Docker desktop unavailable: ${(error.stderr || error.message).trim().slice(-1500)}`); }
  }

  serial(index, fn) {
    const task = (this.pending.get(index) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.pending.set(index, task);
    return task;
  }

  vncUrl(index) { return this.monitors.get(index)?.view ?? ''; }

  async removeOwned(index) {
    const name = this.name(index);
    const { stdout } = await this.command(['ps', '-aq', '--filter', `name=^/${name}$`]);
    if (stdout.trim()) {
      const info = JSON.parse((await this.command(['inspect', name])).stdout)[0];
      if (info.Config.Labels?.['better-bots.owner'] !== this.owner) throw new Error('desktop name occupied by an unrelated container');
      await this.command(['rm', '-f', name]);
    }
    const networks = (await this.command(['network', 'ls', '-q', '--filter', `name=^${name}$`])).stdout.trim();
    if (networks) {
      const net = JSON.parse((await this.command(['network', 'inspect', name])).stdout)[0];
      if (net.Labels?.['better-bots.owner'] !== this.owner) throw new Error('desktop network belongs to another application');
      await this.command(['network', 'rm', name]);
    }
    this.monitors.delete(index);
  }

  async ensure(index) {
    const existing = this.monitors.get(index);
    if (existing) {
      const info = JSON.parse((await this.command(['inspect', existing.name])).stdout)[0];
      if (info.State.Running && info.Config.Labels?.['better-bots.session'] === existing.session) return existing;
      throw new Error('desktop process stopped; release this surface and open it again');
    }
    // A new host never adopts orphaned sessions. Reset only its own labelled slot.
    await this.command(['image', 'inspect', this.image]);
    await this.removeOwned(index);
    const name = this.name(index), session = randomUUID();
    await this.command(['network', 'create', '--label', `better-bots.owner=${this.owner}`, name]);
    try {
      await this.command(['run', '-d', '--name', name, '--label', `better-bots.owner=${this.owner}`,
        '--label', `better-bots.session=${session}`, '--network', name,
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=1g', '--cpus=2',
        '--tmpfs', '/tmp:rw,nosuid,size=256m,mode=1777', '--tmpfs', '/home/agent:rw,nosuid,size=256m,uid=1000,gid=1000',
        '--shm-size=256m', '--mount', `type=bind,source=${fs.realpathSync(this.workspace)},target=/work,readonly`,
        '-p', '127.0.0.1::6080', '-p', '127.0.0.1::5900', this.image]);
      const info = JSON.parse((await this.command(['inspect', name])).stdout)[0];
      const port = info.NetworkSettings.Ports['6080/tcp'][0].HostPort;
      const monitor = { name, session, index, real: true, view: `http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=scale` };
      const deadline = Date.now() + 15000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          await this.command(['exec', name, 'xdotool', 'getdisplaygeometry'], 2000);
          const response = await fetch(`http://127.0.0.1:${port}/vnc.html`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { ready = true; break; }
        } catch { /* boot in progress */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ready) throw new Error('desktop did not become ready within 15 seconds');
      this.monitors.set(index, monitor);
      return monitor;
    } catch (error) { await this.removeOwned(index); throw error; }
  }

  ensureMonitor(index) { return this.serial(index, async () => {
    const m = await this.ensure(index); return { ...m, vnc_url: m.view };
  }); }

  perform(index, action, detail = {}) {
    return this.serial(index, async () => {
      if (!SCREEN_ACTIONS.includes(action)) throw new Error('unknown screen action');
      const m = await this.ensure(index);
      if (action === 'open_url') {
        const url = new URL(String(detail.url ?? ''));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('open_url needs an HTTP(S) URL without credentials');
        await this.command(['exec', '-d', m.name, 'firefox-esr', '--profile', '/home/agent/profile', '--new-window', url.href]);
        const deadline = Date.now() + 10000;
        let visible = false;
        while (Date.now() < deadline) {
          try { await this.command(['exec', m.name, 'xdotool', 'search', '--onlyvisible', '--class', 'firefox']); visible = true; break; }
          catch { await new Promise((r) => setTimeout(r, 100)); }
        }
        if (!visible) throw new Error('browser failed to open a visible window');
      } else if (action !== 'screenshot') {
        await this.command(['exec', m.name, 'xdotool', ...xdotoolArgs(action, detail)]);
      }
      // Allow the display to paint; caller-provided waits are bounded.
      await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(100, Number(detail.wait_ms) || 350))));
      const screenshot = `docker-${index}-${randomUUID()}.png`;
      await this.command(['exec', m.name, 'scrot', '--overwrite', '/tmp/screenshot.png']);
      // Docker's archive endpoint cannot reliably see files on container tmpfs.
      const { stdout } = await execute(this.docker, ['exec', m.name, 'cat', '/tmp/screenshot.png'], { encoding: 'buffer', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
      if (!stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('desktop returned an invalid PNG');
      fs.writeFileSync(path.join(this.shots, screenshot), stdout);
      pruneShots(this.shots, `docker-${index}-`, Number(process.env.BETTER_BOTS_SHOTS_KEPT) || 48);
      return { performed: true, display: `docker:${index}`, screenshot, view: m.view };
    });
  }

  release(index) { return this.serial(index, () => this.removeOwned(index)); }

  async shutdown() {
    await Promise.allSettled([...this.pending.values()]);
    // Include orphaned slots from this host's previous process, not other projects.
    const ids = (await this.command(['ps', '-a', '--filter', `label=better-bots.owner=${this.owner}`, '--format', '{{.Names}}'])).stdout.trim().split('\n').filter(Boolean);
    for (const name of ids) {
      const match = name.match(new RegExp(`^better-bots-${this.owner}-(\\d+)$`));
      if (match) await this.release(Number(match[1]));
    }
    const networks = (await this.command(['network', 'ls', '--filter', `label=better-bots.owner=${this.owner}`, '--format', '{{.Name}}'])).stdout.trim().split('\n').filter(Boolean);
    for (const name of networks) {
      const match = name.match(new RegExp(`^better-bots-${this.owner}-(\\d+)$`));
      if (match) await this.release(Number(match[1]));
    }
  }
}
