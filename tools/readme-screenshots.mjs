// Not a test: renders README screenshots from a temporary host with a scripted model.
import { createServer } from '../src/server.js';
import { makeHost, tmpDir, say, call, isToolFollowUp } from '../test/helpers.js';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const OUT = process.env.SHOTS || new URL('../docs/images/', import.meta.url).pathname;
const report = `# Home espresso machines under $500\n\n| Machine | Price | Verdict |\n|---|---|---|\n| Breville Bambino Plus | $399 | Best for beginners |\n| Gaggia Classic Pro | $449 | Best for tinkerers |\n| De'Longhi Dedica | $249 | Best on a budget |\n`;
const adapter = new ScriptedAdapter((ctx) => {
  if (ctx.agent_id === 'agt_lead') return isToolFollowUp(ctx)
    ? [say("Done. Riley compared 14 machines, Sam wrote the report and Quinn checked every price against the store pages. The report is in **espresso-report.md**: the Breville Bambino Plus is the best pick under $500, with the Gaggia Classic Pro if you like to tinker.")]
    : [call('SandboxWriteFile', { path: 'espresso-report.md', content: report })];
  return [say('ok')];
});
adapter.model = 'claude-sonnet-5-5';
const host = new Host({ dir: tmpDir('demo'), adapter });
host.permissions.acknowledgeAutonomy();
host.registry.create({ id: 'agt_lead', profile: { avatar_shape: 'round', avatar_style: 'headset', avatar_color: '#51FFCD', name: 'Avery', role: 'Lead', model: 'claude-sonnet-5-5', model_provider: 'anthropic' } });
host.registry.create({ id: 'agt_r', profile: { avatar_shape: 'blob', avatar_style: 'glasses', avatar_color: '#FEDE8D', name: 'Riley', role: 'Researcher', model: 'gpt-5.2', model_provider: 'openai' } });
host.registry.create({ id: 'agt_w', profile: { avatar_shape: 'droplet', avatar_style: 'pencil', avatar_color: '#FF8234', name: 'Sam', role: 'Writer', model: 'claude-sonnet-5-5', model_provider: 'anthropic' } });
host.registry.create({ id: 'agt_c', profile: { avatar_shape: 'square', avatar_style: 'monocle', avatar_color: '#E1FFF3', name: 'Quinn', role: 'Fact-checker', model: 'qwen3:32b', model_provider: 'ollama' } });
host.userRequest({ agent_id: 'agt_lead', text: 'Find the best home espresso machine under $500. Compare prices, write it up as a short report, and have someone double-check the prices.' });
await host.drain();
const server = createServer({ host, live: true, catalog: { list: async () => ({ models: [], providers: [] }) } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
try {
  for (const [scheme, suffix] of [['dark', ''], ['light', '-light']]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: scheme });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForTimeout(1200);
    await page.getByText('Avery').first().click().catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/console${suffix}.png` });
    await page.close();
  }
  const fresh = makeHost();
  const s2 = createServer({ host: fresh.host, live: false, catalog: { list: async () => ({ models: [], providers: [] }) } });
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await page.goto(`http://127.0.0.1:${s2.address().port}`);
  await page.locator('#autonomy-notice').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/notice.png` });
  s2.close();
} finally { await browser.close(); server.close(); }
console.log('shots written');
