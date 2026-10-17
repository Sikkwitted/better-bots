import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { makeHost, makeGate, say, tmpDir } from './helpers.js';
import { startAutomationTicker } from '../src/services/automation-ticker.js';
import { startHealthNotifier } from '../src/core/health.js';
import { JsonlLog } from '../src/core/store.js';
import { retryRead } from '../web/connection.js';
import { draftStore } from '../web/draft-store.js';

test('later schedules start while an earlier automation is waiting', async () => {
  const held = makeGate(), started = makeGate();
  const { host, clock, dir } = makeHost({ script: async function* ({ agent_id }) {
    if (agent_id === 'a') { started.release(); await held.promise; }
    yield say('done');
  } });
  for (const id of ['a', 'b']) host.registry.create({ id, profile: { name: id } });
  host.scheduleAutomation({ agent_id: 'a', name: 'held', text: 'wait', due_at: clock.iso() });
  host.scheduleAutomation({ agent_id: 'b', name: 'later', text: 'go', due_at: new Date(clock.now() + 1000).toISOString() });
  const errors = [];
  const ticker = startAutomationTicker({ host, intervalMs: 60_000, onError: e => errors.push(e) });
  try {
    ticker.tick(); await started.promise; clock.advance(2000);
    assert.equal(ticker.tick().length, 1);
    const b = host.scheduler.durableRuns().find(run => run.agent_id === 'b');
    assert.equal((await host.scheduler.waitForRun(b.id)).status, 'completed');
    assert.ok(host.scheduler.activeRun('a'));
    assert.equal(ticker.tick().length, 0, 'a due occurrence is admitted only once');
    assert.deepEqual(errors, []);
  } finally { ticker.stop(); held.release(); await ticker.running; await host.close(); fs.rmSync(dir, {recursive:true, force:true}); }
});

test('a rejected webhook retries after backoff and only successful delivery starts cooldown', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => { req.resume(); calls++; res.writeHead(calls === 1 ? 503 : 200); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { host, clock, dir } = makeHost(); host.memoryRequired = true;
  const notifier = startHealthNotifier({ host, now: () => clock.now(), intervalMs: 60_000,
    webhook: `http://127.0.0.1:${server.address().port}/hook` });
  try {
    await notifier.tick(); await notifier.tick(); assert.equal(calls, 1);
    clock.advance(5000); await notifier.tick(); assert.equal(calls, 2);
    clock.advance(60_000); await notifier.tick(); assert.equal(calls, 2);
  } finally { notifier.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await host.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('tail reads a bounded suffix; incremental cursors handle append, replacement and UTF-8', () => {
  const dir = tmpDir(), file = path.join(dir, 'events.jsonl'), log = new JsonlLog(file);
  try {
    fs.writeFileSync(file, Array.from({length:10000}, (_, id) => JSON.stringify({id, text:'λ'.repeat(30)})+'\n').join(''));
    const readAll = log.readAll; log.readAll = () => assert.fail('tail must not read the full healthy log');
    assert.deepEqual(log.tail(2).map(r => r.id), [9998, 9999]); log.readAll = readAll;
    const first = log.readIncremental(); assert.equal(first.records.length, 10000);
    log.append({id:10000}); const second = log.readIncremental(first.cursor);
    assert.equal(second.reset, false); assert.deepEqual(second.records, [{id:10000}]);
    fs.writeFileSync(file, '{"id":"new"}\n');
    const replaced = log.readIncremental(second.cursor);
    assert.equal(replaced.reset, true);
    fs.writeFileSync(file, '{"id":"rewritten with longer contents"}\n');
    const grown = log.readIncremental(replaced.cursor);
    assert.equal(grown.reset, true, 'a growing in-place rewrite must not leave cached rows');
    assert.deepEqual(grown.records, [{id:'rewritten with longer contents'}]);
    fs.writeFileSync(file + '.replacement', '{"id":"atomic"}\n');
    fs.renameSync(file + '.replacement', file);
    const atomic = log.readIncremental(grown.cursor);
    assert.equal(atomic.reset, true);
    assert.deepEqual(atomic.records, [{id:'atomic'}]);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('conversation pages preserve older records and later result corrections', async () => {
  const { host, dir } = makeHost();
  try {
    for (let i=0;i<8;i++) host.transcripts.append('agent','a',{kind:'agent_text',text:String(i),result_id:'r'+i});
    const recent = host.transcripts.page('agent','a',{limit:3});
    assert.deepEqual(recent.entries.map(e=>e.text),['5','6','7']); assert.equal(recent.has_more,true);
    const older = host.transcripts.page('agent','a',{limit:3,before:recent.before});
    assert.deepEqual(older.entries.map(e=>e.text),['2','3','4']);
    host.transcripts.append('agent','a',{kind:'result_text_update',target_id:recent.entries[1].id,result_id:'r6',text:'corrected'});
    assert.deepEqual(host.transcripts.page('agent','a',{limit:3}).entries.map(e=>e.text),['5','corrected','7']);
    assert.equal(host.transcripts.all('agent','a').length,8);
  } finally { await host.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('connection retries are bounded in frequency and eventually recover', async () => {
  let attempts=0; const delays=[];
  assert.equal(await retryRead(async()=>{if(++attempts<8)throw Error('offline'); return 'online';},
    {wait:async ms=>delays.push(ms)}),'online');
  assert.deepEqual(delays,[500,1000,2000,4000,8000,10000,10000]);
});

test('drafts survive recreation, stay scoped and clear after sending; denied storage stays usable', () => {
  const values=new Map(), storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  draftStore(storage).save('a','unsent',true);
  const reopened=draftStore(storage);
  assert.deepEqual(reopened.read('a'),{text:'unsent',attachments:true});
  assert.equal(reopened.read('b').text,'');
  reopened.save('a','');assert.equal(reopened.read('a').text,'');
  assert.equal(draftStore({setItem(){throw Error('quota');}}).save('a','text'),false);
});
