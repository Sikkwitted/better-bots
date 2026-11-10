import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { makeHost, say } from '../helpers.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {host} = makeHost({script:()=>[say('done')]});
host.registry.create({id:'agt_ui',profile:{name:'Test bot'}});
host.updateDesk({name:'',enabled:false});
host.permissions.acknowledgeAutonomy(); // the first-open notice has been accepted
const server=createServer({host,live:false,catalog:{list:async()=>({models:[],providers:[]}),invalidate(){}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/integrations', route=>route.fulfill({json:{integrations:[{name:'Connected example',state:'connected',transport:'http',url:'https://example.test/mcp',tools:[]}],presets:[]}}));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Desk paused',exact:true}).waitFor();
 for(const width of [1280,390]) {
  await page.setViewportSize({width,height:844});
  if(width===390) await page.locator('[data-pane=agents]').click();
  for(const section of ['plugins','providers','permissions','activity']) {
   await page.locator('#open-app-settings').click();
   await page.locator(`[data-settings-page=${section}]`).click();
   if(section==='plugins') {
    await page.locator('#plugins .provider-head strong').first().waitFor();
    await page.waitForFunction(()=>{const e=document.querySelector('#plugins .provider-head strong');return e && e.clientWidth>0 && e.getBoundingClientRect().height<=parseFloat(getComputedStyle(e).lineHeight)*2+1;});
   }
   // Force enough content to exercise scrolling even on an empty host.
   await page.locator(`[data-settings-section=${section}]`).evaluate(e=>{const block=document.createElement('div');block.style.height='1800px';block.textContent='Scroll fixture';e.append(block);});
   const before=await page.locator('#close-app-settings').boundingBox();
   await page.locator('.settings-content').evaluate(e=>{e.scrollTop=e.scrollHeight;});
   const after=await page.locator('#close-app-settings').boundingBox();
   assert.equal(after.y,before.y,`${section}: close control stays fixed`);
   for(const id of ['close-app-settings','close-app-settings-footer']) {
    assert.ok(await page.locator(`#${id}`).evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),`${id} unobscured at ${width}`);
   }
   await page.locator('#close-app-settings-footer').click();
   assert.equal(await page.locator('#app-settings').evaluate(e=>e.open),false);
  }
  await page.locator('#open-app-settings').click();await page.locator('#close-app-settings').click();
  await page.locator('#open-app-settings').click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#app-settings').evaluate(e=>e.open),false);
  await page.locator('#open-app-settings').click();await page.mouse.click(2,2);
  assert.equal(await page.locator('#app-settings').evaluate(e=>e.open),false);
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: every settings section scrolls with both close controls reachable; header, footer, Escape and backdrop dismissal; paused desk visible; desktop and phone.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await host.close();}
