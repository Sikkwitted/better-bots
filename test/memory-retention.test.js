import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { HindsightEngine } from '../src/services/memory-engine.js';
import { RETENTION_KEEP_MS } from '../src/services/memory-retention.js';
import { healthSnapshot } from '../src/core/health.js';
import { fixedClock } from '../src/core/clock.js';
import { tmpDir, makeGate, say } from './helpers.js';

function setup(engine, dir = tmpDir()) {
  const clock = fixedClock();
  const adapter = new ScriptedAdapter(() => [say('The deadline is Friday.')]);
  const host = new Host({ dir, adapter, clock, memory_engine: engine });
  if (!host.registry.has('agt_a')) host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  return { host, clock, dir, adapter };
}
const write = (host, extra = {}) => host.memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'deadline Friday', ...extra });
const jobs = (host) => Object.values(host.memory.retention.doc.read().jobs);
const engine = (overrides = {}) => ({ name: 'fake', ensureBank: async () => true, retain: async () => ({ success: true }), recall: async () => [], ...overrides });

test('exact content is durable before dispatch; no success audit precedes confirmed receipt', async () => {
  const gate = makeGate(), entered = makeGate(); let stored;
  const made = setup(engine({ retain: async (bank, item) => { stored = { bank, item }; entered.release(); await gate.promise; return { success: true, receipt: 'r1' }; } }));
  write(made.host); await entered.promise;
  assert.equal(jobs(made.host)[0].status, 'processing');
  assert.equal(jobs(made.host)[0].item.content, stored.item.content);
  assert.equal(made.host.audit.where((e) => e.type === 'memory.engine_retained').length, 0);
  gate.release(); await made.host.memory.flush();
  assert.equal(jobs(made.host)[0].status, 'succeeded');
  assert.equal(jobs(made.host)[0].receipt.receipt, 'r1');
  assert.equal(made.host.audit.where((e) => e.type === 'memory.engine_retained').length, 1);
  made.host.memory.recover(); await made.host.memory.flush();
  assert.equal(made.host.audit.where((e) => e.type === 'memory.engine_retained').length, 1);
});

test('bank failure retries after persisted backoff; local facts remain available throughout outage', async () => {
  let ready = false, retained = 0;
  const { host, clock } = setup(engine({ ensureBank: async () => { if (!ready) throw new Error('offline'); return true; }, retain: async () => { retained++; return { success: true }; } }));
  write(host); await host.memory.flush();
  assert.equal(jobs(host)[0].status, 'retryable'); assert.equal(retained, 0);
  assert.equal(host.memory.factsIn('agent', 'agt_a').length, 1);
  ready = true; await host.memory.flush(); assert.equal(retained, 0);
  clock.advance(3000); await host.memory.flush();
  assert.equal(retained, 1); assert.equal(jobs(host)[0].status, 'succeeded');
});

test('authentication blocks without looping and can resume after explicit safe retry', async () => {
  let calls = 0, authorized = false;
  const { host } = setup(engine({ retain: async () => { calls++; if (!authorized) throw Object.assign(new Error('unauthorized'), { status: 401 }); return { success: true }; } }));
  write(host); await host.memory.flush(); await host.memory.flush();
  assert.equal(calls, 1); assert.equal(jobs(host)[0].status, 'blocked');
  authorized = true; host.memory.retention.retry(jobs(host)[0].id); await host.memory.flush();
  assert.equal(calls, 2); assert.equal(jobs(host)[0].status, 'succeeded');
});

for (const outcome of ['timeout', 'async', 'false']) {
  test(`${outcome} is never reported as retained or blindly retried`, async () => {
    let calls = 0;
    const { host, dir } = setup(engine({ retain: async () => { calls++; if (outcome === 'timeout') throw new Error('timeout'); return { success: outcome !== 'false', async: outcome === 'async' }; } }));
    write(host); await host.memory.flush();
    assert.equal(jobs(host)[0].status, 'reconciliation_required');
    assert.equal(host.audit.where((e) => e.type === 'memory.engine_retained').length, 0);
    assert.throws(() => host.memory.retention.retry(jobs(host)[0].id), /uncertain/);
    const reopened = setup(engine({ retain: async () => { calls++; return { success: true }; } }), dir);
    reopened.host.recover(); await reopened.host.memory.flush(); assert.equal(calls, 1);
  });
}

test('stable exchange identity prevents duplicates and refuses content replacement', async () => {
  let calls = 0;
  const { host } = setup(engine({ retain: async () => { calls++; return { success: true }; } }));
  const input = { scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', content: 'exact original', context: 'test', ref: { run_id: 'r1' } };
  host.memory.retainExchange(input); host.memory.retainExchange(input); await host.memory.flush();
  assert.equal(calls, 1);
  assert.throws(() => host.memory.retainExchange({ ...input, content: 'changed' }), /different content/);
  assert.equal(jobs(host)[0].item.content, 'exact original');
});

test('no engine still preserves sources and local tiers; raw exchanges never become recalled facts', async () => {
  const { host, dir } = setup(null);
  write(host, { tier: 'profile' });
  host.memory.retainExchange({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', content: 'secret raw exchange', context: 'test', document_id: 'raw' });
  await host.memory.flush();
  assert.equal(jobs(host).length, 2);
  assert.equal(host.memory.factsIn('agent', 'agt_a').length, 1);
  assert.equal(host.memory.factsIn('agent', 'agt_a')[0].tier, 'profile');
  assert.ok(jobs(host).every((j) => j.status === 'local_saved'), 'with no engine the local copy is the whole write');
  let sent = 0;
  const reopened = setup(engine({ retain: async () => { sent++; return { success: true }; } }), dir); reopened.host.recover(); await reopened.host.memory.flush();
  assert.equal(sent, 0, 'adding an engine later does not ship old saves without being asked');
});

test('no engine never leaves retention pending, so health stays ok past the stall window', async () => {
  const { host, clock } = setup(null);
  host.memory.retainExchange({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', content: 'exchange', context: 'test', document_id: 'x' });
  clock.advance(16 * 60_000);
  assert.deepEqual(host.memory.retention.status().unfinished, []);
  assert.equal(healthSnapshot({ host, now: clock.now() }).status, 'ok');
});

test('legacy pending work from a no-engine journal becomes locally saved on startup', async () => {
  const { host, dir } = setup(null);
  host.memory.retention.doc.update((state) => { state.jobs.old = { id: 'old', scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', item: { content: 'x' }, retain: true, status: 'pending', attempts: 0, created_at: new Date(0).toISOString() }; return state; });
  setup(null, dir).host.recover();
  assert.equal(jobs(host).find((j) => j.id === 'old').status, 'local_saved');
});

test('no engine keeps a room outcome as a local fact its members can recall', async () => {
  const { host } = setup(null);
  host.registry.create({ id: 'agt_b', profile: { name: 'B' } });
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'delivery', memory: 'members' });
  await host.runRoom(room.id, { request: 'When is delivery?' });
  host.recover(); await host.memory.flush();
  const recalled = await host.memory.recall({ agent_id: 'agt_b', query: 'deadline Friday' });
  assert.ok(recalled.facts.some((f) => f.source === 'room' && /deadline is Friday/.test(f.text)));
  assert.equal(host.memory.factsIn('agent', 'agt_b').length, 1, 'a replayed outcome is not saved twice');
  assert.ok(jobs(host).every((j) => j.status === 'local_saved'));
});

test('saves queued for another engine are held until the operator releases them', async () => {
  let ready = false, sent = 0;
  const { host, dir } = setup(engine({ ensureBank: async () => { if (!ready) throw new Error('offline'); return true; } }));
  write(host); await host.memory.flush();
  assert.equal(jobs(host)[0].status, 'retryable');
  const other = setup(engine({ name: 'other', retain: async () => { sent++; return { success: true }; } }), dir);
  assert.equal(other.host.recover().memory_held, 1);
  other.clock.advance(3600000); await other.host.memory.flush();
  assert.equal(sent, 0); assert.equal(jobs(other.host)[0].status, 'held');
  assert.equal(healthSnapshot({ host: other.host, now: other.clock.now() + 3600000 }).status, 'ok');
  assert.deepEqual(other.host.memory.retention.releaseHeld(), [jobs(other.host)[0].id]);
  await other.host.memory.flush();
  assert.equal(sent, 1); assert.equal(jobs(other.host)[0].status, 'succeeded');
});

test('finished jobs past the keep window are pruned and their run is not retained again', async () => {
  let sent = 0;
  const { host, clock } = setup(engine({ retain: async () => { sent++; return { success: true }; } }));
  const run = host.userRequest({ agent_id: 'agt_a', text: 'When is the deadline?' }); await host.drain();
  write(host); clock.advance(1000);
  for (let n = 0; n < 60; n++) host.memory.retainExchange({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', content: `exchange ${n}`, context: 'test', document_id: `e${n}` });
  await host.memory.flush();
  const before = sent;
  clock.advance(RETENTION_KEEP_MS + 1000);
  host.recover(); await host.memory.flush();
  assert.equal(jobs(host).length, 60, 'old facts\' jobs go; the newest exchanges stay as consolidation evidence');
  assert.ok(jobs(host).every((j) => !j.fact && j.item.metadata.run_id !== run.id));
  assert.equal(sent, before, 'a pruned run exchange is not queued and sent again on the next startup');
  assert.equal(host.memory.factsIn('agent', 'agt_a').length > 0, true, 'facts stay on disk');
});

test('retention enforces ownership before journalling and separates the same source across scopes', async () => {
  const { host } = setup(engine());
  assert.throws(() => host.memory.retainExchange({ scope: 'agent', owner_id: 'agt_b', writer_agent_id: 'agt_a', content: 'private' }), /owner/);
  assert.throws(() => write(host, { scope: 'invalid' }), /scope/);
  assert.equal(jobs(host).length, 0);
  for (const scope of ['agent', 'user', 'project']) host.memory.retainExchange({ scope, owner_id: scope === 'agent' ? 'agt_a' : 'shared', writer_agent_id: 'agt_a', content: 'fact', document_id: 'same' });
  await host.memory.flush();
  assert.equal(new Set(jobs(host).map((j) => j.item.document_id)).size, 3);
});

test('bounded worker drains more than one batch without losing newly queued work', async () => {
  let calls = 0;
  const { host } = setup(engine({ retain: async () => { calls++; return { success: true }; } }));
  for (let n = 0; n < 19; n++) write(host, { text: `fact ${n}` });
  await host.memory.flush(); assert.equal(calls, 19);
});

for (const phase of ['prepared', 'local_append', 'ensure_bank', 'dispatch', 'accepted', 'succeeded', 'run_intent', 'room_intent']) {
  test(`SIGKILL at ${phase} preserves content and never blindly repeats retention`, async () => {
    const dir = tmpDir('memory-crash');
    const child = spawnSync(process.execPath, [new URL('./fixtures/crash-memory.mjs', import.meta.url).pathname, dir, phase]);
    assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
    let calls = 0;
    const { host, adapter, clock } = setup(engine({ retain: async () => { calls++; return { success: true }; } }), dir);
    const originalTime = clock.iso(); clock.advance(3600000);
    host.recover(); await host.drain(); await host.memory.flush();
    assert.equal(adapter.calls.length, 0, 'recovery must not rerun an agent');
    assert.equal(jobs(host)[0].item.timestamp, originalTime, 'source time survives recovery delay');
    const uncertain = ['dispatch', 'accepted'].includes(phase);
    assert.equal(jobs(host)[0].status, uncertain ? 'reconciliation_required' : 'succeeded');
    assert.equal(calls, uncertain || phase === 'succeeded' ? 0 : 1);
    if (['prepared', 'local_append', 'ensure_bank', 'dispatch', 'accepted', 'succeeded'].includes(phase)) assert.equal(host.memory.factsIn('agent', 'agt_a').length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'remote-receipt')), ['accepted', 'succeeded'].includes(phase));
    host.recover(); await host.memory.flush();
    assert.equal(jobs(host).length, 1);
  });
}

test('Hindsight requests synchronous completion and preserves rejection classification and retry-after', async () => {
  let request;
  const provider = new HindsightEngine({ url: 'https://memory.invalid', fetch: async (_url, options) => { request = JSON.parse(options.body); return new Response('limited', { status: 429, headers: { 'retry-after': '30' } }); } });
  await assert.rejects(provider.retain('agent-a', { content: 'x', document_id: 'stable' }), (err) => err.status === 429 && err.retry_after_ms === 30000);
  assert.equal(request.async, false); assert.equal(request.items[0].document_id, 'stable');
});

test('audit failure after confirmed durable success is repaired without resending', async () => {
  let calls = 0;
  const { host } = setup(engine({ retain: async () => { calls++; return { success: true }; } }));
  const record = host.audit.record.bind(host.audit);
  host.audit.record = (type, detail) => { if (type === 'memory.engine_retained') throw new Error('audit unavailable'); return record(type, detail); };
  write(host); await assert.rejects(host.memory.flush(), /audit unavailable/);
  assert.equal(jobs(host)[0].status, 'succeeded');
  host.audit.record = record; host.memory.recover(); await host.memory.flush();
  assert.equal(calls, 1);
  assert.equal(host.audit.where((e) => e.type === 'memory.engine_retained').length, 1);
});

test('slow bank initialization holds retention but does not hold recall', { timeout: 2000 }, async () => {
  const gate = makeGate(); let retained = false;
  const { host } = setup(engine({ ensureBank: () => gate.promise, retain: async () => { retained = true; return { success: true }; } }));
  write(host);
  try {
    const result = await host.memory.recall({ agent_id: 'agt_a', query: 'deadline' });
    assert.ok(result.facts.some((f) => f.text === 'deadline Friday'));
    assert.equal(retained, false);
  } finally { gate.release(); await host.memory.flush(); }
});

test('async retention waits for completion without another write, including across restart', async () => {
  let writes = 0, status = 'processing', operationId;
  const provider = engine({ supportsAsyncRetention:true,
    retain:async (_bank,item)=>{writes++; operationId=item.operation_id; return {success:true,async:true,operation_id:operationId};},
    retentionStatus:async()=>({status,operation_id:operationId}) });
  const {host,dir,clock}=setup(provider); write(host); await host.memory.flush();
  assert.equal(jobs(host)[0].status,'awaiting_confirmation');
  assert.match(operationId,/^[0-9a-f-]{36}$/);
  await host.memory.flush(); assert.equal(jobs(host)[0].status,'awaiting_confirmation');
  const reopened=setup(provider,dir); reopened.host.recover(); await reopened.host.memory.flush();
  assert.equal(writes,1);
  status='completed'; reopened.clock.advance(10000); await reopened.host.memory.flush();
  assert.equal(jobs(reopened.host)[0].status,'succeeded'); assert.equal(writes,1);
  assert.equal(reopened.host.audit.where(e=>e.type==='memory.engine_retained').length,1);
});

test('lost submission acknowledgement is recovered by durable operation id, not another write', async () => {
  let writes=0, saved;
  const {host,clock}=setup(engine({supportsAsyncRetention:true,
    retain:async (_bank,item)=>{writes++;saved=item.operation_id;throw new Error('response timed out');},
    retentionStatus:async (_bank,id)=>{assert.equal(id,saved);return {status:'completed',operation_id:id};} }));
  write(host); await host.memory.flush(); assert.equal(jobs(host)[0].status,'awaiting_confirmation');
  clock.advance(10000); await host.memory.flush();
  assert.equal(jobs(host)[0].status,'succeeded'); assert.equal(writes,1);
});

test('failed async work is never called successful or automatically submitted again', async () => {
  let writes=0;
  const {host}=setup(engine({supportsAsyncRetention:true,
    retain:async (_bank,item)=>{writes++;return {success:true,async:true,operation_id:item.operation_id};},
    retentionStatus:async()=>({status:'failed',error:'extraction failed'}) }));
  write(host); await host.memory.flush(); await host.memory.flush();
  assert.equal(jobs(host)[0].status,'reconciliation_required'); assert.equal(writes,1);
  assert.equal(host.audit.where(e=>e.type==='memory.engine_retained').length,0);
});

test('a save the provider never registered goes to reconciliation instead of waiting forever', async () => {
  let writes=0;
  const {host,clock}=setup(engine({supportsAsyncRetention:true,
    retain:async ()=>{writes++;throw new Error('timed out after 4000ms');},
    retentionStatus:async (_bank,id)=>({status:'not_found',operation_id:id}) }));
  write(host); await host.memory.flush();
  assert.equal(jobs(host)[0].status,'awaiting_confirmation');
  clock.advance(60000); await host.memory.flush();
  assert.equal(jobs(host)[0].status,'awaiting_confirmation','a just-sent save may not be registered yet');
  clock.advance(11 * 60000); await host.memory.flush();
  const job=jobs(host)[0];
  assert.equal(job.status,'reconciliation_required');
  assert.match(job.error,/no record/);
  assert.equal(writes,1,'not re-sent without an operator decision');
  assert.equal(host.audit.where(e=>e.type==='memory.engine_retained').length,0);
  assert.ok(host.reconciliation.list().some(item=>item.kind==='memory'),'it reaches the Attention pane');
});

test('confirmation cannot resurrect work dismissed while its status read was in flight', async () => {
  const gate=makeGate(), entered=makeGate();
  const {host}=setup(engine({supportsAsyncRetention:true,
    retain:async (_bank,item)=>({success:true,async:true,operation_id:item.operation_id}),
    retentionStatus:async()=>{entered.release();await gate.promise;return {status:'completed'};} }));
  write(host); await host.memory.flush(); const pending=host.memory.flush();await entered.promise;
  host.memory.retention.doc.update(state=>{state.jobs[jobs(host)[0].id].status='abandoned';return state;});
  gate.release();await pending;
  assert.equal(jobs(host)[0].status,'abandoned');
});

test('Hindsight async transport sends durable operation id and polls the same bank', async () => {
  const calls=[];
  const provider=new HindsightEngine({url:'http://memory.test',fetch:async(url,init)=>{
    calls.push({url,init}); return {ok:true,status:200,json:async()=> init.method==='POST'?{success:true,async:true,operation_id:'op-1'}:{status:'completed',operation_id:'op-1'}};
  }});
  await provider.retain('agent-A',{content:'remember',document_id:'doc-1',operation_id:'op-1'});
  assert.equal(JSON.parse(calls[0].init.body).async,true);
  assert.equal(JSON.parse(calls[0].init.body).operation_id,'op-1');
  await provider.retentionStatus('agent-A','op-1');
  assert.equal(calls[1].url,'http://memory.test/v1/default/banks/agent-A/operations/op-1');
});

test('confirmed non-execution starts a new provider operation and preserves failed-attempt evidence', async () => {
  const ids = [], documents = [];
  let failedId;
  const fake = engine({
    supportsAsyncRetention:true,
    retain:async (_bank,item) => {
      ids.push(item.operation_id); documents.push(item.document_id);
      failedId ??= item.operation_id;
      return {success:true, async:true, operation_id:item.operation_id};
    },
    retentionStatus:async (_bank,id) => ({operation_id:id,status:id === failedId ? 'failed' : 'completed',error_message:'provider rejected extraction'}),
  });
  const {host,dir,clock} = setup(fake);
  write(host); await host.memory.flush(); await host.memory.retention.kick();
  const failed = jobs(host)[0];
  assert.equal(failed.status, 'reconciliation_required');
  const pending = host.reconciliation.list().find(x => x.kind === 'memory');
  const input = {kind:'memory',id:failed.id,expected_revision:pending.revision,outcome:'confirmed_not_executed',evidence:'Provider operation failed before extraction; no facts were written',request_id:'retry-failed-operation'};
  host.reconciliation.resolve(input);
  const reopened = setup(fake,dir).host;
  reopened.reconciliation.resolve(input); // same decision remains idempotent across restart
  reopened.memory.recover(); await reopened.memory.flush(); await reopened.memory.retention.kick();
  const retried = jobs(reopened)[0];
  assert.equal(retried.status, 'succeeded');
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(documents[0], documents[1], 'source document identity remains stable');
  assert.equal(retried.resolutions[0].previous_operation.operation_id, failedId);
  assert.equal(retried.resolutions[0].previous_operation.receipt.async, true);
  assert.equal(retried.resolutions.length, 1);
});
