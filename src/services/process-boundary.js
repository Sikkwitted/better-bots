import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Where other programs leave their temporary files and where removable and
// network disks appear. Nothing a command needs lives there except its own
// workspace, which stays readable when it happens to be under one of them.
const SHARED_SCRATCH = ['/private/var/folders', '/private/tmp', '/Volumes'];

// The clipboard is a mach service, not a file. Without this any command could
// read whatever the user last copied, passwords included, or replace it.
const PASTEBOARD = '(deny mach-lookup (global-name "com.apple.pboard") (global-name-regex #"^com\\.apple\\.pasteboard\\."))';

export function macProfile(writable, readable = [], { network = true } = {}) {
  const paths = writable.map((p) => fs.realpathSync(p));
  const allowed = [...paths, ...readable.map((p) => fs.realpathSync(p))];
  const hidden = [...new Set([os.homedir(), ...SHARED_SCRATCH, ...readable.map((p) => path.dirname(fs.realpathSync(p)))])];
  const privateReads = hidden.map((p) => `(deny file-read* (require-all (subpath ${JSON.stringify(p)}) ${allowed.map((ok) => `(require-not (subpath ${JSON.stringify(ok)}))`).join(' ')}))`).join('');
  return `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow sysctl-read)(allow mach-lookup)${PASTEBOARD}${network ? '(allow network*)' : '(deny network*)'}(allow file-read*)${privateReads}(allow file-write* ${paths.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ')} (literal "/dev/null"))`;

}

export function assertRealDirectory(root, relative) {
  const realRoot = fs.realpathSync(root);
  let current = realRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (part === '.' || part === '..') throw new Error('unsafe workspace path');
    current = path.join(current, part);
    if (fs.existsSync(current) || (() => { try { fs.lstatSync(current); return true; } catch { return false; } })()) {
      if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error('unsafe workspace path');
    } else fs.mkdirSync(current);
  }
  return current;
}

/** Desktop applications and their descendants cannot write host/shared state. */
export function desktopCommand({ command, args, home, workspace, display, isolation, browser = null }) {
  if (isolation.kind === 'seatbelt') return { command: isolation.binary, args: ['-p', macProfile([home], [workspace]), command, ...args] };
  if (isolation.kind !== 'bwrap') throw new Error('filesystem_isolation_required: desktop applications require an enforced filesystem boundary');
  const socket = `/tmp/.X11-unix/X${String(display).replace(':', '')}`;
  // Operator-installed browser bundles live outside /usr on some hosts.
  // Expose only their installation directory, read-only, never all of /opt.
  const bundledCommand = [command, browser].find(item => item && path.isAbsolute(item) && item.startsWith('/opt/better-bots-browser/'));
  const bundle = bundledCommand ? fs.realpathSync(path.dirname(bundledCommand)) : null;
  if (bundle && !bundle.startsWith('/opt/better-bots-browser/')) throw new Error('unsafe browser installation');
  const browserMount = bundle ? ['--ro-bind', bundle, path.dirname(bundledCommand)] : [];
  return { command: isolation.bwrap, args: [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
    ...browserMount,
    '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/.X11-unix',
    '--ro-bind', socket, socket,
    '--ro-bind', fs.realpathSync(workspace), '/work',
    '--bind', fs.realpathSync(home), home, '--chdir', home,
    '--', command, ...args,
  ] };
}
