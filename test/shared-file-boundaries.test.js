import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellTool, detectIsolation } from '../src/tools/shell-tool.js';
import { desktopCommand } from '../src/services/process-boundary.js';
import { tmpDir } from './helpers.js';
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const encoded = (s) => Buffer.from(s).toString('base64');

for (const route of ['shell', 'desktop']) {
  test(`${route}: OS denies direct, symlink, hardlink, and rename writes to shared state`, { skip: !['seatbelt', 'bwrap'].includes(detectIsolation().kind) }, async (t) => {
    const dir = tmpDir('boundary');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workspace = path.join(dir, 'workspace');
    const home = path.join(workspace, 'agents/agt_a');
    const target = path.join(workspace, 'shared/state.json');
    fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, 'original');
    const isolation = detectIsolation();
    // Desktop's Linux mount plan is exercised separately; this test runs its actual macOS process boundary.
    if (route === 'desktop' && isolation.kind !== 'seatbelt') { t.skip('real X display needed for Linux desktop launch'); return; }
    const seen = isolation.kind === 'bwrap' ? '/work/shared/state.json' : target;
    const script = `import base64,os\np=base64.b64decode('${encoded(seen)}').decode()\nopen('own.txt','w').write('allowed')\nfor kind in ['direct','symlink','hardlink','rename']:\n try:\n  if kind=='direct': open(p,'w').write('bypass')\n  if kind=='symlink':\n   os.symlink(p,'alias');open('alias','w').write('bypass')\n  if kind=='hardlink':\n   os.link(p,'hard');open('hard','w').write('bypass')\n  if kind=='rename': os.replace('own.txt',p)\n  print('BYPASS:'+kind)\n except OSError: print('DENIED:'+kind)\n`;
    let result;
    if (route === 'shell') result = await shellTool({ workspace }).handler({ agent: { id: 'agt_a' }, input: { command: `python3 -c ${quote(script)}` } });
    else {
      const launch = desktopCommand({ command: '/opt/homebrew/bin/python3', args: ['-c', script], home, workspace, display: ':10', isolation });
      const child = spawnSync(launch.command, launch.args, { cwd: home, encoding: 'utf8' });
      result = { ok: child.status === 0, stdout: child.stdout, stderr: child.stderr };
    }
    assert.equal(result.ok, true, result.stderr);
    assert.doesNotMatch(result.stdout, /BYPASS/);
    assert.equal((result.stdout.match(/DENIED/g) ?? []).length, 4);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(home, 'own.txt'), 'utf8'), 'allowed');
  });
}

test('an unavailable OS boundary never falls back to an unconfined process', async (t) => {
  const dir = tmpDir('no-boundary'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await shellTool({ workspace: dir, isolation: { kind: 'process' } }).handler({ agent: { id: 'agt_a' }, input: { command: 'echo bypass > marker' } });
  assert.equal(result.error, 'filesystem_isolation_required');
  assert.equal(fs.existsSync(path.join(dir, 'agents/agt_a/marker')), false);
  assert.throws(() => desktopCommand({ command: 'sh', args: [], home: dir, workspace: dir, display: ':10', isolation: { kind: 'process' } }), /filesystem_isolation_required/);
});
