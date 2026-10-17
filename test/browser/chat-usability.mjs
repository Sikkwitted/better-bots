// Run with PLAYWRIGHT_MODULE pointing at playwright/index.mjs when not installed locally.
// This uses a temporary host and fake model; it never contacts a provider.
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { makeHost, say, call, makeGate } from '../helpers.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { host } = makeHost({ script: () => [say('done')] });
host.registry.create({ id: 'agt_ui', profile: { name: 'Morgan', model: 'glm-5.3-flash', model_provider: 'glm' } });
for (let i = 0; i < 35; i++) host.transcripts.append('agent', 'agt_ui', { kind: 'agent_text', text: `Message ${i}: ` + 'Example content '.repeat(12) });
const server = createServer({ host, live: false, catalog: { list: async () => ({ models: [{id:'glm-5.3-flash',provider:'glm'}],providers:[] }) } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:1100,height:800}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  let holdState = false, releaseState, pauseStatusPolling = false;
  await page.route('**/api/state', async route => {
    const response = await route.fetch(); const state = await response.json();
    if (pauseStatusPolling) for (const agent of state.agents) agent.active_run = null;
    state.reconciliation = [{kind:'memory',id:'a'.repeat(128),revision:1,record:{text:'Example memory',id:'b'.repeat(128)}}];
    if (holdState) { holdState=false; await new Promise(resolve=>{releaseState=resolve;}); }
    await route.fulfill({response,json:state});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  // Long identities and many live controls wrap the header; nothing is clipped, scrolled
  // sideways, or drawn over the chat log.
  const header = page.locator('.chat-head');
  const headerFits = () => page.evaluate(() => {
    const head = document.querySelector('.chat-head').getBoundingClientRect();
    const log = document.querySelector('#transcript').getBoundingClientRect();
    const meta = document.querySelector('#chat-meta');
    const controls = [...meta.children].map(e => e.getBoundingClientRect());
    return {
      height: head.height,
      sideways: meta.scrollWidth > meta.clientWidth + 1,
      clipped: controls.some(r => r.bottom > head.bottom + 1 || r.right > head.right + 1),
      overlaps: log.top < head.bottom - 1,
    };
  });
  const before = await headerFits();
  await page.evaluate(() => {
    document.querySelector('#chat-title small').textContent = 'Long model and role '.repeat(30);
    document.querySelector('#chat-meta').innerHTML = '<button>Cancel queued run</button>'.repeat(12);
  });
  const crowded = await headerFits();
  assert.ok(crowded.height >= before.height, 'the header grows rather than shrinking');
  assert.deepEqual({ sideways: crowded.sideways, clipped: crowded.clipped, overlaps: crowded.overlaps },
    { sideways: false, clipped: false, overlaps: false });
  await page.locator('#open-app-settings').click();
  await page.locator('[data-settings-page=plugins]').click();
  await page.locator('#plugins .provider').first().waitFor();
  await page.locator('#plugin-search').fill('no-such-plugin-123');
  assert.equal(await page.locator('#plugins > .provider:visible').count(), 0);
  await page.locator('#plugin-search').fill('');
  await page.screenshot({path:'/tmp/better-bots-settings-desktop.png'});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:'/tmp/better-bots-settings-dark.png'});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.locator('#app-settings').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  await page.screenshot({path:'/tmp/better-bots-settings-mobile.png'});
  await page.keyboard.press('Escape');
  const phone = await headerFits();
  assert.ok(phone.height >= 128, `phone header is ${phone.height}px`);
  assert.deepEqual({ sideways: phone.sideways, clipped: phone.clipped, overlaps: phone.overlaps },
    { sideways: false, clipped: false, overlaps: false });
  await page.screenshot({path:'/tmp/better-bots-chat-mobile.png'});
  await page.setViewportSize({width:1100,height:800});
  await page.reload();
  const view=page.locator('#transcript');
  await page.getByText('Message 34:', {exact:false}).waitFor();
  await view.hover(); await page.mouse.wheel(0,-1); await page.waitForTimeout(100);
  await page.evaluate(()=>{document.querySelector('#transcript-content').lastElementChild.style.height='1000px';});
  await page.waitForTimeout(300);
  assert.ok(await view.evaluate(v=>v.scrollHeight-v.scrollTop-v.clientHeight)<3,'small bottom movement must not lose follow lock');
  await page.mouse.wheel(0,-400); await page.waitForTimeout(300);
  const top=await view.evaluate(v=>v.scrollTop);
  await page.evaluate(()=>{document.querySelector('#thoughts').hidden=false;}); await page.waitForTimeout(150);
  assert.ok(Math.abs(await view.evaluate(v=>v.scrollTop)-top)<3,'reading older messages survives thinking area resize');
  const card=page.locator('#approvals .card').filter({hasText:'Memory save interrupted'});
  await card.locator('summary').click();
  assert.ok(await card.evaluate(c=>c.scrollWidth<=c.clientWidth+1),'long reference and JSON fit card');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.locator('#edit-reasoning').selectOption('low');
  await page.locator('#settings-form button[type=submit]').click();
  await page.getByText('Settings saved',{exact:true}).waitFor();
  assert.equal(host.registry.get('agt_ui').profile.reasoning_effort,'low');
  await page.reload(); await page.getByRole('button',{name:'Settings',exact:true}).click();
  assert.equal(await page.locator('#edit-reasoning').inputValue(),'low','saved level survives reload');
  await page.locator('#settings-form [data-cancel]').click();
  await page.locator('#open-app-settings').click(); await page.locator('[data-settings-page=permissions]').click();
  assert.equal(await page.locator('.rail-right #providers, .rail-right #plugins, .rail-right #activity').count(),0);
  assert.equal(await page.locator('.rail-right #permissions').count(),0,'permissions belong in Settings, not the sidebar');
  for (const mode of ['always','never','ask']) {
    const card=page.locator('#app-settings #permissions .card[data-zone=external]');
    const button=card.locator(`button[data-mode=${mode}]`);
    await button.hover(); await page.mouse.down();
    host.audit.record('memory.remembered',{agent_id:'agt_ui'});
    await page.waitForTimeout(350); // refresh between pointer-down and pointer-up
    await page.mouse.up();
    await page.waitForFunction(({mode})=>document.querySelector('#permissions .card[data-zone=external] button[aria-pressed="true"]')?.dataset.mode===mode,{mode});
    // The button shows the choice at once and saves in the background; wait for the
    // save itself. A click lost to the refresh would never save, and still fails here.
    for (const until=Date.now()+5000; host.permissions.standingMode('external')!==mode && Date.now()<until;) await page.waitForTimeout(25);
    assert.equal(host.permissions.standingMode('external'),mode,'the click actually persisted');
  }
  // An old state response must not undo a choice saved while that read was in flight.
  holdState=true;
  host.audit.record('memory.remembered',{agent_id:'agt_ui'});
  while (!releaseState) await new Promise(resolve=>setTimeout(resolve,20));
  const external=page.locator('#permissions .card[data-zone=external]');
  await external.locator('button[data-mode=always]').click();
  await page.waitForFunction(()=>document.querySelector('#permissions .card[data-zone=external] button[aria-pressed="true"]')?.dataset.mode==='always');
  releaseState(); await page.waitForTimeout(300);
  assert.equal(await external.locator('button[aria-pressed="true"]').getAttribute('data-mode'),'always','late state must not unselect saved choice');
  for (const until=Date.now()+5000; host.permissions.standingMode('external')!=='always' && Date.now()<until;) await page.waitForTimeout(25);
  await page.reload(); await page.locator('#open-app-settings').click(); await page.locator('[data-settings-page=permissions]').click();
  assert.equal(await page.locator('#permissions .card[data-zone=external]').locator('button[aria-pressed="true"]').getAttribute('data-mode'),'always');
  await page.locator('#close-app-settings').click();
  // Hold the response: the approval click must acknowledge immediately and
  // survive a status refresh before the server acknowledges the saved choice.
  host.permissions.setStandingMode('external','ask');
  const pending = host.permissions.authorize({agent_id:'agt_ui',action:'integration.act',target:'fixture read',scope_id:'approval-fixture',tool:'new_plugin__new_tool'}).request;
  host.audit.record('permission.asked',{request_id:pending.id});
  const approval = page.locator('#approvals .card').filter({hasText:'new_plugin__new_tool'});
  const always = approval.getByRole('button',{name:'Always allow',exact:true});
  await always.waitFor();
  assert.equal(await always.isEnabled(),true,'a reviewed acting tool has a working Always choice');
  let releaseApproval;
  await page.route('**/api/approve',async route=>{
    await new Promise(resolve=>{releaseApproval=resolve});
    await route.continue();
  });
  await always.hover(); await page.mouse.down();
  host.audit.record('memory.remembered',{agent_id:'agt_ui'});
  await page.waitForTimeout(350); await page.mouse.up();
  await approval.getByRole('button',{name:'Always allow — saving…',exact:true}).waitFor({timeout:1000});
  host.audit.record('memory.remembered',{agent_id:'agt_ui'});
  await page.waitForTimeout(350);
  assert.equal(await approval.getByRole('button',{name:'Always allow — saving…',exact:true}).count(),1);
  releaseApproval();
  await approval.waitFor({state:'detached'});
  assert.equal(host.permissions.standingMode('external'),'always');
  assert.equal(host.permissions.authorize({agent_id:'agt_ui',action:'integration.act',target:'different tool target',scope_id:'next-run',tool:'another_new_plugin__tool'}).decision,'allowed');
  await page.locator('#quick-reasoning').selectOption('max');
  await page.getByText('Reasoning level saved',{exact:true}).waitFor();
  assert.equal(host.registry.get('agt_ui').profile.reasoning_effort,'max');
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#quick-reasoning').value==='max');
  await page.setViewportSize({width:874,height:890});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'window has no horizontal overflow');
  // A reasoning stream stays after the latest message, retains its first words,
  // and remains expandable after completion and a page reload.
  let finishThinking, continueThinking;
  const nextThinking = new Promise(resolve => { continueThinking = resolve; });
  const waitThinking = new Promise(resolve => { finishThinking = resolve; });
  const reasoning = 'FIRST REASONING SENTENCE. ' + 'Visible work in progress. '.repeat(100) + 'LAST REASONING SENTENCE.';
  host.adapter.script = () => (async function* () {
    yield {type:'thinking', text:reasoning.slice(0,1500)};
    await nextThinking;
    yield {type:'thinking', text:reasoning.slice(1500)};
    await waitThinking;
    yield say('Reasoning test complete.');
  })();
  pauseStatusPolling = true; // prove reasoning arrives through SSE, not the status timer
  host.userRequest({agent_id:'agt_ui', text:'Reasoning visibility test'});
  const draining = host.drain();
  const liveReasoning = page.locator('.reasoning-block').last();
  await liveReasoning.locator('.reasoning-preview').waitFor();
  await page.waitForTimeout(1000); // let the run-start SSE update settle
  continueThinking();
  await page.waitForFunction(text=>document.querySelector('.reasoning-block:last-child .reasoning-text')?.textContent===text,reasoning,{timeout:3500});
  assert.equal(await page.getByText('Reasoning test complete.',{exact:true}).count(),0,'reasoning must arrive before the answer is released');
  assert.equal(await liveReasoning.locator('.reasoning-text').textContent(),reasoning);
  assert.equal(await liveReasoning.evaluate(e=>e.open),false);
  const ticker = liveReasoning.locator('.reasoning-preview');
  assert.ok(await ticker.evaluate(e=>e.clientHeight <= parseFloat(getComputedStyle(e).lineHeight)*2+1),'live preview is two lines');
  // Stream text changes before the animation frame applies its follow scroll.
  await page.waitForFunction(() => {
    const preview = [...document.querySelectorAll('.reasoning-preview')].at(-1);
    return preview && preview.scrollHeight - preview.scrollTop - preview.clientHeight < 2;
  });
  assert.ok(await ticker.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)<2,'live preview follows the latest lines');
  await liveReasoning.locator('summary').click();
  assert.equal(await liveReasoning.evaluate(e=>e.open),true);
  await liveReasoning.locator('summary').click();
  assert.equal(await liveReasoning.locator('.reasoning-face img').count(),1);
  assert.equal(await liveReasoning.locator('.working-bubble i').count(),3);
  assert.equal(await page.locator('#thoughts').evaluate(e=>e.parentElement.id),'transcript');
  if(process.env.REASONING_SCREENSHOT) await page.screenshot({path:process.env.REASONING_SCREENSHOT});
  finishThinking(); await draining;
  await page.getByText('Reasoning test complete.',{exact:true}).waitFor();
  await page.reload();
  await page.locator('.reasoning-block').last().waitFor({state:'attached'});
  assert.equal(await page.locator('.reasoning-block').last().evaluate(e=>e.open),false,'completed reasoning stays collapsed');
  assert.equal(await page.locator('.reasoning-text').last().textContent(),reasoning);
  assert.ok(await page.locator('.reasoning-block').last().evaluate(e=>Boolean(e.compareDocumentPosition([...document.querySelectorAll('.from-agent')].at(-1)) & Node.DOCUMENT_POSITION_FOLLOWING)));
  for (const entry of [
    {kind:'agent_text',run_id:'progress-fixture',text:'Checking the first page. '.repeat(12)},
    {kind:'tool_call',run_id:'progress-fixture',name:'OpenScreen'},
    {kind:'tool_result',run_id:'progress-fixture',name:'OpenScreen',result:{ok:true}},
    {kind:'agent_text',run_id:'progress-fixture',text:'Opening the editor.'},
    {kind:'tool_call',run_id:'progress-fixture',name:'UseScreen'},
    {kind:'tool_result',run_id:'progress-fixture',name:'UseScreen',result:{ok:true}},
    {kind:'agent_text',run_id:'progress-fixture',text:'The requested changes are complete.'},
  ]) host.transcripts.append('agent','agt_ui',entry);
  await page.reload();
  await page.getByText('The requested changes are complete.',{exact:true}).waitFor();
  assert.equal(await page.locator('.agent-progress').count(),0,'no per-step update dropdowns');
  const activity=page.locator('.turn-activity').last();
  assert.equal(await activity.evaluate(e=>e.open),false);
  assert.equal(await activity.locator('details').count(),0,'no nested dropdowns');
  await activity.locator(':scope > summary').click();
  assert.equal(await activity.locator('.event').count(),4,'both calls and results in one inspector');
  assert.equal(await page.locator('.from-agent').filter({hasText:'The requested changes are complete.'}).count(),1);
  await activity.locator(':scope > summary').click();
  // Exercise the actual host loop, not prebuilt transcript rows: four provider
  // requests, three tools, streaming reasoning, final multi-block reply, reload.
  const gates = Array.from({length:4},()=>makeGate());
  let step = 0;
  host.tools.register({name:'PreviewProbe',description:'UI test',side_effect:'none',permission:null,input_schema:{type:'object'},handler:()=>({ok:true})});
  host.adapter.script = () => (async function* () {
    const index=step++;
    yield {type:'thinking',text:`STEP ${index} reasoning. ` + 'Reading the fixture. '.repeat(80)};
    await gates[index].promise;
    if(index<3) {yield say(`Intermediate narration ${index}`);yield call('PreviewProbe',{});}
    else {yield say('FINAL FIRST PART.');yield say('FINAL SECOND PART.');}
  })();
  const beforeGroups=await page.locator('.turn-activity').count();
  const beforeReplies=await page.locator('.from-agent').count();
  host.userRequest({agent_id:'agt_ui',text:'One complete multi-step request'});
  const multiDrain=host.drain();
  for(let index=0;index<4;index++) {
    await page.waitForFunction(index=>document.querySelector('.turn-activity:last-child .reasoning-preview')?.textContent.startsWith(`STEP ${index} reasoning.`),index);
    assert.equal(await page.locator('.turn-activity').count(),beforeGroups+1,'one activity section throughout the tool loop');
    assert.equal(await page.locator('.from-agent').count(),beforeReplies,'no intermediate reply bubbles');
    assert.equal(await page.locator('.turn-activity').last().locator('details').count(),0);
    if(index===1) {
      await page.locator('.turn-activity').last().locator(':scope > summary').click();
      host.audit.record('memory.remembered',{agent_id:'agt_ui'});
      await page.waitForTimeout(500);
      assert.equal(await page.locator('.turn-activity').last().evaluate(e=>e.open),true,'refresh preserves expanded inspector');
      await page.locator('.turn-activity').last().locator(':scope > summary').click();
      await page.reload();
      await page.locator('.turn-activity').last().locator('.reasoning-preview').waitFor();
      assert.equal(await page.locator('.turn-activity').count(),beforeGroups+1,'reload preserves one section');
    }
    gates[index].release();
  }
  await multiDrain;
  await page.locator('.from-agent').filter({hasText:'FINAL FIRST PART.'}).filter({hasText:'FINAL SECOND PART.'}).last().waitFor();
  assert.equal(await page.locator('.from-agent').count(),beforeReplies+1,'one final reply across provider text blocks');
  await page.reload();
  await page.locator('.from-agent').filter({hasText:'FINAL FIRST PART.'}).filter({hasText:'FINAL SECOND PART.'}).last().waitFor();
  const completed=page.locator('.turn-activity').last();
  assert.equal(await completed.evaluate(e=>e.open),false);
  await completed.locator(':scope > summary').click();
  assert.equal(await completed.locator('.event').count(),6);
  assert.equal(await completed.locator('details').count(),0);
  assert.ok((await completed.locator('.reasoning-text').textContent()).includes('STEP 0 reasoning.'));
  assert.ok((await completed.locator('.reasoning-text').textContent()).includes('STEP 3 reasoning.'));
  assert.ok(await completed.locator('.working-body').evaluate(e=>e.clientHeight<=361 && e.scrollHeight>e.clientHeight),'history scrolls within one bounded inspector');
  assert.ok(await completed.evaluate(e=>{
    const text=e.querySelector('.reasoning-text').getBoundingClientRect();
    const tool=e.querySelector('.event').getBoundingClientRect();
    return tool.top>=text.bottom && text.height>200;
  }),'expanded reasoning retains its height and tool rows start below it');
  if(process.env.HISTORY_SCREENSHOT)await page.screenshot({path:process.env.HISTORY_SCREENSHOT});
  await completed.locator(':scope > summary').click();
  const queuedStop = host.userRequest({agent_id:'agt_ui',text:'Stop-button test only'});
  await page.reload();
  await page.waitForFunction(()=>!document.querySelector('#stop-agent').disabled);
  await page.locator('#stop-agent').click();
  await page.waitForFunction(()=>document.querySelector('#stop-agent').disabled);
  assert.equal(host.scheduler.durableRuns().find(run=>run.id===queuedStop.id)?.status,'cancelled');
  assert.deepEqual(errors,[]);
  if(process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT});
  console.log('PASS: bottom follow, intentional scroll, narrow cards, reasoning save/reload, permission clicks during live refresh, full reasoning stream and history, no browser errors');
} finally {for (const context of browser.contexts()) for (const page of context.pages()) await page.unrouteAll({behavior:'ignoreErrors'}); await browser.close(); await new Promise(resolve=>server.close(resolve)); await host.close();}
