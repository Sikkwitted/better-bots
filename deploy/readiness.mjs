import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function waitForReadiness({ health, service, timeoutMs=90_000, intervalMs=2000,
  now=Date.now, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)) }) {
  const deadline=now()+timeoutMs;
  let previous=null, stable=0;
  while(now()<deadline) {
    try {
      const state=await service(), snapshot=await health();
      const memory=snapshot?.dependencies?.memory;
      if(state.active!=='active' || !state.pid || snapshot.status!=='ok' || !memory?.required || !memory.configured || !memory.healthy)
        throw Error('App or required memory is not ready');
      const signature=`${state.pid}:${state.restarts}`;
      stable=signature===previous ? stable+1 : 1; previous=signature;
      if(stable>=3)return;
    } catch { previous=null;stable=0; }
    await sleep(intervalMs);
  }
  throw Error('Release readiness failed: app, required memory or process stability did not pass.');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const url=process.env.BETTER_BOTS_HEALTH_URL || 'http://127.0.0.1:4173/healthz';
  try {
    await waitForReadiness({health:async()=>{
      const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('Unhealthy endpoint'); return response.json();
    },service:()=>{
      const values=Object.fromEntries(execFileSync('systemctl',['show','better-bots','-p','ActiveState','-p','MainPID','-p','NRestarts'],{encoding:'utf8',timeout:5000})
        .trim().split('\n').map(line=>line.split('=')));
      return {active:values.ActiveState,pid:Number(values.MainPID),restarts:Number(values.NRestarts)};
    }});
    console.log('Application and memory dependency readiness passed. Fresh retention and scoped recall still require memory-contract acceptance.');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
