import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';
import { call, makeHost, oneStep, say, tmpDir } from './helpers.js';

// The lead returns one answer with conclusion, evidence, and risks.
// The interface shows what each agent is doing, so a stuck
// agent and an approval card carry the agent's screen.

class FakeDesktop {
  constructor() { this.kind = 'fake'; this.shots = 0; }
  vncUrl(index) { return `vnc://fake/${index}`; }
  async ensureMonitor(index) { return { index, real: true, vnc_url: this.vncUrl(index), view: `tunnel ${index}` }; }
  async perform(index) { this.shots += 1; return { performed: true, screenshot: `window-${index}-${this.shots}.png` }; }
  release() {}
  async shutdown() {}
}

test('one lead per desk; crowning another on the same desk uncrowns the first', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'B' } });
  const leads = () => host.registry.list().filter((a) => a.profile.lead === true).map((a) => a.id);
  assert.deepEqual(leads(), []);
  host.registry.updateProfile('agt_a', { lead: true });
  assert.deepEqual(leads(), ['agt_a']);
  host.registry.updateProfile('agt_b', { lead: true });
  assert.deepEqual(leads(), ['agt_b']);
  assert.equal(host.registry.get('agt_a').profile.lead, false);
  assert.deepEqual(host.status().agents.map((a) => [a.id, a.lead]), [['agt_a', false], ['agt_b', true]]);
  // A second desk is its own workflow and keeps its own lead.
  host.registry.create({ id: 'agt_c', profile: { name: 'C', desk: 'apps' } });
  host.registry.updateProfile('agt_c', { lead: true });
  assert.equal(host.registry.get('agt_b').profile.lead, true);
  assert.equal(host.registry.get('agt_c').profile.lead, true);
});

test('only the lead sees AssembleResult, and it publishes the one answer', async () => {
  const { host, adapter } = makeHost({ script: () => [call('AssembleResult', { conclusion: 'Ship it.', evidence: ['tests green', 42], risks: ['unsigned build'] })] });
  host.registry.create({ id: 'agt_lead', profile: { name: 'Lead', lead: true } });
  host.registry.create({ id: 'agt_worker', profile: { name: 'Worker' } });
  assert.ok(host.tools.describeFor(host.registry.get('agt_lead')).some((t) => t.name === 'AssembleResult'));
  assert.equal(host.tools.describeFor(host.registry.get('agt_worker')).some((t) => t.name === 'AssembleResult'), false);

  host.userRequest({ agent_id: 'agt_lead', text: 'wrap up' });
  await host.drain();
  const result = host.transcripts.all('agent', 'agt_lead').find((e) => e.kind === 'tool_result' && e.name === 'AssembleResult').result;
  assert.equal(result.ok, true);
  const packet = host.visibleResults().find((r) => r.kind === 'lead_result');
  assert.deepEqual({ ...packet, id: undefined, at: undefined, run_id: undefined }, {
    kind: 'lead_result', lead_agent_id: 'agt_lead', lead_agent_name: 'Lead',
    conclusion: 'Ship it.', evidence: ['tests green', '42'], remaining_risks: ['unsigned build'], id: undefined, at: undefined, run_id: undefined,
  });
  assert.ok(packet.run_id);

  assert.match(String(adapter.calls[0].settings.system), /lead agent.*AssembleResult/);
});

test('a worker calling AssembleResult is refused as an unknown tool for it', async () => {
  const { host } = makeHost({ script: () => [call('AssembleResult', { conclusion: 'nope' })] });
  host.registry.create({ id: 'agt_worker', profile: { name: 'Worker' } });
  host.userRequest({ agent_id: 'agt_worker', text: 'try' });
  await host.drain();
  assert.equal(host.visibleResults().some((r) => r.kind === 'lead_result'), false);
  const result = host.transcripts.all('agent', 'agt_worker').find((e) => e.kind === 'tool_result' && e.name === 'AssembleResult').result;
  assert.equal(result.error, 'tool_not_enabled');
  assert.ok(host.audit.where((e) => e.type === 'tool.not_enabled').length === 1);
});

test('ReportBlocked raises an attention item with the screen when the agent holds one', async () => {
  const desktop = new FakeDesktop();
  const dir = tmpDir();
  const host = new Host({ dir, adapter: new ScriptedAdapter(oneStep((ctx) => (
    host.computer.assignments().some((w) => w.agent_id === ctx.agent_id)
      ? [call('ReportBlocked', { reason: 'captcha', detail: 'The login page shows a puzzle.', ladder: ['Reloaded the page: puzzle again'] })]
      : [call('OpenScreen', {})]
  ))), clock: fixedClock(), window_count: 2, desktop, platform: 'linux' });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'open' });
  await host.drain();
  host.userRequest({ agent_id: 'agt_a', text: 'log in' });
  await host.drain();
  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.name === 'ReportBlocked').result;
  assert.equal(result.ok, true);
  assert.match(result.screenshot, /^window-0-\d+\.png$/);
  const [report] = host.status().blocked;
  assert.equal(report.reason, 'captcha');
  assert.equal(report.vnc_url, 'vnc://fake/0');
  assert.equal(report.view, 'tunnel 0');
  assert.equal(report.screenshot, result.screenshot);
  assert.ok(host.audit.where((e) => e.type === 'agent.blocked').length === 1);
  host.resolveBlocked(report.id);
  assert.deepEqual(host.status().blocked, []);
  assert.throws(() => host.resolveBlocked(report.id), /already resolved/);
  assert.throws(() => host.resolveBlocked('blk_nope'), /unknown blocked report/);
});

test('without a real screen the report still reaches the person, without a picture', async () => {
  const { host } = makeHost({ script: () => [call('ReportBlocked', { reason: 'login', detail: 'Needs your credentials.', ladder: ['Recall: no saved login'] })] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'go' });
  await host.drain();
  const [report] = host.status().blocked;
  assert.equal(report.screenshot, null);
  assert.equal(report.reason, 'login');
});

test('a blocker without a ladder of tried alternatives is refused, and nothing is recorded', async () => {
  for (const input of [{ reason: 'login', detail: 'Stuck.' }, { reason: 'login', detail: 'Stuck.', ladder: [] }, { reason: 'login', detail: 'Stuck.', ladder: ['  '] }]) {
    const { host } = makeHost({ script: () => [call('ReportBlocked', input)] });
    host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
    host.userRequest({ agent_id: 'agt_a', text: 'go' });
    await host.drain();
    const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.name === 'ReportBlocked').result;
    assert.equal(result.ok, false);
    assert.equal(result.recorded, false);
    assert.deepEqual(host.status().blocked, []);
  }
  const { host } = makeHost({ script: () => [call('ReportBlocked', { reason: 'login', detail: 'Stuck.', ladder: [' Recall: nothing saved ', ''] })] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'go' });
  await host.drain();
  assert.deepEqual(host.status().blocked[0].ladder, ['Recall: nothing saved']);
});

test('an approval card from an agent with a real screen carries that screen', async () => {
  const desktop = new FakeDesktop();
  const dir = tmpDir();
  const host = new Host({ dir, adapter: new ScriptedAdapter(oneStep((ctx) => (
    host.computer.assignments().some((w) => w.agent_id === ctx.agent_id)
      ? [call('LocalReadFile', { path: '/etc/hosts' })]
      : [call('OpenScreen', {})]
  ))), clock: fixedClock(), window_count: 2, desktop, platform: 'linux' });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'open' });
  await host.drain();
  host.userRequest({ agent_id: 'agt_a', text: 'read' });
  await host.drain();
  // The run ended, so the card left the pending list with its scope; the record itself keeps the evidence.
  const requestId = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.approval_request_id).approval_request_id;
  const request = host.permissions.getRequest(requestId);
  assert.equal(request.action, 'local.read_file');
  assert.match(request.evidence.screenshot, /^window-0-\d+\.png$/);
  assert.equal(request.evidence.view, 'tunnel 0');
  assert.ok(host.audit.where((e) => e.type === 'permission.evidence_attached').length === 1);
});

test('an approval card from an agent without a screen has no evidence and still works', async () => {
  const { host } = makeHost({ script: () => [call('LocalReadFile', { path: '/etc/hosts' })] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'read' });
  await host.drain();
  const requestId = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.approval_request_id).approval_request_id;
  assert.equal(host.permissions.getRequest(requestId).evidence, undefined);
});

test('after the lead assembles a result, the turn that did it is still the turn the API returns', async () => {
  const { host } = makeHost({ script: () => [call('AssembleResult', { conclusion: 'cats', evidence: ['the room said so'], risks: ['no consensus'] }), say('Published.')] });
  const lead = host.registry.create({ profile: { name: 'Ada', lead: true } });
  const run = host.userRequest({ agent_id: lead.id, text: 'wrap up' });
  await host.drain();
  const turn = host.turnResult(run.id);
  assert.equal(turn.status, 'completed');
  assert.ok(turn.tools.some((t) => t.name === 'AssembleResult'), 'the turn record lists the tool it called');
  assert.ok(host.visibleResults().some((r) => r.run_id === run.id && r.kind === 'lead_result'), 'and the lead packet exists alongside it');
  assert.equal(host.explain(run.id).result.status, 'completed', 'explain() picks the turn, not the packet');
});
