import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {makeHost,say} from '../helpers.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {host}=makeHost({script:()=>[say('done')]});host.registry.create({id:'agt_ui',profile:{name:'Test'}});
let signedIn=false,session={state:'idle'},starts=0;
const authUrl='https://auth.openai.com/oauth/authorize?client_id=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
const callbackUrl='http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state';
let submittedCallback=null;
const login={
 status:()=>session,
 start:()=>{starts++;return session={id:String(starts),state:'waiting',method:'browser',user_code:null,verification_url:authUrl};},
 submitCallback:(id,url)=>{submittedCallback={id,url};signedIn=true;return session={state:'connected',message:'ChatGPT is connected.'};},
 cancel:()=>session={state:'cancelled',message:'Sign-in cancelled. Your previous connection was kept.'},close(){}
};
const catalog={codexAuth:{status:()=>({signed_in:signedIn,needs_reconnect:!signedIn,plan:'pro'})},list:async()=>({models:signedIn?[{id:'fixture-model',provider:'codex'}]:[],providers:[]}),invalidate(){}};
host.permissions.acknowledgeAutonomy(); // the first-open notice has been accepted
const server=createServer({host,live:false,catalog,subscriptionLogin:login});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#open-app-settings').click();await page.locator('[data-settings-page=providers]').click();
 await page.getByRole('button',{name:'Reconnect ChatGPT'}).click();
 await page.getByLabel('Callback URL from browser').waitFor();
 assert.equal(await page.getByRole('link',{name:'Open OpenAI sign-in'}).getAttribute('href'),authUrl);
 assert.equal(await page.getByText('One-time sign-in code').count(),0);
 await page.reload();await page.locator('#open-app-settings').click();await page.locator('[data-settings-page=providers]').click();await page.getByLabel('Callback URL from browser').waitFor();
 assert.equal(starts,1);await page.getByRole('button',{name:'Cancel sign-in'}).click();await page.getByLabel('Callback URL from browser').waitFor({state:'detached'});assert.equal(await page.getByLabel('Callback URL from browser').count(),0);
 await page.getByRole('button',{name:'Reconnect ChatGPT'}).click();await page.getByLabel('Callback URL from browser').waitFor();
 await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('#app-settings').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await page.screenshot({path:'/tmp/better-bots-subscription-mobile.png'});
 session={state:'expired',message:'This sign-in session expired. Start again.'};await page.getByText('This sign-in session expired.',{exact:false}).waitFor();assert.equal(await page.getByLabel('Callback URL from browser').count(),0);
 await page.getByRole('button',{name:'Reconnect ChatGPT'}).click();await page.getByLabel('Callback URL from browser').waitFor();
 await page.getByLabel('Callback URL from browser').fill(callbackUrl);
 await page.getByRole('button',{name:'Complete sign-in'}).click();
 await page.getByText('ChatGPT pro is linked.',{exact:false}).waitFor();
 assert.deepEqual(submittedCallback,{id:String(starts),url:callbackUrl});
 assert.equal(await page.getByLabel('Callback URL from browser').count(),0);
 await page.setViewportSize({width:1200,height:850});await page.screenshot({path:'/tmp/better-bots-subscription-connected.png'});
 assert.deepEqual(errors,[]);console.log('PASS: browser sign-in link, callback submission, cancel, expiration, success/model refresh and mobile layout; no page errors.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await host.close();}
