import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { macProfile, assertRealDirectory } from '../services/process-boundary.js';
import { HostError } from '../core/util.js';

// Agents share one sandbox computer. The shell is the first
// tool that makes that computer mean something.
//
// Linux uses a read-only workspace mount with one writable agent directory.
// macOS uses Seatbelt with the same write boundary. Without either OS boundary,
// commands fail closed; a working-directory/string guard is not isolation.

export const DEFAULT_TIMEOUT_MS = 30_000;
// A Gradle or tsc run on a cold cache takes minutes, not seconds. The default
// stays short; a command that knows it is a build asks for more.
export const MAX_TIMEOUT_MS = 900_000;
export const MAX_OUTPUT_BYTES = 64 * 1024;

// Build toolchains installed on the box, where they are. Detected once so a box
// without them is unaffected; inside the sandbox /usr is the same /usr.
const ANDROID_SDK = ['/usr/local/android-sdk', '/opt/android-sdk'].find((p) => fs.existsSync(p)) ?? null;
const JAVA_HOME = fs.existsSync('/usr/lib/jvm')
  ? fs.readdirSync('/usr/lib/jvm').filter((d) => /^java-\d+-openjdk/.test(d)).map((d) => path.join('/usr/lib/jvm', d)).sort().at(-1) ?? null
  : null;

/** The only environment a command sees. Nothing from the host process leaks. */
export function scrubbedEnvironment({ home, agentId }) {
  const bins = [JAVA_HOME && path.join(JAVA_HOME, 'bin'), ANDROID_SDK && path.join(ANDROID_SDK, 'platform-tools')].filter(Boolean);
  return {
    PATH: [...bins, process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'].join(':'),
    HOME: home,
    TMPDIR: path.join(home, '.tmp'),
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
    BETTER_BOTS_AGENT_ID: agentId,
    BETTER_BOTS_SANDBOX: '1',
    // Gradle and the Android tools find themselves; caches stay in the agent's own directory.
    ...(JAVA_HOME ? { JAVA_HOME } : {}),
    ...(ANDROID_SDK ? { ANDROID_HOME: ANDROID_SDK, ANDROID_SDK_ROOT: ANDROID_SDK } : {}),
    GRADLE_USER_HOME: path.join(home, '.gradle'),
  };
}

/**
 * A cheap guard against accidents, not a security boundary: refuse commands that
 * name absolute paths or parent segments, so an agent cannot wander off the
 * workspace by mistake. The workspace root itself is the one allowed absolute path.
 */
export function escapesWorkspace(command, workspaceRoot, readableRoots = []) {
  const root = path.resolve(workspaceRoot);
  const absolute = /(^|[\s='"`(])(\/[^\s'"`)]*)/g;
  for (const match of command.matchAll(absolute)) {
    const candidate = match[2];
    // Device files are not the user's data.
    if (candidate === '/dev' || candidate.startsWith('/dev/')) continue;
    if (candidate === root || candidate.startsWith(root + path.sep)) continue;
    if (readableRoots.some((p) => candidate === p || candidate.startsWith(p + path.sep))) continue;
    return { escapes: true, why: `absolute path ${candidate} is outside the sandbox workspace` };
  }
  if (/(^|[\s/'"`=])\.\.(\/|$|[\s'"`])/.test(command)) return { escapes: true, why: 'parent directory segments (..) are not allowed' };
  if (/(^|[\s='"`])~/.test(command)) return { escapes: true, why: 'home shortcuts (~) are not allowed' };
  return { escapes: false };
}

/** Where commands run: inside kernel namespaces when bubblewrap is present, else in-process containment. */
export function detectIsolation(env = process.env) {
  if (env.BETTER_BOTS_SHELL_ISOLATION === 'process') return { kind: 'process', why: 'BETTER_BOTS_SHELL_ISOLATION=process' };
  const candidates = env.BETTER_BOTS_BWRAP ? [env.BETTER_BOTS_BWRAP] : ['/usr/bin/bwrap', '/usr/local/bin/bwrap'];
  const bwrap = candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (bwrap) return { kind: 'bwrap', bwrap };
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) return { kind: 'seatbelt', binary: '/usr/bin/sandbox-exec' };
  return { kind: 'unavailable', why: 'an enforced filesystem sandbox is required' };
}

/** The sandbox as seen from inside: the workspace is /work, the agent lives in /work/agents/<id>. */
export const SANDBOX_ROOT = '/work';

/**
 * bubblewrap arguments for one agent. Pure, so the mount plan can be tested
 * without bwrap: nothing from the host state directory is ever bound.
 */
export function bwrapArgs({ workspace, agentId, cwd, env, bundles = [] }) {
  const root = path.resolve(workspace);
  const own = path.join(root, 'agents', agentId);
  const shared = path.join(root, 'shared');
  fs.mkdirSync(shared, { recursive: true });
  const insideCwd = path.join(SANDBOX_ROOT, path.relative(root, cwd));
  return [
    '--die-with-parent', '--new-session',
    '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--unshare-net',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
    // Ubuntu's resolv.conf points into /run; without it there is no DNS.
    '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', root, SANDBOX_ROOT,
    '--bind', own, path.join(SANDBOX_ROOT, 'agents', agentId),
    '--ro-bind', shared, path.join(SANDBOX_ROOT, 'shared'),
    ...bundles.flatMap((b) => ['--ro-bind', b.source, b.target]),
    '--chdir', insideCwd,
    '--clearenv',
    ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, String(v)]),
  ];
}

function agentDirectory(workspace, agentId) {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new HostError('invalid_agent_id', 'invalid agent directory');
  const dir = assertRealDirectory(workspace, `agents/${agentId}`);
  assertRealDirectory(dir, '.tmp');
  return dir;
}

function cap(buffer, limit) {
  if (buffer.length <= limit) return { text: buffer.toString('utf8'), truncated: false };
  return { text: buffer.subarray(0, limit).toString('utf8') + `\n[truncated ${buffer.length - limit} bytes]`, truncated: true };
}

/** Runs one command with the containment above and returns a structured result. */
export function runConfined({ command, cwd, env, timeout_ms, isolation = null, workspace = null, agentId = null, signal = null, bundles = [] }) {
  if (signal?.aborted) return Promise.resolve({ ok: false, error: 'run_interrupted', cancelled: true });
  if (!['bwrap', 'seatbelt'].includes(isolation?.kind)) return Promise.resolve({ ok: false, error: 'filesystem_isolation_required', note: 'Shell execution requires an enforced filesystem boundary. Shared file tools remain available.' });
  return new Promise((resolve) => {
    const started = Date.now();
    const child = isolation?.kind === 'bwrap'
      ? spawn(isolation.bwrap, [...bwrapArgs({ workspace, agentId, cwd, env, bundles }), '--', '/bin/sh', '-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(isolation.binary, ['-p', macProfile([path.join(workspace, 'agents', agentId)], [workspace, ...bundles.map((b) => b.source)], { network: false }), '/bin/sh', '-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const collect = (chunks, counter) => (chunk) => {
      // Keep collecting a little past the cap so the truncation note is accurate,
      // but never let a chatty process fill memory.
      if (counter.n < MAX_OUTPUT_BYTES * 2) chunks.push(chunk);
      counter.n += chunk.length;
    };
    const outCounter = { n: 0 };
    const errCounter = { n: 0 };
    child.stdout.on('data', collect(out, outCounter));
    child.stderr.on('data', collect(err, errCounter));
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, timeout_ms);
    const abort = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ ok: false, error: 'spawn_failed', message: error.message, exit_code: null, stdout: '', stderr: '', truncated: false, timed_out: false, duration_ms: Date.now() - started });
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      outBytes = outCounter.n;
      errBytes = errCounter.n;
      const stdout = cap(Buffer.concat(out), MAX_OUTPUT_BYTES);
      const stderr = cap(Buffer.concat(err), MAX_OUTPUT_BYTES);
      resolve({
        ok: !signal?.aborted && !timedOut && code === 0,
        cancelled: Boolean(signal?.aborted),
        exit_code: code,
        signal: exitSignal ?? null,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated || outBytes > MAX_OUTPUT_BYTES || errBytes > MAX_OUTPUT_BYTES,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    });
  });
}

export function shellTool({ workspace, isolation = detectIsolation(), workflows = null }) {
  fs.mkdirSync(workspace, { recursive: true });
  const sandboxed = isolation.kind === 'bwrap';
  return {
    name: 'SandboxRunCommand',
    isolation,
    description: 'Run a command with an OS-enforced filesystem boundary. Network access is blocked, including localhost. Use approved host web/integration tools for network operations. Only your agent directory is writable; shared files are read-only. Use SandboxReadFile, SandboxUpdateJson, or revision-checked SandboxWriteFile for shared state. Commands are refused if no enforced boundary is available.',
    side_effect: 'Changes only the agent-owned working directory; shared writes require host transactions.',
    permission: { action: 'sandbox.run_command', target: (input) => String(input.command).slice(0, 200) },
    input_schema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'A POSIX sh command line.' },
        cwd: { type: 'string', description: 'Optional subdirectory relative to your own agent directory. Omit or use "." for its root. Returned cwd uses this same base.' },
        timeout_ms: { type: 'number', description: `Optional, 1000 to ${MAX_TIMEOUT_MS}. Default ${DEFAULT_TIMEOUT_MS}.` },
      },
    },
    async handler({ agent, input, run }) {
      const bundles = workflows?.sandboxBundles(agent.id) ?? [];
      const command = String(input.command).trim();
      if (!command) throw new HostError('empty_command', 'command cannot be empty');
      // Inside a namespace the mount tree is the boundary and absolute paths are
      // fine; without one, the string guard is all there is.
      if (!sandboxed) {
        const guard = escapesWorkspace(command, workspace, bundles.map((b) => b.target));
        if (guard.escapes) throw new HostError('outside_workspace', guard.why);
      }
      const home = agentDirectory(workspace, agent.id);
      let cwd = home;
      if (input.cwd) {
        const resolved = path.resolve(home, input.cwd);
        if (resolved !== home && !resolved.startsWith(home + path.sep)) throw new HostError('outside_workspace', `${input.cwd} escapes the agent directory`);
        cwd = assertRealDirectory(home, path.relative(home, resolved));
      }
      const timeout_ms = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS));
      const insideHome = sandboxed ? path.join(SANDBOX_ROOT, 'agents', agent.id) : home;
      const env = scrubbedEnvironment({ home: insideHome, agentId: agent.id });
      const result = await runConfined({ command, cwd, env, timeout_ms, isolation, workspace, agentId: agent.id, signal: run?.signal?.native, bundles });
      return { ...result, command, cwd: path.relative(home, cwd) || '.', timeout_ms, isolation: isolation.kind };
    },
  };
}
