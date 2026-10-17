import {makeHost} from '../helpers.js';
const [dir,boundary]=process.argv.slice(2);const {host}=makeHost({dir});
host.registry.create({id:'agt_a',profile:{name:'A'}});host.scheduleAutomation({agent_id:'agt_a',name:'once',text:'work'});
const crash=()=>process.kill(process.pid,'SIGKILL');
const enqueue=host.scheduler.enqueue.bind(host.scheduler);
host.scheduler.enqueue=(input)=>{if(boundary==='before_run')crash();const r=enqueue(input);if(boundary==='after_run')crash();return r;};
const update=host.automations.update.bind(host.automations);host.automations.update=(fn)=>{const r=update(fn);if(boundary==='after_schedule')crash();return r;};
host.tickAutomations();
