import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {makeHost} from '../helpers.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {host}=makeHost();
host.registry.create({id:'agt_reconnect',profile:{name:'Reconnect test'}});
host.computer.backend={kind:'test',shutdown:async()=>{},vncUrl:()=> 'vnc://127.0.0.1:5901',ensureMonitor:async()=>({real:true})};
host.permissions.acknowledgeAutonomy(); // the first-open notice has been accepted
const server=createServer({host,live:false,catalog:{list:async()=>({models:[],providers:[]})}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Isolate UI connection handling from the VNC protocol (covered by the socket test).
 await page.route('**/vendor/novnc/core/rfb.js',route=>route.fulfill({contentType:'text/javascript',body:`export default class RFB extends EventTarget { constructor(){super();window.testRFB=this;queueMicrotask(()=>this.dispatchEvent(new Event('connect')));} disconnect(){this.dispatchEvent(new Event('disconnect'));} focus(){} }`}));
 let attempts=0,release;
 await page.route('**/api/desktop/connect',async route=>{
  attempts++;
  if(attempts===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'No desktop slots available'})});
  if(attempts===2)await new Promise(r=>release=r);
  await route.continue();
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const retry=page.locator('#desktop-retry');
 // Selecting a bot opens its desktop without a click; the first attempt fails here.
 await page.getByText(/Desktop unavailable:.*No desktop slots/).waitFor();
 assert.equal(attempts,1,'opened automatically on selection');
 assert.equal(await retry.isEnabled(),true);
 assert.equal(await retry.textContent(),'Try again');
 await retry.click();await page.getByRole('button',{name:'Connecting…',exact:true}).waitFor();
 assert.equal(await retry.isDisabled(),true);
 host.audit.record('memory.remembered',{agent_id:'agt_reconnect'});
 await page.waitForTimeout(400);
 assert.equal(await retry.isDisabled(),true,'refresh cannot undo pending click');
 release();await page.getByText('Live · watching only',{exact:true}).waitFor();
 const owner=host.computer.assignments()[0].owner_token;
 assert.equal(await page.locator('#desktop-enlarge').isEnabled(),true);
 assert.equal(await page.locator('#desktop-control').isEnabled(),true);
 await page.evaluate(()=>window.testRFB.dispatchEvent(new Event('disconnect')));
 await page.getByText('Desktop disconnected. Reconnect to continue watching.',{exact:true}).waitFor();
 await retry.click();await page.getByText('Live · watching only',{exact:true}).waitFor();
 assert.equal(host.computer.assignments()[0].owner_token,owner);
 assert.equal(host.scheduler.pendingRuns('agt_reconnect').length,0);
 assert.equal(attempts,3);assert.deepEqual(errors,[]);
 console.log('PASS: desktop opens on selection, blank desktop reconnect, immediate busy feedback, actionable failure and retry, ownership preserved, watch-only, no bot run');
} finally {await browser.close();await new Promise(r=>server.close(r));await host.close();}
