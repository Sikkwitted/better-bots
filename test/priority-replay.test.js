import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, reopenHost } from './helpers.js';

for (const phase of ['prepared', 'execution_started', 'tool_pending', 'tool_recorded']) {
  test(`time-critical interruption at ${phase} never replays a completed effect`, async () => {
    const {host,dir,clock}=makeHost(); let calls=0, effects=0;
    host.scheduler.runner=async(run)=>{
      calls++;
      if(calls>1) return;
      host.scheduler.checkpoint(run,phase);
      if(phase.startsWith('tool_')) effects++;
      host.scheduler.interrupt(run.agent_id,{reason:'time_critical'});
    };
    host.scheduler.enqueue({agent_id:'agt_a',lane:'background'});
    await host.scheduler.drain();
    assert.equal(calls,phase==='prepared'?2:1);
    assert.equal(effects,phase.startsWith('tool_')?1:0);
    const stored=host.scheduler.durableRuns()[0];
    assert.equal(stored.status,phase==='tool_pending'?'recovery_required':phase==='prepared'?'completed':'interrupted');
    const {host:restored}=reopenHost({dir,clock});restored.recover();
    assert.equal(restored.scheduler.pendingRuns('agt_a').length,0);
  });
}
test('late successful receipt retires uncertainty without restarting completed work',async()=>{
 const {host}=makeHost();let effects=0;
 host.scheduler.runner=async(run)=>{host.scheduler.checkpoint(run,'tool_pending');effects++;host.scheduler.interrupt(run.agent_id,{reason:'time_critical'});host.scheduler.checkpoint(run,'tool_recorded',{record:{result:{ok:true}}});};
 host.scheduler.enqueue({agent_id:'agt_a',lane:'background'});await host.scheduler.drain();
 assert.equal(effects,1);assert.equal(host.scheduler.durableRuns()[0].resume_policy,'abandon');
});

for(const phase of ['prepared','tool_pending','tool_recorded']) test(`SIGKILL after priority decision at ${phase}`,async()=>{
 const fs=await import('node:fs');const path=await import('node:path');const {spawnSync}=await import('node:child_process');
 const {dir,clock}=makeHost();
 const child=spawnSync(process.execPath,['test/fixtures/crash-priority.mjs',dir,phase]);assert.equal(child.signal,'SIGKILL');
 const {host}=reopenHost({dir,clock});let replay=0;host.scheduler.runner=async()=>{replay++};
 host.recover();await host.scheduler.drain();
 assert.equal(replay,phase==='prepared'?1:0);
 if(phase!=='prepared')assert.equal(fs.readFileSync(path.join(dir,'effect'),'utf8'),'once\n');
 host.recover();await host.scheduler.drain();assert.equal(replay,phase==='prepared'?1:0);
});
