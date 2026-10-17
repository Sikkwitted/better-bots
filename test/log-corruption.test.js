import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JsonDoc, JsonlLog, logDiagnostics } from '../src/core/store.js';
import { makeHost, reopenHost, tmpDir, say } from './helpers.js';

function logWith(bytes) {
  const dir = tmpDir('corrupt-log'), file = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(file, bytes);
  return { dir, file, log: new JsonlLog(file) };
}

for (const position of ['first', 'middle', 'last', 'multiple']) test(`damaged ${position} records preserve valid history, order, original bytes and diagnostics`, () => {
  const lines = ['{"id":"a"}', '{"id":"b"}'];
  const bad = '{"broken":';
  if (position === 'first') lines.unshift(bad);
  if (position === 'middle') lines.splice(1, 0, bad);
  if (position === 'last') lines.push(bad);
  if (position === 'multiple') lines.splice(0, 0, bad, bad);
  const original = Buffer.from(lines.join('\n'));
  const { log, file, dir } = logWith(original);
  const result = log.readWithDiagnostics();
  assert.deepEqual(result.records.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(log.tail(1), [{ id: 'b' }]);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(result.corruption.length, position === 'multiple' ? 2 : 1);
  for (const issue of result.corruption) {
    const report = JSON.parse(fs.readFileSync(issue.report_file));
    assert.deepEqual(Buffer.from(report.raw_base64, 'base64'), original.subarray(issue.byte_start, issue.byte_end));
  }
  log.readAll(); log.readAll();
  assert.equal(fs.readdirSync(`${file}.corruption`).length, result.corruption.length);
  assert.equal(logDiagnostics(dir).length, result.corruption.length);
});

test('invalid UTF-8 is preserved exactly, not silently replaced inside a valid JSON string', () => {
  const original = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3,0x28]), Buffer.from('"}\n{"id":"after"}\n')]);
  const { log } = logWith(original); const { records, corruption } = log.readWithDiagnostics();
  assert.deepEqual(records, [{ id: 'after' }]); assert.equal(corruption.length, 1);
  const report = JSON.parse(fs.readFileSync(corruption[0].report_file));
  assert.deepEqual(Buffer.from(report.raw_base64, 'base64'), original.subarray(0, original.indexOf(10)));
});

test('complete final JSON, blank lines and CRLF are valid; appends establish one record boundary', () => {
  const { log } = logWith('\r\n {"id":"a"}\r\n  \n{"id":"b"}');
  assert.equal(log.readWithDiagnostics().corruption.length, 0);
  log.append({ id: 'c' });
  assert.deepEqual(log.readAll().map((r) => r.id), ['a','b','c']);
});

test('append after a truncated record preserves the fragment and keeps new records independently readable', () => {
  const { log, file } = logWith('{"id":"a"}\n{"partial":');
  const before = fs.readFileSync(file);
  log.append({ id: 'b' }); log.append({ id: 'c' });
  assert.deepEqual(fs.readFileSync(file).subarray(0, before.length), before);
  assert.deepEqual(log.readAll().map((r) => r.id), ['a','b','c']);
  assert.equal(fs.readdirSync(`${file}.corruption`).length, 1);
});

test('non-object records and store-invalid records are isolated and remain visible in diagnostics', () => {
  const { file, dir } = logWith('null\n[]\n42\n{}\n{"id":"ok"}\n');
  const log = new JsonlLog(file, { validate: (r) => typeof r.id === 'string' });
  assert.deepEqual(log.readAll(), [{ id: 'ok' }]);
  assert.equal(logDiagnostics(dir).length, 4);
});

test('missing logs are empty; ordinary I/O errors and corrupt mutable JSON still throw', () => {
  const dir = tmpDir('io-log'); assert.deepEqual(new JsonlLog(path.join(dir, 'missing')).readAll(), []);
  assert.throws(() => new JsonlLog(dir).readAll(), (e) => e.code === 'EISDIR');
  const file = path.join(dir, 'state.json'); fs.writeFileSync(file, '{"broken":');
  assert.throws(() => new JsonDoc(file, { safe: 'no reset' }).read(), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"broken":');
});

test('corruption report failure cannot silently discard damaged evidence', () => {
  const { log, file } = logWith('broken');
  fs.writeFileSync(`${file}.corruption`, 'not a directory');
  assert.throws(() => log.readAll()); assert.throws(() => log.append({ id: 'new' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});

test('damaged audit and run history do not replay a terminal durable run', async () => {
  const { host, dir } = makeHost({ script: () => [say('done')] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'go' }); await host.drain();
  for (const file of ['audit.jsonl', 'runs/runs.jsonl']) fs.appendFileSync(path.join(dir, file), '{"broken":');
  const reopened = reopenHost({ dir }); const recovered = reopened.host.recover(); await reopened.host.drain();
  assert.equal(reopened.adapter.calls.length, 0);
  assert.equal(reopened.host.scheduler.durableRuns()[0].status, 'completed');
  assert.equal(recovered.log_corruption.length, 2);
  assert.equal(reopened.host.status().log_corruption.length, 2);
});

test('incomplete legacy history requires reconciliation even if the surviving checkpoint looks replayable', async () => {
  const { host, dir } = makeHost(); host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  const run = host.scheduler.enqueue({ agent_id: 'agt_a', lane: 'agent', payload: {} });
  run.status = 'running'; run.checkpoint = { phase: 'prepared' }; host.scheduler.history.append(run);
  host.scheduler.queues.write({ pending: {}, runs: {} });
  fs.appendFileSync(host.scheduler.history.file, '{"unreadable_finish":');
  const reopened = reopenHost({ dir }); reopened.host.recover(); await reopened.host.drain();
  assert.equal(reopened.adapter.calls.length, 0);
  assert.equal(reopened.host.scheduler.durableRuns()[0].status, 'recovery_required');
});

test('intact durable queued state can proceed despite damaged nonauthoritative history', async () => {
  const { host, dir } = makeHost(); host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'go' });
  fs.appendFileSync(host.scheduler.history.file, 'broken\n');
  const reopened = reopenHost({ dir, script: () => [say('safe')] }); reopened.host.recover(); await reopened.host.drain();
  assert.equal(reopened.adapter.calls.length, 1);
});

test('damaged memory and transcripts retain valid later records without crossing scopes', async () => {
  const { host } = makeHost();
  for (const id of ['agt_a','agt_b']) host.registry.create({ id, profile: { name: id } });
  host.memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'private alpha', retain: false });
  fs.appendFileSync(path.join(host.dir,'agents','agt_a','memory.jsonl'), '\nbroken\n');
  host.memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'private omega', retain: false });
  host.transcripts.append('agent','agt_a',{ kind:'agent_text', text:'before' });
  fs.appendFileSync(path.join(host.dir,'agents','agt_a','transcript.jsonl'), '\nbroken\n');
  host.transcripts.append('agent','agt_a',{ kind:'agent_text', text:'after' });
  assert.deepEqual(host.transcripts.all('agent','agt_a').map((r) => r.text), ['before','after']);
  assert.equal(host.memory.factsIn('agent','agt_a').length,2);
  const b = await host.memory.recall({ agent_id:'agt_b', scopes:[{scope:'agent',owner_id:'agt_a'}], query:'private' });
  assert.equal(b.facts.length,0);
});

for (const phase of ['report_temp', 'report_committed', 'boundary', 'partial_new_record']) test(`SIGKILL at ${phase}: repair and reports recover idempotently`, () => {
  const dir = tmpDir('log-crash');
  const child = spawnSync(process.execPath,[new URL('./fixtures/crash-log.mjs',import.meta.url).pathname,dir,phase]);
  assert.equal(child.signal,'SIGKILL',child.stderr.toString());
  const file = path.join(dir,'audit.jsonl'), log = new JsonlLog(file);
  log.append({ id:'recovered' });
  const result = log.readWithDiagnostics();
  assert.deepEqual(result.records,[{id:'before'},{id:'recovered'}]);
  assert.equal(result.corruption.length,phase === 'partial_new_record' ? 2 : 1);
  const ids = result.corruption.map((r)=>r.id);
  assert.deepEqual(log.readWithDiagnostics().corruption.map((r)=>r.id),ids);
  assert.ok(fs.readFileSync(file,'utf8').startsWith('{"id":"before"}\n{"partial":'));
});

test('healthy appends inspect only the boundary, not the whole existing log', () => {
  const { log, file } = logWith('{"id":"a"}\n');
  const read = fs.readFileSync;
  fs.readFileSync = (target,...args) => { if (target === file) throw new Error('whole-log read during append'); return read(target,...args); };
  try { log.append({ id:'b' }); } finally { fs.readFileSync = read; }
  assert.deepEqual(log.readAll(),[{id:'a'},{id:'b'}]);
});

test('diagnostics refresh after an in-place file change and never expose raw preserved content', () => {
  const { log, file, dir } = logWith('{"id":"a"}\n');
  assert.equal(logDiagnostics(dir).length,0);
  fs.writeFileSync(file,'{"id":xxx}\n');
  // The scan cache keys on size and timestamps, and the corrupted line is the
  // same length as the healthy one. On a fast host both writes can land inside
  // one mtime tick, leaving the signature unchanged and the refresh skipped.
  // Real corruption is written at a later moment than the last UI scan, so move
  // the file's clock forward to model that instead of racing the filesystem clock.
  const later = new Date((fs.statSync(file).mtimeMs || Date.now()) + 1000);
  fs.utimesSync(file, later, later);
  const issues = logDiagnostics(dir); assert.equal(issues.length,1);
  assert.equal('raw_base64' in issues[0],false);
  assert.deepEqual(log.readAll(),[]);
});

test('recipient transcript damage is repaired from the durable envelope without duplicate wake execution', async () => {
  const { host, dir } = makeHost();
  for (const id of ['agt_a','agt_b']) host.registry.create({id,profile:{name:id}});
  const ack = host.deliverPeerMessage({sender_id:'agt_a',target_id:'agt_b',text:'keep this delivery'});
  const run = host.scheduler.pendingRuns('agt_b')[0];
  run.status = 'running'; run.payload.message_ids = [ack.message_id];
  host.scheduler.checkpoint(run,'inbox_bound');
  host.messages.drainInbox('agt_b',run.id,[ack.message_id]);
  const file = path.join(dir,'agents','agt_b','transcript.jsonl');
  fs.writeFileSync(file,'{"damaged_delivery":\n');
  const reopened = reopenHost({dir,script:()=>[say('processed once')]});
  reopened.host.recover(); await reopened.host.drain();
  reopened.host.recover(); await reopened.host.drain();
  assert.equal(reopened.adapter.calls.length,1);
  const entries = reopened.host.transcripts.all('agent','agt_b').filter((r)=>r.message_id === ack.message_id);
  assert.equal(entries.length,1); assert.equal(entries[0].text,'keep this delivery');
  assert.ok(reopened.host.status().log_corruption.some((r)=>r.source === file));
});
