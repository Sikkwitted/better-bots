import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, makeGate, say, call } from './helpers.js';

test('delegated work starts while its sender is still running', async () => {
  const senderHeld = makeGate(), releaseSender = makeGate(), workerStarted = makeGate();
  const {host, adapter} = makeHost();
  adapter.script = async function* (ctx) {
    if (ctx.agent_id === 'agt_lead') {
      if (ctx.messages.at(-1)?.role !== 'tool_results') {
        yield call('SendToAgent', {target_id:'agt_worker', message:'Return the evidence'});
        return;
      }
      senderHeld.release();
      await releaseSender.promise;
    } else workerStarted.release();
    yield say('done');
  };
  host.registry.create({id:'agt_lead',profile:{name:'Lead'}});
  host.registry.create({id:'agt_worker',profile:{name:'Worker'}});
  host.userRequest({agent_id:'agt_lead',text:'Delegate this task'});
  const draining = host.drain();
  await senderHeld.promise;
  let timer;
  try {
    const started = await Promise.race([workerStarted.promise.then(()=>true), new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
    assert.equal(started,true,'worker must start before sender finishes');
  } finally {clearTimeout(timer);releaseSender.release();await draining;await host.close();}
});
