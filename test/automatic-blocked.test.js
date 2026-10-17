import test from 'node:test';
import assert from 'node:assert/strict';
import { HostError } from '../src/core/util.js';
import { flattenResult } from '../src/tools/mcp-client.js';
import { call, makeHost, reopenHost } from './helpers.js';

function fixture(outcome, { name = 'source__search', integration = 'source' } = {}) {
  const setup = makeHost({ script: () => [call(name, { url: 'https://example.com/search' })] });
  setup.host.registry.create({ id: 'agt_research', profile: { name: 'Researcher' } });
  setup.host.tools.register({
    name, integration, description: 'Controlled read result.', side_effect: 'None.', permission: null,
    input_schema: { type: 'object', properties: { url: { type: 'string' } } },
    handler: typeof outcome === 'function' ? outcome : () => outcome,
  });
  return setup;
}

async function run(host) {
  const queued = host.userRequest({ agent_id: 'agt_research', text: 'Find a verified lead.' });
  await host.drain();
  return queued;
}

test('an HTTP rate limit raises visible attention even when the model never calls ReportBlocked', async () => {
  const { host } = fixture(() => { throw new HostError('mcp_http_error', 'example.com answered 429', { status: 429, retry_after_ms: 120_000 }); });
  const queued = await run(host);
  const [report] = host.status().blocked;
  assert.ok(report, 'the host must publish the failure without asking the model to notice it');
  assert.equal(report.reason, 'rate_limited');
  assert.equal(report.run_id, queued.id);
  assert.equal(report.source, 'source');
  assert.equal(report.automatic, true);
  assert.match(report.detail, /429/);
  assert.match(report.detail, /120/);
  const entries = host.transcripts.all('agent', 'agt_research');
  assert.ok(entries.some((entry) => entry.kind === 'system_note' && entry.run_id === queued.id && /rate limit/i.test(entry.text)));
  const receipt = entries.find((entry) => entry.kind === 'tool_result').result;
  assert.equal(receipt.status, 429);
  assert.equal(receipt.retry_after_ms, 120_000);
  assert.equal(receipt.blocked_report_id, report.id);
  assert.match(receipt.blocked_note, /do not retry/i);
});

test('explicit challenge, authentication, and timeout failures produce the right attention reason', async () => {
  for (const [outcome, reason] of [
    [{ ok: false, error: 'tool_error', text: 'Request blocked: complete the CAPTCHA to continue.' }, 'captcha'],
    [{ ok: false, error: 'challenge_required', message: 'Human verification is required.' }, 'captcha'],
    [{ ok: false, status: 401, text: 'Unauthorized' }, 'login'],
    [{ ok: false, error: 'mcp_unauthorized', message: 'Sign in again.' }, 'login'],
    [{ ok: false, timed_out: true, exit_code: null, stderr: '', stdout: '' }, 'timeout'],
    [{ ok: false, error: 'mcp_timeout', message: 'tools/call took longer than 30000ms' }, 'timeout'],
    [{ ok: false, status: 403, text: 'Forbidden' }, 'other'],
  ]) {
    const { host } = fixture(outcome);
    await run(host);
    assert.equal(host.status().blocked[0]?.reason, reason, JSON.stringify(outcome));
  }
});

test('structured service error codes trigger attention when the message omits the failure category', async () => {
  const result = flattenResult({
    structuredContent: { success: false, error: { code: 'RATE_LIMITED', message: 'Quota exhausted' } },
    content: [{ type: 'text', text: 'Request failed.' }],
  });
  const { host } = fixture(result);
  await run(host);
  assert.equal(host.status().blocked[0]?.reason, 'rate_limited');
  await run(host);
  const receipts = host.transcripts.all('agent', 'agt_research').filter((entry) => entry.kind === 'tool_result');
  assert.equal(receipts.at(-1).result.error, 'source_cooldown');
});

test('a failed browser launch raises visible attention instead of leaving a silent blank desktop', async () => {
  const { host } = fixture({ ok: false, error: 'screen_action_failed', message: 'Firefox exited before opening the browser (exit 1): snap launch failed.' }, { name: 'UseScreen', integration: null });
  await run(host);
  const [report] = host.status().blocked;
  assert.equal(report?.reason, 'other');
  assert.match(report.detail, /failed to operate its desktop/);
  const entries = host.transcripts.all('agent', 'agt_research');
  assert.ok(entries.some((entry) => entry.kind === 'system_note' && /failed to operate its desktop/.test(entry.text)));
  assert.ok(entries.some((entry) => entry.kind === 'tool_result' && /Firefox exited/.test(entry.result.message)));
});

test('an unresolved source failure is deduped across turns and process restarts', async () => {
  const { host, dir, clock } = fixture({ ok: false, error: 'challenge_required', message: 'Complete the CAPTCHA.' });
  await run(host);
  const [first] = host.status().blocked;
  assert.ok(first);
  await run(host);
  assert.equal(host.status().blocked.length, 1);
  assert.equal(host.status().blocked[0].occurrences, 2);
  assert.equal(host.transcripts.all('agent', 'agt_research').filter((entry) => entry.kind === 'system_note').length, 1);
  const { host: reopened } = reopenHost({ dir, clock, script: () => [call('source__search', { url: 'https://example.com/search' })] });
  reopened.tools.register(host.tools.get('source__search'));
  await run(reopened);
  assert.equal(reopened.status().blocked[0].id, first.id);
  assert.equal(reopened.status().blocked[0].occurrences, 3);
  reopened.resolveBlocked(first.id);
  await run(reopened);
  assert.equal(reopened.status().blocked.length, 0, 'a dismissed notice must not come straight back');
  assert.equal(reopened.blocked.read().items[first.id].suppressed, 1, 'the repeat is still counted');
  // A failure that persists beyond the quiet window is news again.
  clock.advance(13 * 3_600_000);
  await run(reopened);
  assert.equal(reopened.status().blocked.length, 1);
  assert.notEqual(reopened.status().blocked[0].id, first.id);
});

test('successful research prose and ordinary failed page content do not invent blockers', async () => {
  for (const outcome of [
    { ok: true, text: 'CAPTCHA consulting: we discuss rate limits, login, HTTP 429, and timeouts.' },
    { ok: true, structured: { title: 'Authentication guide', body: { ok: false, error: 'captcha' } } },
    { ok: true, upstream_code: 'RATE_LIMITED', text: 'A documented response code.' },
    { ok: false, status: 404, title: 'Missing article', text: 'Our CAPTCHA article moved. Sign in to read about rate limiting.' },
    { ok: false, exit_code: 1, stdout: 'A fixture about CAPTCHA, HTTP 429, and sign in.', stderr: 'assertion failed' },
    { ok: false, error: 'invalid_input', message: 'url is required' },
  ]) {
    const { host } = fixture(outcome);
    await run(host);
    assert.deepEqual(host.status().blocked, [], JSON.stringify(outcome));
  }
});

test('attention deduplication does not hide independent sources or different reasons', async () => {
  const { host } = fixture({ ok: false, error: 'mcp_timeout' });
  await run(host);
  host.tools.register({ ...host.tools.get('source__search'), integration: 'another-source' });
  await run(host);
  host.tools.register({ ...host.tools.get('source__search'), handler: () => ({ ok: false, status: 401 }) });
  await run(host);
  assert.deepEqual(host.status().blocked.map((report) => [report.source, report.reason]), [
    ['source', 'timeout'], ['another-source', 'timeout'], ['another-source', 'login'],
  ]);
});

test('rate-limit cooldown skips calls across agents and restarts until Retry-After expires', async () => {
  let attempts = 0;
  const { host, dir, clock } = fixture(() => {
    attempts += 1;
    return { ok: false, status: 429, retry_after_ms: 3_600_000 };
  });
  host.registry.create({ id: 'agt_second', profile: { name: 'Second researcher' } });
  await run(host);
  host.userRequest({ agent_id: 'agt_second', text: 'Use the same source.' });
  await host.drain();
  assert.equal(attempts, 1, 'another agent must not hammer a rate-limited integration');
  const blocked = host.transcripts.all('agent', 'agt_second').find((entry) => entry.kind === 'tool_result').result;
  assert.equal(blocked.error, 'source_cooldown');
  assert.equal(blocked.retry_after_ms, 3_600_000);
  assert.equal(host.status().blocked.length, 1);
  const { host: reopened } = reopenHost({ dir, clock, script: () => [call('source__search', { url: 'https://another.example/search' })] });
  reopened.tools.register(host.tools.get('source__search'));
  clock.advance(30 * 60_000);
  await run(reopened);
  assert.equal(attempts, 1, 'the remaining Retry-After interval survives a restart');
  clock.advance(30 * 60_000);
  await run(reopened);
  assert.equal(attempts, 2, 'the integration becomes callable when cooldown expires');
});

test('a rate limit without Retry-After gets a 30-minute cooldown', async () => {
  let attempts = 0;
  const { host, clock } = fixture(() => { attempts += 1; return { ok: false, status: 429 }; });
  await run(host);
  clock.advance(29 * 60_000);
  await run(host);
  assert.equal(attempts, 1);
  clock.advance(60_000);
  await run(host);
  assert.equal(attempts, 2);
});

test('a recurring rate limit updates the existing attention card with the new waiting period', async () => {
  let attempts = 0;
  const { host, clock } = fixture(() => ({ ok: false, status: 429, retry_after_ms: ++attempts === 1 ? 60_000 : 7_200_000 }));
  await run(host);
  const [first] = host.status().blocked;
  clock.advance(30 * 60_000);
  await run(host);
  const [updated] = host.status().blocked;
  assert.equal(updated.id, first.id);
  assert.match(updated.detail, /7200 seconds/);
  assert.equal(Date.parse(updated.cooldown_until) - clock.now(), 7_200_000);
});

test('a CAPTCHA on one destination leaves the integration available for other sites', async () => {
  const visited = [];
  const { host } = fixture(({ input }) => {
    visited.push(input.url);
    return input.url.includes('example.com')
      ? { ok: false, error: 'challenge_required' }
      : { ok: true, text: 'A verified public business page.' };
  });
  await run(host);
  const { host: reopened } = reopenHost({ dir: host.dir, clock: host.clock, script: () => [call('source__search', { url: 'https://other.example/contact' })] });
  reopened.tools.register(host.tools.get('source__search'));
  await run(reopened);
  assert.equal(visited.length, 2);
  assert.equal(reopened.status().blocked.length, 1);
  assert.equal(reopened.status().blocked[0].source, 'source:example.com');
});

test('manual ReportBlocked receipts confirm in-app recording without claiming delivery to the person', async () => {
  const { host } = makeHost({ script: () => [call('ReportBlocked', { reason: 'rate_limited', detail: 'Search refused with HTTP 429.', ladder: ['Retried the mirror: also 429'] })] });
  host.registry.create({ id: 'agt_research', profile: { name: 'Researcher' } });
  await run(host);
  const receipt = host.transcripts.all('agent', 'agt_research').find((entry) => entry.kind === 'tool_result').result;
  assert.equal(receipt.attention_status, 'recorded');
  assert.match(receipt.note, /in.app attention/i);
  assert.doesNotMatch(receipt.note, /person has been told|person can now|notified|notification sent/i);
  assert.ok(host.transcripts.all('agent', 'agt_research').some((entry) => entry.kind === 'system_note' && /429/.test(entry.text)));
});
