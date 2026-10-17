import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {makeHost,call} from '../helpers.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {host}=makeHost({script:()=>[call('LocalReadFile',{path:'/etc/hosts'})]});
host.approval_mode='wait';
host.registry.create({id:'editor',profile:{name:'Editor'}});
const room=host.createRoom({member_ids:['editor'],purpose:'Editorial queue',memory:'none'});
const server=createServer({host,live:false});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
let drain, discussion;
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 // Emulate the old backend too: pending approvals must override its misleading phase.
 for(const endpoint of ['state','transcript*']) await page.route(`**/api/${endpoint}`,async route=>{
  const response=await route.fetch();const body=await response.json();
  for(const agent of body.agents??[]) if(agent.active_run) agent.active_run.phase='typing';
  if(body.active_run) body.active_run.phase='typing';
  await route.fulfill({response,json:body});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 host.userRequest({agent_id:'editor',text:'Read the fixture.'});drain=host.drain();
 const wait=page.locator('.approval-wait');
 await wait.waitFor();
 assert.match(await wait.textContent(),/Waiting for your approval/);
 assert.equal(await page.locator('#agents .working-bubble').count(),0);
  assert.equal(host.scheduler.activeRun('editor').phase,'approval');
 discussion=host.runRoom(room.id,{request:'Review the outline'});
 await page.getByRole('button',{name:/Editorial queue/}).click();
 const roomWait=page.locator('.room-progress');
 await roomWait.waitFor();
 assert.match(await roomWait.textContent(),/Waiting for Editor: a permission request/);
 await roomWait.getByRole('button',{name:'Review permission',exact:true}).click();
 await page.locator('#approvals .card').getByRole('button',{name:'Don’t allow',exact:true}).click();
 await drain;await discussion;
 await roomWait.waitFor({state:'detached'});
 assert.equal(host.scheduler.activeRun('editor'),null);
 assert.deepEqual(errors,[]);
 console.log('PASS: truthful agent and room permission waits, review control, denial releases both waits, old backend supported.');
} finally {
 for(const pending of host.permissions.pendingRequests())host.permissions.resolve(pending.id,'deny');
 await drain;await discussion;
 await browser.close();await new Promise(resolve=>server.close(resolve));await host.close();
}
