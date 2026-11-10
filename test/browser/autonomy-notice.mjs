import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { makeHost, say } from '../helpers.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

// The first open says, before anything else, that bots work without asking.
// Escape cannot skip it; accepting is remembered, so it never shows again.
const { host } = makeHost({ script: () => [say('done')] });
host.registry.create({ id: 'agt_ui', profile: { name: 'Test' } });
const server = createServer({ host, live: false, catalog: { list: async () => ({ models: [], providers: [] }) } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  const notice = page.locator('#autonomy-notice');
  await notice.waitFor({ state: 'visible' });
  assert.match(await notice.textContent(), /without asking you first/);
  await page.keyboard.press('Escape');
  assert.equal(await notice.isVisible(), true, 'Escape does not skip the notice');
  assert.equal(host.status().autonomy_acknowledged, false);

  await page.getByRole('button', { name: 'I understand, let them work' }).click();
  await notice.waitFor({ state: 'hidden' });
  assert.equal(host.status().autonomy_acknowledged, true);
  assert.equal(host.audit.where(e => e.type === 'permission.autonomy_acknowledged').length, 1);

  const state = page.waitForResponse(response => response.url().includes('/api/state'));
  await page.reload();
  await state;
  await page.waitForTimeout(1500); // several refreshes: the notice stays closed
  assert.equal(await notice.isVisible(), false, 'accepted once, never shown again');
  assert.deepEqual(errors, []);
  console.log('PASS: first-open autonomy notice cannot be skipped and is remembered once accepted.');
} finally {
  await browser.close();
  server.close();
}
