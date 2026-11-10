import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from '../../src/server.js';
import { makeHost, say } from '../helpers.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { host, dir } = makeHost({script:()=>[say('New answer on latest page.')]});
host.registry.create({ id:'editor', profile:{name:'Editor'} });
for (let i=0;i<180;i++) host.transcripts.append('agent','editor',{kind:'user_message',text:`History message ${i}.`});
host.permissions.acknowledgeAutonomy(); // the first-open notice has been accepted
const server = createServer({host,live:false});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage();
  const errors=[], writes=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',req=>{if(req.method()==='POST')writes.push(req.url());});
  await page.addInitScript(()=>{
    window.EventSource = class {
      static OPEN=1;
      readyState=1;
      constructor(){window.testStream=this;}
    };
  });
  let requests=0;
  await page.route('**/api/state',route=>++requests===1
    ? route.fulfill({status:503,json:{message:'temporary startup outage'}}) : route.continue());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('History message 179.',{exact:true}).waitFor();
  assert.ok(requests>=2,'initial failed read is retried');
  assert.equal(await page.getByText('History message 0.',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Older messages',exact:true}).click();
  await page.getByText('History message 0.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Latest messages',exact:true}).click();
  await page.getByText('History message 179.',{exact:true}).waitFor();
  await page.locator('#input').fill('Unsent draft survives reload');
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#input').value==='Unsent draft survives reload');
  host.transcripts.append('agent','editor',{kind:'agent_text',text:'Reply completed while disconnected.'});
  await page.evaluate(()=>window.testStream.onopen());
  await page.getByText('Reply completed while disconnected.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]); assert.deepEqual(writes,[],'recovery does not resend user requests');
  await page.getByRole('button',{name:'Older messages',exact:true}).click();
  await page.getByText('History message 0.',{exact:true}).waitFor();
  await page.locator('#input').fill('New question from older history.');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.getByText('New answer on latest page.',{exact:true}).waitFor();
  await page.getByText('New question from older history.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: startup retry, paginated history, durable drafts, idle reconnect recovery; no mutation replay.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  await host.close(); fs.rmSync(dir,{recursive:true,force:true});
}
