// Local, synthetic acceptance of the exported harness. No model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.BETTER_BOTS_DESKTOP = 'placeholder';
process.env.BETTER_BOTS_CODEX_AUTH_FILE = '/nonexistent/better-bots-release-auth';
const { Host } = await import('./src/host.js');
const { ScriptedAdapter } = await import('./src/model/scripted-adapter.js');
const { createServer } = await import('./src/server.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-bots-harness-'));
const root = path.dirname(new URL(import.meta.url).pathname);
const host = new Host({ dir, adapter: new ScriptedAdapter(() => [{type:'text', text:'synthetic test'}]) });
const catalog = {list: async () => ({models:[], providers:[]})};
const server = createServer({host, live:false, catalog});
try {
  assert.equal(host.registry.list().length, 0);
  assert.deepEqual(host.automations.read().items, {});
  for (const name of ['prompts', 'artifacts', '.git', '.env', '.data']) {
    assert.equal(fs.existsSync(path.join(root, name)), false, `Unexpected payload: ${name}`);
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/evidence')).status, 404);
  assert.equal((await fetch(base+'/api/state')).status, 200);
  const created = await fetch(base+'/api/agents', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'Test assistant',role:'User-created test'})});
  assert.equal(created.status, 200);
  assert.equal(host.registry.list().length, 1);
  console.log('PASS: empty harness, no personal applications, working UI/API and user-created agent.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await host.close();
  fs.rmSync(dir, {recursive:true, force:true});
}
