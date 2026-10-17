import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { SubscriptionLogin } from '../src/services/subscription-login.js';
import { CodexAuth } from '../src/model/codex-auth.js';
import { createServer } from '../src/server.js';
import { tmpDir, makeHost } from './helpers.js';

const jwt = exp => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const credentials = (token='old') => JSON.stringify({tokens:{access_token:token,refresh_token:'refresh-secret'}});
const browserUrl = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=login-state&code_challenge=challenge';
const callbackUrl = 'http://localhost:1455/auth/callback?code=short-lived-code&state=login-state';
function fixture(t, overrides={}) {
 const dir=tmpDir('subscription-login');const file=path.join(dir,'auth.json');fs.writeFileSync(file,credentials());
 const children=[],callbacks=[];let changes=0;
 const spawnImpl=(command,args,options)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.options=options;child.sent=[];
  child.reply=message=>child.stdout.write(JSON.stringify(message)+'\n');
  child.stdin=new Writable({write(chunk,enc,done){const message=JSON.parse(chunk.toString());child.sent.push(message);done();
   if(message.method==='initialize')queueMicrotask(()=>child.reply({id:message.id,result:{}}));
   if(message.method==='account/login/start')queueMicrotask(()=>child.reply({id:message.id,result:{type:'chatgpt',loginId:'login-1',authUrl:overrides.url??browserUrl}}));
  }});
  child.kill=()=>{queueMicrotask(()=>child.emit('close',0));return true;};children.push(child);
  assert.equal(command,overrides.env?.CODEX_BIN||'codex');assert.ok(args.includes('cli_auth_credentials_store="file"'));return child;
 };
 const callbackFetch=async (url, options)=>{callbacks.push({url,options});return{ok:false,status:302};};
 const service=new SubscriptionLogin({auth:new CodexAuth({file}),spawnImpl,callbackFetch,onConnected:()=>{changes++;},...overrides});
 t.after(()=>{service.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {service,file,children,callbacks,changes:()=>changes};
}

test('browser login exposes only the official OAuth URL, coalesces starts, and cancels without losing existing credentials',async t=>{
 const {service,file,children}=fixture(t);const old=fs.readFileSync(file,'utf8');
 const state=await service.start();assert.equal(state.state,'waiting');assert.equal(state.method,'browser');assert.equal(state.verification_url,browserUrl);assert.equal(state.user_code,null);
 assert.equal((await service.start()).id,state.id);assert.equal(children.length,1);
 assert.deepEqual(children[0].sent.find(message=>message.method==='account/login/start').params,{type:'chatgpt'});
 assert.notEqual(children[0].options.env.CODEX_HOME,path.dirname(file));
 assert.doesNotMatch(JSON.stringify(state),/refresh-secret|access_token/);
 service.cancel('stale-session');assert.equal(service.status().state,'waiting');
 service.cancel(state.id);assert.equal(service.status().state,'cancelled');assert.equal(service.status().verification_url,null);
 assert.equal(fs.readFileSync(file,'utf8'),old);
});
test('browser login uses the selected Codex binary without passing API credentials',async t=>{
 const {service,children}=fixture(t,{env:{CODEX_BIN:'/opt/codex/current/bin/codex',PATH:'/usr/bin',OPENAI_API_KEY:'must-not-pass',ANTHROPIC_API_KEY:'must-not-pass',BETTER_BOTS_TOKEN:'must-not-pass',HINDSIGHT_API_KEY:'must-not-pass'}});
 assert.equal((await service.start()).state,'waiting');
 assert.equal(children[0].options.env.CODEX_BIN,'/opt/codex/current/bin/codex');
 assert.equal(children[0].options.env.PATH,'/usr/bin');
 for (const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','BETTER_BOTS_TOKEN','HINDSIGHT_API_KEY']) assert.equal(children[0].options.env[key],undefined,key);
});
test('a matching browser callback is relayed only to the fixed host-local Codex listener',async t=>{
 const {service,callbacks}=fixture(t);const state=await service.start();
 assert.equal((await service.submitCallback(state.id,callbackUrl)).state,'waiting');
 assert.equal(callbacks.length,1);
 const relayed=new URL(callbacks[0].url);
 assert.equal(relayed.origin,'http://127.0.0.1:1455');assert.equal(relayed.pathname,'/auth/callback');
 assert.equal(relayed.searchParams.get('state'),'login-state');assert.equal(relayed.searchParams.get('code'),'short-lived-code');
 assert.equal(callbacks[0].options.redirect,'manual');
 await assert.rejects(service.submitCallback(state.id,callbackUrl),/already sent/);assert.equal(callbacks.length,1);
 assert.doesNotMatch(JSON.stringify(service.status()),/short-lived-code|refresh-secret/);
});
test('browser callback uses the Codex-selected fallback port',async t=>{
 const fallbackBrowserUrl=browserUrl.replaceAll('1455','1457');
 const {service,callbacks}=fixture(t,{url:fallbackBrowserUrl});const state=await service.start();
 await service.submitCallback(state.id,callbackUrl.replaceAll('1455','1457'));
 assert.equal(new URL(callbacks[0].url).port,'1457');
});
test('browser callback preserves Codex-supported onboarding state metadata',async t=>{
 const {service,callbacks}=fixture(t);const state=await service.start();
 const stateWithMetadata='login-state.onboarding_entrypoint=life_sciences';
 await service.submitCallback(state.id,`http://localhost:1455/auth/callback?code=short-lived-code&state=${encodeURIComponent(stateWithMetadata)}`);
 assert.equal(new URL(callbacks[0].url).searchParams.get('state'),stateWithMetadata);
});
test('browser callback reaches only the selected loopback listener without following its redirect',async t=>{
 let received=null;
 const listener=http.createServer((req,res)=>{received=req.url;res.writeHead(302,{location:'https://example.invalid/success'});res.end();});
 await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>listener.close(resolve)));
 const port=listener.address().port;
 const {service}=fixture(t,{url:browserUrl.replaceAll('1455',String(port)),callbackFetch:globalThis.fetch});
 const state=await service.start();
 assert.equal((await service.submitCallback(state.id,callbackUrl.replaceAll('1455',String(port)))).state,'waiting');
 const relayed=new URL(received,'http://127.0.0.1');
 assert.equal(relayed.pathname,'/auth/callback');assert.equal(relayed.searchParams.get('code'),'short-lived-code');
 assert.equal(relayed.searchParams.get('state'),'login-state');
});
test('successful Codex completion wins if its callback connection closes before HTTP responds',async t=>{
 const {service,file,children}=fixture(t);const state=await service.start();
 let failFetch;service.callbackFetch=()=>new Promise((_,reject)=>{failFetch=reject;});
 const pending=service.submitCallback(state.id,callbackUrl);
 const child=children[0];fs.writeFileSync(path.join(child.options.env.CODEX_HOME,'auth.json'),credentials('new-access'));
 child.reply({method:'account/login/completed',params:{loginId:'login-1',success:true}});
 await new Promise(resolve=>setImmediate(resolve));failFetch(new Error('socket closed'));
 assert.equal((await pending).state,'connected');
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).tokens.access_token,'new-access');
});
test('a rejected callback ends the attempt without retrying or replacing existing credentials',async t=>{
 const {service,file}=fixture(t,{callbackFetch:async()=>({ok:false,status:400})});
 const old=fs.readFileSync(file,'utf8'),state=await service.start();
 assert.equal((await service.submitCallback(state.id,callbackUrl)).state,'failed');
 assert.equal(service.status().verification_url,null);
 assert.equal(fs.readFileSync(file,'utf8'),old);
 await assert.rejects(service.submitCallback(state.id,callbackUrl),/no longer active/);
});
test('an uncertain callback tells the user how to restart without resubmitting its one-time code',async t=>{
 const {service}=fixture(t,{callbackFetch:async()=>{throw new Error('socket closed');}});
 const state=await service.start();
 await assert.rejects(service.submitCallback(state.id,callbackUrl),/Cancel sign-in and start again/);
 assert.equal(service.status().state,'waiting');
 assert.match(service.status().message,/Cancel sign-in and start again/);
 await assert.rejects(service.submitCallback(state.id,callbackUrl),/already sent/);
 service.cancel(state.id);assert.equal(service.status().state,'cancelled');
});
test('callback relay rejects stale, mismatched, and untrusted addresses before a network request',async t=>{
 const {service,callbacks}=fixture(t);const state=await service.start();
 for(const url of [
  'https://evil.example/auth/callback?code=x&state=login-state',
  'http://localhost.evil.example:1455/auth/callback?code=x&state=login-state',
  'http://127.0.0.1:1455/auth/callback?code=x&state=login-state',
  'http://user@localhost:1455/auth/callback?code=x&state=login-state',
  'http://localhost:1456/auth/callback?code=x&state=login-state',
  'http://localhost:1455/auth/callback?code=x&state=wrong',
  'http://localhost:1455/other?code=x&state=login-state',
  'http://localhost:1455/auth/callback?code=x&state=login-state#fragment',
  'http://localhost:1455/auth/callback?code=x&state=login-state&state=login-state',
  'http://localhost:1455/auth/callback?code=x&code=y&state=login-state',
  'http://localhost:1455/auth/callback?state=login-state',
 ]) await assert.rejects(service.submitCallback(state.id,url),/does not match/);
 await assert.rejects(service.submitCallback('other',callbackUrl),/no longer active/);
 service.cancel(state.id);await assert.rejects(service.submitCallback(state.id,callbackUrl),/no longer active/);
 assert.equal(callbacks.length,0);
});
test('completed login atomically replaces credentials and refreshes models once; late completion cannot overwrite it',async t=>{
 const {service,file,children,changes}=fixture(t);await service.start();const child=children[0];
 fs.writeFileSync(path.join(child.options.env.CODEX_HOME,'auth.json'),credentials('new-access'));
 child.reply({method:'account/login/completed',params:{loginId:'login-1',success:true}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(service.status().state,'connected');assert.equal(JSON.parse(fs.readFileSync(file)).tokens.access_token,'new-access');
 assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(changes(),1);
 child.reply({method:'account/login/completed',params:{loginId:'login-1',success:true}});assert.equal(changes(),1);
});
test('failed login never imports a partial credential file or reflects provider secrets',async t=>{
 const {service,file,children}=fixture(t);await service.start();const old=fs.readFileSync(file,'utf8');
 children[0].reply({method:'account/login/completed',params:{loginId:'login-1',success:false,error:'access_token secret!'}});
 assert.equal(service.status().state,'failed');assert.doesNotMatch(JSON.stringify(service.status()),/secret!/);assert.equal(fs.readFileSync(file,'utf8'),old);
});
test('untrusted browser URL or redirect target is rejected',async t=>{
 const {service}=fixture(t,{url:'https://example.com/phish'});assert.equal((await service.start()).state,'failed');assert.equal(service.status().verification_url,null);
 const {service:badRedirect}=fixture(t,{url:browserUrl.replace('http%3A%2F%2Flocalhost','http%3A%2F%2Fuser%40localhost')});
 assert.equal((await badRedirect.start()).state,'failed');
});
test('expired browser link is cleared and a fresh attempt can start',async t=>{
 const {service}=fixture(t,{timeoutMs:25});const first=await service.start();
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(service.status().state,'expired');assert.equal(service.status().verification_url,null);
 const second=await service.start();assert.notEqual(second.id,first.id);assert.equal(second.state,'waiting');
});
test('missing CLI produces an actionable failure without deleting auth',async t=>{
 const {service,file}=fixture(t,{spawnImpl:()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});}});
 assert.equal((await service.start()).state,'failed');assert.equal(JSON.parse(fs.readFileSync(file)).tokens.access_token,'old');
});
test('revoked refresh is reflected in status across instances and a new login clears it',async t=>{
 const dir=tmpDir('revoked-auth');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'auth.json');
 fs.writeFileSync(file,credentials(jwt(1)));let requests=0;
 const auth=new CodexAuth({file,fetch:async()=>{requests++;return{ok:false,status:401,text:async()=>JSON.stringify({error:{code:'refresh_token_invalidated'}})};}});
 await assert.rejects(auth.credentials(),/refresh_token_invalidated/);assert.equal(auth.status().needs_reconnect,true);
 await assert.rejects(auth.credentials(),/reconnect ChatGPT/);assert.equal(requests,1);
 assert.equal(new CodexAuth({file}).status().signed_in,false);
 fs.writeFileSync(file,credentials(jwt(Math.floor(Date.now()/1000)+3600)));
 assert.equal(new CodexAuth({file}).status().signed_in,true);await auth.credentials();assert.equal(requests,1);
});
test('subscription start/status/callback/cancel require console authentication',async t=>{
 const {host}=makeHost();let starts=0,callbacks=0;const service={status:()=>({state:'idle'}),start:()=>{starts++;return{state:'waiting'};},submitCallback:()=>{callbacks++;return{state:'waiting'};},cancel:()=>({state:'cancelled'}),close(){}};
 const server=createServer({host,token:'console-secret',live:false,subscriptionLogin:service});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await host.close();});const base=`http://127.0.0.1:${server.address().port}/api/providers/codex/login`;
 for(const method of ['GET','POST','DELETE'])assert.equal((await fetch(base,{method})).status,401);
 assert.equal((await fetch(`${base}/callback`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'1',callback_url:callbackUrl})})).status,401);
 assert.equal(starts,0);const result=await fetch(base,{method:'POST',headers:{authorization:'Bearer console-secret'}});assert.equal(result.status,200);assert.equal(starts,1);
 const relayed=await fetch(`${base}/callback`,{method:'POST',headers:{authorization:'Bearer console-secret','content-type':'application/json'},body:JSON.stringify({id:'1',callback_url:callbackUrl})});
 assert.equal(relayed.status,200);assert.equal(callbacks,1);
});
