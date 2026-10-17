import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { makeHost, say } from '../helpers.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { host } = makeHost({ script: () => [say('Ready.')] });
host.registry.create({ id: 'editor', profile: { name: 'Editor', model: 'old-model', model_provider: 'deepseek', desk: 'A very long editorial desk name', lead: true } });
host.registry.create({ id: 'reviewer', profile: { name: 'Reviewer', desk: 'A very long editorial desk name' } });
host.registry.create({ id: 'writer', profile: { name: 'Writer', desk: 'A very long editorial desk name' } });
const room = host.createRoom({ member_ids: ['reviewer'], purpose: 'Editorial room', memory: 'none' });
host.deliverPeerMessage({ sender_id: 'editor', target_id: room.id, text: 'Review the outline.' });
const catalog = { list: async () => ({ models: [{ id: 'old-model', provider: 'deepseek' }, { id: 'new-model', provider: 'deepseek' }], providers: [] }) };
const server = createServer({ host, live: false, catalog });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 713, height: 1018 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#edit-model').selectOption(JSON.stringify(['deepseek', 'new-model']));
  let release, saves = 0;
  await page.route('**/api/agents', async route => {
    if (route.request().method() === 'PATCH') {
      saves += 1;
      await new Promise(resolve => { release = resolve; });
    }
    await route.continue();
  });
  await page.locator('#settings-form button[type=submit]').click();
  await page.getByRole('button', { name: 'Saving…', exact: true }).waitFor();
  assert.equal(await page.locator('#settings-form button[type=submit]').isDisabled(), true);
  await page.locator('#settings-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('#settings-change-note').textContent === 'Saving settings…');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves, 1);
  release();
  await page.getByText('Settings saved', { exact: true }).waitFor();
  assert.equal(host.registry.get('editor').profile.model, 'new-model');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.locator('#edit-model').inputValue(), JSON.stringify(['deepseek', 'new-model']));
  await page.locator('#settings-form [data-cancel]').click();

  // Lead selection remains reachable without a context menu or horizontal header scrolling.
  await page.locator('[data-pane="agents"]').click();
  await page.getByRole('button', { name: /Reviewer/ }).first().click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#edit-lead').click();
  await page.getByText('Reviewer is now the desk lead', { exact: true }).waitFor();
  assert.equal(host.registry.get('reviewer').profile.lead, true);
  assert.equal(host.registry.get('editor').profile.lead, false);
  assert.equal(await page.locator('#edit-lead').textContent(), 'Desk lead');
  await page.locator('#settings-form [data-cancel]').click();

  const ask = recipient => host.permissions.authorize({ agent_id: 'editor', action: 'coordination.fanout', target: JSON.stringify({ target_id: recipient, recipients: [recipient] }), scope_id: 'outline-task', tool: 'SendToAgent' }).request;
  const first = ask('reviewer');
  host.permissions.attachEvidence(first.id, { screenshot: 'unrelated-screen', view: 'unrelated-desktop-command' });
  host.audit.record('permission.asked', { request_id: first.id });
  const card = page.locator('#approvals .card').filter({ hasText: 'To: Reviewer' });
  // Mobile attention pane is selected explicitly; desktop still renders the same card.
  const attention = page.locator('[data-pane="activity"]');
  if (await attention.count()) await attention.click();
  await card.waitFor({ state: 'attached' });
  assert.equal(await card.locator('img').count(), 0);
  assert.equal(await card.getByRole('button', { name: 'Always allow', exact: true }).count(), 0, 'a per-recipient OK offers no standing rule');
  // Layout-independent click checks the same handler when the responsive rail is hidden.
  await card.getByRole('button', { name: 'Allow once', exact: true }).evaluate(button => button.click());
  await card.waitFor({ state: 'detached' });
  assert.equal(host.permissions.getRequest(first.id).resolution, 'allow_once');
  const second = ask('writer'); host.audit.record('permission.asked', { request_id: second.id });
  await page.locator('#approvals .card').filter({ hasText: 'To: Writer' }).waitFor({ state: 'attached' });
  assert.equal(host.permissions.getRequest(second.id).resolution, null);
  await page.getByRole('button', { name: /Editorial room/ }).first().click();
  await page.getByRole('button', { name: 'Start discussion', exact: true }).click();
  await page.getByText('Discussion finished.', { exact: true }).waitFor();
  assert.ok(host.transcripts.all('room', room.id).some(entry => entry.sender_id === 'reviewer' && entry.text === 'Ready.'));
  const epoch = host.rooms.get(room.id).epoch;
  await page.getByRole('button', { name: 'Start discussion', exact: true }).click();
  await page.getByText('This message already has a discussion. Send a new message to continue.', { exact: true }).waitFor();
  assert.equal(host.rooms.get(room.id).epoch, epoch);
  for (let i = 0; i < 7; i++) host.registry.create({id:`member${i}`,profile:{name:`Member ${i}`}});
  host.rooms.doc.update(state => { state.rooms[room.id].member_ids = ['reviewer', ...Array.from({length:7},(_,i)=>`member${i}`)]; return state; });
  host.audit.record('room.updated',{room_id:room.id});
  await page.waitForFunction(()=>document.querySelector('#chat-title .members-row')?.children.length===8);
  assert.ok(await page.locator('#chat-title').evaluate(title => title.querySelector('strong').getBoundingClientRect().left >= title.querySelector('.members-row').getBoundingClientRect().right), 'eight avatars must not overlap the room title');
  assert.deepEqual(errors, []);
  console.log('PASS: model save/reload, lead promotion, distinct recipient approvals, and explicit room start/repeat protection.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await host.close();
}
