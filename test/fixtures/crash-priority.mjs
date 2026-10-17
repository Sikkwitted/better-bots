import fs from 'node:fs';
import path from 'node:path';
import {makeHost} from '../helpers.js';
const [dir,phase]=process.argv.slice(2);
const {host}=makeHost({dir});
host.scheduler.runner=async(run)=>{
 host.scheduler.checkpoint(run,phase);
 if(phase!=='prepared')fs.appendFileSync(path.join(dir,'effect'),'once\n');
 host.scheduler.interrupt(run.agent_id,{reason:'time_critical'});
 process.kill(process.pid,'SIGKILL');
};
host.scheduler.enqueue({agent_id:'agt_a',lane:'background'});await host.scheduler.drain();
