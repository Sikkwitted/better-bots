import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { makeHost, say } from './helpers.js';

// The interface accepts requests and shows activity, chats, tools, and results.
// It owns no state — every route delegates to a service.

async function withServer(run, { script = () => [say('ok')], catalog = null } = {}) {
  const { host } = makeHost({ script });
  const server = createServer({ host, live: false, catalog: catalog ?? {
    list: async () => ({ models: [{ id: 'claude-sonnet-5', provider: 'anthropic', label: 'Test model' }], providers: [] }),
    invalidate() {},
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await run({ call, host, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('transcript API associates continuation history with the original request without rewriting saved rows', async () => {
  await withServer(async ({call,host}) => {
    host.registry.create({id:'agt_turns',profile:{name:'Turns'}});
    const root=host.userRequest({agent_id:'agt_turns',text:'Original request'});
    const next=host.scheduler.enqueue({agent_id:'agt_turns',lane:'user',payload:{kind:'continue',parent_run_id:root.id}});
    host.transcripts.append('agent','agt_turns',{kind:'reasoning',run_id:root.id,text:'First step'});
    host.transcripts.append('agent','agt_turns',{kind:'reasoning',run_id:next.id,text:'Next step'});
    const {body,status}=await call('GET','/api/transcript?agent_id=agt_turns');
    assert.equal(status,200);
    assert.deepEqual(body.entries.filter(e=>e.kind==='reasoning').map(e=>e.turn_id),[root.id,root.id]);
    assert.equal(host.transcripts.all('agent','agt_turns').at(-1).turn_id,undefined);
  });
});

test('desktop connect opens an idle bot desktop and reconnects without replacing ownership', async () => {
  await withServer(async ({call,host}) => {
    host.registry.create({id:'agt_desktop',profile:{name:'Desktop'}});
    let opened=0;
    host.computer.backend={kind:'test',vncUrl:()=> 'vnc://127.0.0.1:5901',ensureMonitor:async()=>{opened++;return {real:true};}};
    const first=await call('POST','/api/desktop/connect',{agent_id:'agt_desktop'});
    assert.equal(first.status,200);
    assert.equal(first.body.window.live,true);
    const again=await call('POST','/api/desktop/connect',{agent_id:'agt_desktop'});
    assert.equal(again.body.window.owner_token,first.body.window.owner_token);
    assert.equal(opened,2);
    assert.equal(host.scheduler.activeRun('agt_desktop'),null);
    assert.equal(host.scheduler.pendingRuns('agt_desktop').length,0);
    assert.notEqual((await call('POST','/api/desktop/connect',{agent_id:'missing'})).status,200);
    for(let i=0;i<2;i++) {host.registry.create({id:`agt_taken${i}`,profile:{name:'Taken'}});host.computer.assignWindow(`agt_taken${i}`);}
    host.registry.create({id:'agt_full',profile:{name:'Full'}});
    assert.notEqual((await call('POST','/api/desktop/connect',{agent_id:'agt_full'})).status,200);
    assert.equal(host.computer.assignments().length,3);
  });
});

test('agent deletion preserves response compatibility and reports incomplete desktop cleanup', async () => {
  await withServer(async ({ call, host }) => {
    host.registry.create({ id: 'agt_delete', profile: { name: 'Delete' } });
    host.computer.backend = { vncUrl: () => 'fake:', release: async () => { throw new Error('test cleanup failure'); } };
    host.computer.assignWindow('agt_delete');
    const response = await call('DELETE', '/api/agents', { agent_id: 'agt_delete' });
    assert.equal(response.status, 200);
    assert.equal(response.body.deleted, true);
    assert.equal(response.body.agent_id, 'agt_delete');
    assert.equal(response.body.cleanup_pending, true);
    assert.equal(response.body.status, 'cleanup_pending');
    assert.match(response.body.message, /unavailable/);
    assert.equal(host.registry.has('agt_delete'), false);
    assert.equal(Object.keys(host.computer.doc.read().releasing).length, 1);
  });
});

test('the console serves its own assets and refuses to escape the web directory', async () => {
  await withServer(async ({ base }) => {
    for (const [route, type] of [['/', 'text/html'], ['/style.css', 'text/css'], ['/app.js', 'text/javascript']]) {
      const res = await fetch(base + route);
      assert.equal(res.status, 200, route);
      assert.equal(res.headers.get('content-type'), type);
    }
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/nope.css`)).status, 404);
  });
});

test('a class that sets display never traps an element the app hides', async () => {
  // The app hides panels with the `hidden` attribute. A class that sets `display`
  // outranks the browser's [hidden] rule, so such a class must opt back out —
  // otherwise the element is stuck on screen and no server test would notice.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(webDir, 'style.css'), 'utf8');

  const classes = new Set();
  for (const match of html.matchAll(/class="([^"]+)"[^>]*\shidden/g)) {
    for (const name of match[1].split(/\s+/)) classes.add(name);
  }
  assert.ok(classes.size > 0, 'expected to find hidden elements to check');

  for (const name of classes) {
    const rule = css.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`));
    if (!rule || !/\bdisplay\s*:/.test(rule[1])) continue;
    assert.match(
      css,
      new RegExp(`\\.${name}\\[hidden\\]`),
      `.${name} sets display, so it needs a .${name}[hidden] { display: none } escape`,
    );
  }
});

test('the console collapses to one pane on a narrow screen, and every pane stays reachable', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(webDir, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');

  const narrow = css.match(/@media \(max-width: \d+px\) \{([\s\S]*?)\n\}/);
  assert.ok(narrow, 'a max-width media query exists');
  assert.match(narrow[1], /\.app[^{]*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/, 'one column on a phone');

  // Every pane the tab bar names has a rule that shows it, and the tab bar exists.
  const tabs = [...html.matchAll(/<button type="button" data-pane="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs.sort(), ['activity', 'agents', 'chat']);
  for (const pane of tabs) assert.match(narrow[1], new RegExp(`\\.app\\[data-pane="${pane}"\\]`), `pane ${pane} can be shown`);
  assert.match(js, /showPane\('chat'\)/, 'picking an agent moves to the chat');
});

test('agents can be created and appear in state with their colour and role', async () => {
  await withServer(async ({ call }) => {
    const created = await call('POST', '/api/agents', { name: 'Ada', role: 'researcher', color: '#37FF5D' });
    assert.equal(created.status, 200);
    const state = await call('GET', '/api/state');
    assert.equal(state.body.live, false);
    assert.deepEqual(
      state.body.agents.map((a) => ({ name: a.name, role: a.role, color: a.color })),
      [{ name: 'Ada', role: 'researcher', color: '#37FF5D' }],
    );
  });
});

test('an agent is created with the face the picker sent, and reports it in state', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/api/agents', { name: 'Ada', role: 'researcher', color: '#51FFCD', shape: 'oval', style: 'glasses' });
    const state = await call('GET', '/api/state');
    assert.deepEqual(
      state.body.agents.map((a) => ({ color: a.color, shape: a.shape, style: a.style })),
      [{ color: '#51FFCD', shape: 'oval', style: 'glasses' }],
    );
  });
});

test('a face the interface cannot draw falls back rather than failing the create', async () => {
  await withServer(async ({ call }) => {
    const created = await call('POST', '/api/agents', { name: 'Bo', shape: 'trapezoid', color: 'chartreuse' });
    assert.equal(created.status, 200);
    const [agent] = (await call('GET', '/api/state')).body.agents;
    assert.equal(agent.shape, 'round');
    assert.equal(agent.color, '#51FFCD');

    // A real colour that has no face snaps to the nearest one that does, so the
    // API can never create an agent whose image is missing.
    const green = await call('POST', '/api/agents', { name: 'Cy', color: '#10b981' });
    assert.equal(green.body.profile.avatar_color, '#37FF5D');
    const lower = await call('POST', '/api/agents', { name: 'Di', color: '#51ffcd' });
    assert.equal(lower.body.profile.avatar_color, '#51FFCD', 'case does not change the face');
  });
});

test('changing a face edits the profile only, and leaves the untouched half alone', async () => {
  await withServer(async ({ call, host }) => {
    const created = await call('POST', '/api/agents', { name: 'Ada', color: '#51FFCD', shape: 'square' });
    const id = created.body.id;
    await call('POST', '/api/ask', { agent_id: id, text: 'hello' });
    const before = host.transcripts.all('agent', id).length;

    // Colour only: the shape must survive a partial patch.
    const patched = await call('PATCH', '/api/agents', { agent_id: id, color: '#FF8234' });
    assert.equal(patched.status, 200);
    const [agent] = (await call('GET', '/api/state')).body.agents;
    assert.equal(agent.color, '#FF8234');
    assert.equal(agent.shape, 'square', 'a colour change must not reset the shape');

    // A profile edit never rewrites a transcript.
    assert.equal(host.transcripts.all('agent', id).length, before);
  });
});

test('changing the face of an agent that does not exist is a 404', async () => {
  await withServer(async ({ call }) => {
    const res = await call('PATCH', '/api/agents', { agent_id: 'agt_nope', shape: 'dome' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'agent_not_found');
  });
});

test('settings edit name, role, prompt, and model without disturbing the rest', async () => {
  await withServer(async ({ call, host }) => {
    const created = await call('POST', '/api/agents', {
      name: 'Ada', role: 'researcher', prompt: 'Be terse.', model: 'claude-sonnet-5', model_provider: 'anthropic',
      color: '#51FFCD', shape: 'square',
    });
    const id = created.body.id;

    let [agent] = (await call('GET', '/api/state')).body.agents;
    assert.deepEqual(
      { name: agent.name, role: agent.role, prompt: agent.prompt, model: agent.model },
      { name: 'Ada', role: 'researcher', prompt: 'Be terse.', model: 'claude-sonnet-5' },
    );

    // A partial patch must not blank the fields it left out.
    await call('PATCH', '/api/agents', { agent_id: id, prompt: 'Think quietly.' });
    [agent] = (await call('GET', '/api/state')).body.agents;
    assert.equal(agent.prompt, 'Think quietly.');
    assert.equal(agent.name, 'Ada');
    assert.equal(agent.model, 'claude-sonnet-5');
    assert.equal(agent.shape, 'square');

    // An unavailable model must never silently select another model/provider.
    const rejected = await call('PATCH', '/api/agents', { agent_id: id, model: 'not-in-catalog', model_provider: 'anthropic' });
    assert.equal(rejected.status, 400);
    assert.equal((await call('GET', '/api/state')).body.agents[0].model, 'claude-sonnet-5');

    // A refused model in the same save must not discard the prompt saved with it.
    const together = await call('PATCH', '/api/agents', { agent_id: id, prompt: 'Think out loud.', model: 'not-in-catalog', model_provider: 'anthropic' });
    assert.equal(together.status, 400);
    assert.equal(together.body.error, 'model_unavailable');
    assert.match(together.body.message, /Other settings were saved/);
    assert.equal(host.registry.get(id).profile.model, 'claude-sonnet-5');
    const effort = await call('PATCH', '/api/agents', { agent_id: id, role: 'editor', reasoning_effort: 'not-a-level' });
    assert.equal(effort.status, 400);
    assert.equal(host.registry.get(id).profile.role, 'editor');

    // The prompt is what the model is actually told: the agent's identity.
    assert.equal(host.registry.get(id).profile.description, 'Think out loud.');
  });
});

test('a new bot starts without host-machine tools unless they are chosen', async () => {
  await withServer(async ({ call, host }) => {
    const offered = (id) => host.tools.describeFor(host.registry.get(id)).map((t) => t.name);
    const { body: safe } = await call('POST', '/api/agents', { name: 'Safe' });
    for (const name of ['LocalReadFile', 'LocalWriteFile', 'HostReadPDF']) assert.ok(!offered(safe.id).includes(name), `${name} is off by default`);
    for (const name of ['SandboxRunCommand', 'OpenScreen', 'WebReadPublic', 'Remember']) assert.ok(offered(safe.id).includes(name), `${name} stays on`);
    const catalog = (await call('GET', '/api/tools')).body.tools;
    assert.deepEqual(catalog.filter((t) => !t.default).map((t) => t.name).sort(), ['HostReadPDF', 'LocalReadFile', 'LocalWriteFile']);
    const { body: trusted } = await call('POST', '/api/agents', { name: 'Trusted', allowed_tools: null });
    assert.ok(offered(trusted.id).includes('LocalReadFile'), 'choosing every tool at creation is honoured');
    assert.equal((await call('POST', '/api/agents', { name: 'Bad', allowed_tools: 'LocalReadFile' })).status, 400);
  });
});

test('settings scope an agent to chosen tools, and null restores every tool', async () => {
  await withServer(async ({ call, host }) => {
    const { body: { id } } = await call('POST', '/api/agents', { name: 'Ada', allowed_tools: null });
    const offered = () => host.tools.describeFor(host.registry.get(id)).map((t) => t.name).sort();
    const catalog = (await call('GET', '/api/tools')).body.tools;
    assert.ok(catalog.some((t) => t.name === 'WebReadPublic'));
    assert.deepEqual(catalog.filter((t) => t.always_on).map((t) => t.name).sort(), ['Recall', 'Remember']);
    assert.equal((await call('GET', '/api/state')).body.agents[0].allowed_tools, null);

    await call('PATCH', '/api/agents', { agent_id: id, allowed_tools: ['WebReadPublic', 'WebReadPublic'] });
    assert.deepEqual(offered(), ['Recall', 'Remember', 'WebReadPublic']);
    assert.deepEqual((await call('GET', '/api/state')).body.agents[0].allowed_tools, ['WebReadPublic']);

    assert.equal((await call('PATCH', '/api/agents', { agent_id: id, allowed_tools: 'WebReadPublic' })).status, 400);
    await call('PATCH', '/api/agents', { agent_id: id, prompt: 'Unrelated edit.' });
    assert.deepEqual(host.registry.get(id).profile.allowed_tools, ['WebReadPublic'], 'a save that omits tools leaves them alone');

    await call('PATCH', '/api/agents', { agent_id: id, allowed_tools: null });
    assert.ok(offered().includes('SendToAgent'));
  });
});

test('model discovery refreshes and identical IDs keep their subscription or API route', async () => {
  const requests = [];
  let available = [
    { id: 'new-shared-model', provider: 'codex', label: 'Subscription model' },
    { id: 'new-shared-model', provider: 'openai', label: 'API model' },
  ];
  const catalog = { list: async (options) => { requests.push(options); return { models: available, providers: [] }; }, invalidate() {} };
  await withServer(async ({ call, host }) => {
    const listed = await call('GET', '/api/models?refresh=1');
    assert.equal(listed.status, 200);
    assert.equal(requests.at(-1).force, true);
    assert.equal(listed.body.models.length, 2);
    const sub = await call('POST', '/api/agents', { name: 'Sub', model: 'new-shared-model', model_provider: 'codex' });
    const api = await call('POST', '/api/agents', { name: 'API', model: 'new-shared-model', model_provider: 'openai' });
    assert.equal(sub.body.profile.model_provider, 'codex');
    assert.equal(api.body.profile.model_provider, 'openai');
    assert.equal((await call('POST', '/api/agents', { name: 'Ambiguous', model: 'new-shared-model' })).status, 400);

    available = [];
    const kept = await call('PATCH', '/api/agents', { agent_id: sub.body.id, prompt: 'Still subscribed.', model: 'new-shared-model', model_provider: 'codex' });
    assert.equal(kept.status, 200, 'editing an unavailable saved selection does not clear it');
    assert.equal(host.registry.get(sub.body.id).profile.model_provider, 'codex');
    await call('PATCH', '/api/agents', { agent_id: sub.body.id, role: 'reviewer' });
    assert.equal(host.registry.get(sub.body.id).profile.model, 'new-shared-model');
    const cleared = await call('PATCH', '/api/agents', { agent_id: sub.body.id, model: null });
    assert.equal(cleared.body.profile.model, null);
    assert.equal(cleared.body.profile.model_provider, null);
  }, { catalog });
});

test('an agent cannot be left without a name', async () => {
  await withServer(async ({ call }) => {
    const created = await call('POST', '/api/agents', { name: 'Ada' });
    const blanked = await call('PATCH', '/api/agents', { agent_id: created.body.id, name: '   ' });
    assert.equal(blanked.status, 400);
    assert.equal(blanked.body.error, 'invalid_name');
    assert.equal((await call('POST', '/api/agents', { name: '  ' })).status, 400);
  });
});

test('a provider key can be set from the console, and is never handed back', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'better-bots-env-')), 'better-bots.env');
  const previous = { file: process.env.BETTER_BOTS_ENV_FILE, key: process.env.GLM_API_KEY };
  process.env.BETTER_BOTS_ENV_FILE = envFile;
  delete process.env.GLM_API_KEY;

  try {
    await withServer(async ({ call }) => {
      const before = (await call('GET', '/api/providers')).body.providers;
      const glm = before.find((p) => p.id === 'glm');
      assert.equal(glm.configured, false, 'starts with no key');
      const local = before.find((p) => p.id === 'local');
      assert.equal(local.needs_key, false, 'a local runtime needs no credential');
      assert.equal(local.configured, true);

      const saved = await call('POST', '/api/providers', { provider: 'glm', key: 'sk-test-value' });
      assert.equal(saved.status, 200);

      // The response and the listing report presence only. A console that can
      // display a key is a console that can leak one.
      assert.equal(JSON.stringify(saved.body).includes('sk-test-value'), false);
      const after = (await call('GET', '/api/providers')).body;
      assert.equal(JSON.stringify(after).includes('sk-test-value'), false);
      assert.equal(after.providers.find((p) => p.id === 'glm').configured, true);

      // It reached the file the service actually reads, at 0640.
      const written = fs.readFileSync(envFile, 'utf8');
      assert.match(written, /^GLM_API_KEY=sk-test-value$/m);
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o640);

      assert.equal((await call('POST', '/api/providers', { provider: 'nope', key: 'x' })).status, 400);
      assert.equal((await call('POST', '/api/providers', { provider: 'glm', key: '  ' })).status, 400);
    });
  } finally {
    if (previous.file === undefined) delete process.env.BETTER_BOTS_ENV_FILE;
    else process.env.BETTER_BOTS_ENV_FILE = previous.file;
    if (previous.key === undefined) delete process.env.GLM_API_KEY;
    else process.env.GLM_API_KEY = previous.key;
  }
});

test('a user turn runs in the user lane and returns a visible result', async () => {
  await withServer(async ({ call }) => {
    const agent = (await call('POST', '/api/agents', { name: 'Ada' })).body;
    const asked = await call('POST', '/api/ask', { agent_id: agent.id, text: 'go' });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.result.lane, 'user');
    assert.equal(asked.body.result.status, 'completed');

    const transcript = await call('GET', `/api/transcript?agent_id=${agent.id}`);
    assert.deepEqual(transcript.body.entries.map((e) => e.kind), ['user_message', 'agent_text']);
  });
});

test('an unknown agent is a 404 and leaves no phantom transcript', async () => {
  await withServer(async ({ call, host }) => {
    const asked = await call('POST', '/api/ask', { agent_id: 'agt_nope', text: 'x' });
    assert.equal(asked.status, 404);
    assert.equal(asked.body.error, 'agent_not_found');
    assert.equal(host.transcripts.all('agent', 'agt_nope').length, 0);
    assert.equal(host.scheduler.runHistory().length, 0, 'nothing was scheduled');

    const sent = await call('POST', '/api/send', { sender_id: 'agt_ghost', target_id: 'agt_nope', text: 'x' });
    assert.equal(sent.status, 404);
    assert.equal(sent.body.error, 'unknown_sender');
  });
});

test('a peer message is acknowledged, delivered on a wake, and never returns a reply', async () => {
  await withServer(async ({ call }) => {
    const ada = (await call('POST', '/api/agents', { name: 'Ada' })).body;
    const bo = (await call('POST', '/api/agents', { name: 'Bo' })).body;
    const ack = await call('POST', '/api/send', {
      sender_id: ada.id, target_id: bo.id, text: 'Goal: build it', priority_reason: 'supersede',
    });
    assert.equal(ack.body.acknowledged, true);
    assert.equal(ack.body.priority, true);
    assert.match(ack.body.note, /not a reply/);

    const transcript = await call('GET', `/api/transcript?agent_id=${bo.id}`);
    const inbound = transcript.body.entries.filter((e) => e.kind === 'peer_message_in');
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].priority_reason, 'supersede');
  });
});

test('a room runs bounded and its transcript is readable', async () => {
  await withServer(async ({ call }) => {
    const ada = (await call('POST', '/api/agents', { name: 'Ada' })).body;
    const bo = (await call('POST', '/api/agents', { name: 'Bo' })).body;
    const ran = await call('POST', '/api/rooms', { purpose: 'ship?', member_ids: [ada.id, bo.id], request: 'ship or not?' });
    assert.equal(ran.status, 200);
    assert.ok(ran.body.result.total_messages <= 10);
    assert.ok(['rounds_complete', 'message_cap', 'no_new_messages'].includes(ran.body.result.stop_reason));

    const transcript = await call('GET', `/api/transcript?room_id=${ran.body.room.id}`);
    assert.ok(transcript.body.entries.some((e) => e.kind === 'room_message'));
  });
});

test('the activity stream pushes host events as they happen', async () => {
  await withServer(async ({ call, base }) => {
    const res = await fetch(`${base}/api/events`);
    const reader = res.body.getReader();
    await reader.read(); // the ": connected" preamble

    await call('POST', '/api/agents', { name: 'Ada' });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^data: /m);
    assert.match(text, /agent\.created/);
    await reader.cancel();
  });
});

test('an approval card can be answered, and the waiting turn then proceeds', async () => {
  // approval_mode 'wait' is what makes a clickable card meaningful.
  const { host } = makeHost({
    script: () => [{ type: 'tool_call', id: 't1', name: 'LocalReadFile', input: { path: '/etc/hosts' } }],
  });
  host.approval_mode = 'wait';
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const server = createServer({ host, live: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const turn = fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agt_a', text: 'read it' }),
    });

    // The turn is paused on the card rather than racing past it.
    let pending = [];
    for (let i = 0; i < 60 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      pending = (await (await fetch(`${base}/api/state`)).json()).pending_approvals;
    }
    assert.equal(pending.length, 1, 'the card is waiting for a person');
    assert.equal(pending[0].action, 'local.read_file');
    assert.equal(host.scheduler.activeRun('agt_a').phase, 'approval');

    const answered = await fetch(`${base}/api/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: pending[0].id, resolution: 'allow_once' }),
    });
    assert.equal((await answered.json()).ok, true);

    const result = (await (await turn).json()).result;
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.tools, [{ name: 'LocalReadFile', decision: 'allowed', target: '/etc/hosts' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('denying the card blocks the action for real', async () => {
  const { host } = makeHost({
    script: () => [{ type: 'tool_call', id: 't1', name: 'LocalWriteFile', input: { path: '/tmp/better-bots-should-not-exist', content: 'x' } }],
  });
  host.approval_mode = 'wait';
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });

  const turn = (async () => {
    host.userRequest({ agent_id: 'agt_a', text: 'write it' });
    await host.drain();
  })();

  let pending = [];
  for (let i = 0; i < 60 && pending.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    pending = host.permissions.pendingRequests();
  }
  assert.equal(pending.length, 1);
  host.permissions.resolve(pending[0].id, 'deny', { actor: 'user' });
  await turn;

  const { existsSync } = await import('node:fs');
  assert.equal(existsSync('/tmp/better-bots-should-not-exist'), false);
  const result = host.visibleResults().at(-1);
  assert.equal(result.tools[0].decision, 'blocked');
});

test('the memory panel reads only what the agent may see, searches it, and takes a correction', async () => {
  await withServer(async ({ call, host }) => {
    const a = (await call('POST', '/api/agents', { name: 'Ada', color: '#51FFCD' })).body;
    const b = (await call('POST', '/api/agents', { name: 'Bo', color: '#37FF5D' })).body;
    host.memory.remember({ scope: 'agent', owner_id: a.id, writer_agent_id: a.id, tier: 'log', text: 'Ada privately noted the launch is Friday.' });
    host.memory.remember({ scope: 'agent', owner_id: b.id, writer_agent_id: b.id, tier: 'log', text: 'Bo privately noted the vault code.' });

    const view = await call('GET', `/api/memory?agent_id=${a.id}`);
    assert.equal(view.status, 200);
    assert.ok(view.body.facts.some((f) => /Friday/.test(f.text)));
    assert.ok(!view.body.facts.some((f) => /vault/.test(f.text)), 'another agent\'s private memory is not shown');
    assert.deepEqual(view.body.counts, { own: 1, project: 0, user: 0 });

    const search = await call('POST', '/api/memory/search', { agent_id: a.id, query: 'vault code' });
    assert.equal(search.body.results.length, 0, 'searching cannot reach Bo\'s memory either');

    const fix = await call('POST', '/api/memory/correct', { agent_id: a.id, text: 'The launch moved to Monday.', scope: 'project' });
    assert.equal(fix.status, 200);
    assert.equal(fix.body.scope, 'project');
    assert.equal(fix.body.writer, 'user');
    assert.match(fix.body.text, /^Correction from the user \(\d{4}-\d{2}-\d{2}\): The launch moved to Monday\./);
    const after = await call('GET', `/api/memory?agent_id=${b.id}`);
    assert.ok(after.body.facts.some((f) => /Monday/.test(f.text)), 'a project correction reaches every agent');

    const bad = await call('POST', '/api/memory/correct', { agent_id: a.id, text: '   ' });
    assert.equal(bad.status, 400);
  });
});

test('the product knows its name and the release scheme', async () => {
  const { PRODUCT, VERSION, CODENAME, BANNER, DISPLAY_VERSION, codenameFor } = await import('../src/core/version.js');
  assert.equal(PRODUCT, 'Better Bots');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(codenameFor('0.1.0'), 'Better Bots', 'the preview is plain Better Bots');
  assert.equal(codenameFor('1.0.0'), 'Better Bots');
  assert.equal(codenameFor('2.0.0'), 'Mo Better Bots');
  assert.equal(codenameFor('3.0.0'), 'Lil Bit Mo Better Bots');
  assert.equal(CODENAME, codenameFor(VERSION));
  if (VERSION.startsWith('0.')) {
    assert.equal(DISPLAY_VERSION, `${VERSION} preview`);
    assert.equal(BANNER, `Better Bots ${VERSION} preview`);
  }
  await withServer(async ({ call }) => {
    const state = (await call('GET', '/api/state')).body;
    assert.equal(state.product, 'Better Bots');
    assert.equal(state.version, DISPLAY_VERSION);
    assert.equal(state.codename, CODENAME);
  });
});

test('pinned agents sit at the top of the roster in the order they were pinned, and unpin', async () => {
  await withServer(async ({ call }) => {
    const ids = [];
    for (const name of ['Scout', 'Orchestrator', 'Max', 'Assistant']) ids.push((await call('POST', '/api/agents', { name })).body.id);
    const names = async () => (await call('GET', '/api/state')).body.agents.map((a) => a.name);
    assert.deepEqual(await names(), ['Scout', 'Orchestrator', 'Max', 'Assistant']);

    await call('POST', '/api/agents/pin', { agent_id: ids[1] });
    await new Promise((r) => setTimeout(r, 5));
    await call('POST', '/api/agents/pin', { agent_id: ids[3] });
    assert.deepEqual(await names(), ['Orchestrator', 'Assistant', 'Scout', 'Max'], 'pinned first, in pin order; the rest keep their order');
    const state = (await call('GET', '/api/state')).body;
    assert.equal(state.agents[0].pinned, true);
    assert.equal(state.agents[2].pinned, false);

    await call('POST', '/api/agents/pin', { agent_id: ids[1], pinned: false });
    assert.deepEqual(await names(), ['Assistant', 'Scout', 'Orchestrator', 'Max']);
  });
});

test('a group is created quiet, and each thing the person says runs one bounded round with the history behind it', async () => {
  await withServer(async ({ call, host }) => {
    host.adapter.script = ({ agent_id, messages }) => [say(`${agent_id === 'agt_a' ? 'A' : 'B'} heard: ${messages.at(-1).content.split('Request: ').at(-1).slice(0, 40)}`)];
    await call('POST', '/api/agents', { name: 'Ada' }); await call('POST', '/api/agents', { name: 'Bo' });
    const [a, b] = (await call('GET', '/api/state')).body.agents.map((x) => x.id);

    const created = await call('POST', '/api/rooms', { purpose: 'Launch review', member_ids: [a, b], memory: 'members' });
    assert.equal(created.status, 200);
    assert.equal(created.body.result, null, 'nothing ran yet');
    const room = created.body.room;
    assert.equal(room.memory, 'members');
    assert.equal((await call('GET', `/api/transcript?room_id=${room.id}`)).body.entries.length, 0);

    const said = await call('POST', '/api/rooms/say', { room_id: room.id, text: 'What is the plan for today?' });
    assert.equal(said.status, 200);
    assert.ok(said.body.result.total_messages >= 2, 'both members answered');
    let entries = (await call('GET', `/api/transcript?room_id=${room.id}`)).body.entries;
    assert.equal(entries[0].sender_id, 'user');
    assert.equal(entries[0].text, 'What is the plan for today?');
    assert.ok(entries.some((e) => e.sender_id === a && /heard: What is the plan/.test(e.text)));

    // The second message sees the first exchange as history: the group persists.
    await call('POST', '/api/rooms/say', { room_id: room.id, text: 'And after that?' });
    entries = (await call('GET', `/api/transcript?room_id=${room.id}`)).body.entries;
    assert.equal(entries.filter((e) => e.sender_id === 'user').length, 2);
    assert.ok(host.audit.where((e) => e.type === 'room.user_said').length === 2);

    const empty = await call('POST', '/api/rooms/say', { room_id: room.id, text: '   ' });
    assert.equal(empty.status, 400);
  });
});

test('room memory can be toggled through the API, while shared legacy rooms remain readable', async () => {
  await withServer(async ({ call, host }) => {
    host.registry.create({ id: 'agt_room_memory', profile: { name: 'Evaluator' } });
    const created = await call('POST', '/api/rooms', { purpose: 'Independent evaluation', member_ids: ['agt_room_memory'] });
    assert.equal(created.status, 200);
    const roomId = created.body.room.id;
    assert.equal(created.body.room.memory, 'members', 'new rooms start private');

    const off = await call('PATCH', '/api/rooms', { room_id: roomId, memory: 'none' });
    assert.equal(off.status, 200);
    assert.equal(off.body.memory, 'none');
    assert.equal((await call('GET', '/api/state')).body.rooms.find((room) => room.id === roomId).memory, 'none');

    const invalid = await call('PATCH', '/api/rooms', { room_id: roomId, memory: 'everyone' });
    assert.equal(invalid.status, 400);
    assert.equal(host.rooms.get(roomId).memory, 'none');

    const shared = await call('PATCH', '/api/rooms', { room_id: roomId, memory: 'project' });
    assert.equal(shared.status, 200);
    assert.equal(shared.body.memory, 'project');
    assert.equal((await call('GET', '/api/state')).body.rooms.find((room) => room.id === roomId).memory, 'project');
  });
});

test('integrations: list with presets, add a stdio server, tools appear, remove, and the OAuth callback answers a browser', async () => {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.js');
  await withServer(async ({ call, host, base }) => {
    const empty = await call('GET', '/api/integrations');
    assert.deepEqual(empty.body.integrations, []);
    assert.ok(empty.body.presets.some((p) => p.id === 'notion' && p.sign_in === true && p.url === 'https://mcp.notion.com/mcp'));
    assert.ok(empty.body.presets.some((p) => p.id === 'github' && p.secret?.header === 'Authorization'));
    assert.ok(empty.body.presets.some((p) => p.id === 'composio' && p.sign_in === true));

    // A local command is only added when the request repeats it, as the console
    // does after the person confirms; a bare POST saves and starts nothing.
    const unconfirmed = await call('POST', '/api/integrations', { name: 'fake', command: process.execPath, args: [fake] });
    assert.equal(unconfirmed.status, 400);
    assert.equal(unconfirmed.body.error, 'command_unconfirmed');
    assert.equal((await call('POST', '/api/integrations', { name: 'fake', command: process.execPath, args: [fake], confirm_command: 'node' })).body.error, 'command_unconfirmed');
    assert.deepEqual((await call('GET', '/api/integrations')).body.integrations, []);

    const added = await call('POST', '/api/integrations', { name: 'fake', command: process.execPath, confirm_command: process.execPath, args: [fake], env: { SECRET: 'hush' } });
    assert.equal(added.status, 200);
    assert.equal(added.body.state, 'connected');
    assert.deepEqual(added.body.env, ['SECRET'], 'env names only, never values');
    assert.doesNotMatch(JSON.stringify(added.body), /hush/);
    assert.ok(host.tools.has('fake__quote'));

    assert.equal((await call('POST', '/api/integrations', { name: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/integrations/sign-in', { name: 'fake' })).body.error, 'bad_integration', 'a local server has nothing to sign in to');

    // The callback is a page, reachable without the token, and a forged state is refused politely.
    const page = await fetch(`${base}/api/integrations/oauth/callback?state=forged&code=x`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /did not complete.*unknown or expired/s);

    assert.equal((await call('DELETE', '/api/integrations', { name: 'fake' })).body.ok, true);
    assert.equal(host.tools.has('fake__quote'), false);
    assert.equal((await call('DELETE', '/api/integrations', { name: 'fake' })).status, 404);
    await host.integrations.close();
  });
});

test('reasoning level persists per bot, reaches turns, and rejects unsupported values', async () => {
  await withServer(async ({call,host}) => {
    host.registry.create({id:'agt_effort',profile:{name:'Reasoner',model:'glm-5.3-flash',model_provider:'glm'}});
    let r = await call('PATCH','/api/agents',{agent_id:'agt_effort',reasoning_effort:'low'});
    assert.equal(r.status,200);
    assert.equal(host.registry.get('agt_effort').profile.reasoning_effort,'low');
    assert.equal(host.status().agents.find(a=>a.id==='agt_effort').reasoning_effort,'low');
    let observed;
    host.adapter.stream = async function* (_m,_t,settings) { observed=settings.reasoning_effort; yield {type:'text',text:'done'}; };
    host.userRequest({agent_id:'agt_effort',text:'test'}); await host.drain();
    assert.equal(observed,'low');
    r = await call('PATCH','/api/agents',{agent_id:'agt_effort',reasoning_effort:'off'});
    assert.equal(r.status,400);
    assert.equal(host.registry.get('agt_effort').profile.reasoning_effort,'low');
    // Claude and a ChatGPT subscription take a level too; the control was dead for them.
    for (const [provider, model] of [['anthropic','claude-sonnet-5-5'],['codex','gpt-5.6-terra']]) {
      host.registry.create({id:`agt_${provider}`,profile:{name:provider,model,model_provider:provider}});
      r = await call('PATCH','/api/agents',{agent_id:`agt_${provider}`,reasoning_effort:'medium'});
      assert.equal(r.status,200,provider);
      assert.equal(host.registry.get(`agt_${provider}`).profile.reasoning_effort,'medium',provider);
    }
  });
});


test('enabling a desk dispatches saved handoffs without another chat or scheduled job', async () => {
  await withServer(async ({call,host}) => {
    host.registry.create({id:'agt_sender',profile:{name:'Sender',desk:'Active'}});
    host.registry.create({id:'agt_paused',profile:{name:'Paused',desk:'Paused'}});
    host.updateDesk({name:'Paused',enabled:false});
    const ack=host.deliverPeerMessage({sender_id:'agt_sender',target_id:'agt_paused',text:'Resume me'});
    const run=host.scheduler.pendingRuns('agt_paused')[0];
    const response=await call('PATCH','/api/desks',{name:'Paused',enabled:true});
    assert.equal(response.status,200);
    for(let i=0;i<100 && host.scheduler.durableRuns().find(r=>r.id===run.id)?.status!=='completed';i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(host.scheduler.durableRuns().find(r=>r.id===run.id).status,'completed');
    assert.equal(host.messages.get(ack.message_id).status,'delivered');
  });
});
