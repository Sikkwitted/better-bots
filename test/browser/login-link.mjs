import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { makeHost, say } from '../helpers.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
// The host prints http://127.0.0.1:<port>/#token=...; opening it must sign in
// without the locked screen, and the token must not stay in the address bar.
const {host} = makeHost({script:()=>[say('done')]});
host.registry.create({id:'agt_ui',profile:{name:'Test bot'}});
const server=createServer({host,live:false,token:'link-secret',catalog:{list:async()=>({models:[],providers:[]}),invalidate(){}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/#token=link-secret`);
 await page.getByText('Test bot').first().waitFor();
 assert.equal(await page.locator('#token-form').isHidden(),true,'the locked screen never shows');
 assert.equal(new URL(page.url()).hash,'','the token is gone from the address bar');
 const cookies=await page.context().cookies();
 assert.ok(cookies.some(c=>c.name==='better_bots_token'&&c.httpOnly),'signed in with the HttpOnly cookie');
 // A browser without the link still meets the gate, and the pasted link works there.
 const fresh=await browser.newPage();
 await fresh.goto(base);
 await fresh.locator('#token-form').waitFor();
 await fresh.locator('#token-form input').fill(`${base}/#token=link-secret`);
 await fresh.locator('#token-form button[type=submit]').click();
 await fresh.getByText('Test bot').first().waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: the printed login link signs in and leaves no token in the URL; the gate accepts a pasted link.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await host.close();}
