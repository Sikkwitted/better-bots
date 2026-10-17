// Standalone Linux boundary verification; all artifacts are temporary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellTool, detectIsolation } from '../src/tools/shell-tool.js';
import { desktopCommand } from '../src/services/process-boundary.js';
import { SharedFileService } from '../src/services/shared-file-service.js';
const exec = promisify(execFile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-file-linux-'));
const workspace = path.join(dir, 'workspace');
const home = path.join(dir, 'desktop-home');
const service = new SharedFileService({ workspace, state_dir: path.join(dir, 'transactions') });
const isolation = detectIsolation();
assert.equal(isolation.kind, 'bwrap');
let server;
try {
  fs.mkdirSync(home);
  const file = 'shared/state.json';
  assert.equal((await service.execute('agt_a', { action: 'write', path: file, content: '{"a":0,"b":0}', expected_revision: 'missing', operation_id: 'create' })).ok, true);
  const script = `import os\np='/work/shared/state.json'\nopen('own.txt','w').write('allowed')\nfor kind in ['direct','symlink','hardlink','rename']:\n try:\n  if kind=='direct': open(p,'w').write('bypass')\n  if kind=='symlink':\n   os.symlink(p,'alias');open('alias','w').write('bypass')\n  if kind=='hardlink':\n   os.link(p,'hard');open('hard','w').write('bypass')\n  if kind=='rename': os.replace('own.txt',p)\n  print('BYPASS:'+kind)\n except OSError: print('DENIED:'+kind)\n`;
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const shell = await shellTool({ workspace }).handler({ agent: { id: 'agt_a' }, input: { command: `python3 -c ${quote(script)}` } });
  assert.equal(shell.ok, true, shell.stderr);
  assert.equal((shell.stdout.match(/DENIED/g) ?? []).length, 4);
  assert.doesNotMatch(shell.stdout, /BYPASS/);
  fs.mkdirSync('/tmp/.X11-unix', { recursive: true });
  const display = `:${process.pid + 30000}`;
  server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`/tmp/.X11-unix/X${display.slice(1)}`, resolve); });
  const launch = desktopCommand({ command: '/usr/bin/python3', args: ['-c', script], home, workspace, display, isolation });
  const desktop = await exec(launch.command, launch.args);
  assert.equal((desktop.stdout.match(/DENIED/g) ?? []).length, 4);
  assert.doesNotMatch(desktop.stdout, /BYPASS/);
  assert.equal(fs.readFileSync(path.join(workspace, file), 'utf8'), '{"a":0,"b":0}');
  const updates = await Promise.all(['a', 'b'].map((key) => service.execute(`agt_${key}`, { action: 'patch', path: file, operation_id: key, changes: [{ path: [key], expected: { exists: true, value: 0 }, value: 1 }] })));
  assert.ok(updates.every((r) => r.ok));
  assert.deepEqual(JSON.parse((await service.execute('agt_a', { action: 'read', path: file })).content), { a: 1, b: 1 });
  console.log('PASS: Linux shell and desktop OS boundaries deny all 8 bypass attempts; own writes and concurrent host transactions succeed.');
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
