import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { makeHost, makeGate } from '../helpers.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const entered = makeGate();
let calls = 0;
const { host } = makeHost({ script: async function* ({ settings }) {
  calls++;
  entered.release();
  await new Promise(resolve => settings.signal.addEventListener('abort', resolve, { once: true }));
} });
host.registry.create({ id: 'editor', profile: { name: 'Editor' } });
const server = createServer({ host, live: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
let pumping;
try {
  const page = await browser.newPage();
  const requests = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(request.url()); });
  // The screen's run ID is deliberately stale. Agent Stop must use server state.
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const data = await response.json();
    for (const agent of data.agents) if (agent.active_run) agent.active_run.id = 'stale-screen-run';
    await route.fulfill({ response, json: data });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const first = host.userRequest({ agent_id: 'editor', text: 'Wait for Stop' });
  pumping = host.scheduler.pump('editor');
  await entered.promise;
  await page.waitForFunction(() => !document.querySelector('#stop-agent').disabled);
  const queued = host.userRequest({ agent_id: 'editor', text: 'Queued since screen refreshed' });
  await page.locator('#stop-agent').click();
  await pumping;
  await host.drain();
  assert.ok(requests.some(url => url.endsWith('/api/agents/stop')));
  for (const id of [first.id, queued.id]) assert.equal(host.scheduler.durableRuns().find(run => run.id === id).status, 'cancelled');
  assert.equal(calls, 1, 'queued model call must never start');
  console.log('PASS: Stop cancels current and unseen queued work despite a stale screen run ID.');
} finally {
  host.scheduler.cancelAgent('editor');
  await pumping;
  for (const context of browser.contexts()) for (const page of context.pages()) await page.unrouteAll({ behavior: 'wait' });
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await host.close();
}
