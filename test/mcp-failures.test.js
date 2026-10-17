import test from 'node:test';
import assert from 'node:assert/strict';
import { MCPClient, flattenResult } from '../src/tools/mcp-client.js';

test('MCP success wrappers preserve an explicit service failure in JSON text', async () => {
  const payload = { success: false, error: 'Search provider rate limited', status: 429, retry_after_ms: 120000 };
  const client = new MCPClient({ transport: 'http', url: 'https://search.test/mcp' }, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    },
  });
  const result = await client.callTool('search', { query: 'public contracts' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'upstream_error');
  assert.equal(result.message, 'Search provider rate limited');
  assert.equal(result.status, 429);
  assert.equal(result.retry_after_ms, 120000);
  assert.deepEqual(JSON.parse(result.text), payload);
});

test('structured service failures remain failures and preserve their evidence', () => {
  const structured = { ok: false, error: { message: 'Authentication required' }, statusCode: 403 };
  const result = flattenResult({ structuredContent: structured, content: [{ type: 'text', text: 'Request completed.' }] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'upstream_error');
  assert.equal(result.message, 'Authentication required');
  assert.equal(result.status, 403);
  assert.deepEqual(result.structured, structured);
  assert.equal(result.text, 'Request completed.');
});

test('explicit structured success takes precedence over JSON error examples in document text', () => {
  const text = JSON.stringify({ success: false, error: 'RATE_LIMITED', status: 429 });
  for (const structuredContent of [{ success: true, data: 'API reference' }, { ok: true, data: 'API reference' }]) {
    const result = flattenResult({ structuredContent, content: [{ type: 'text', text }] });
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.status, undefined);
    assert.equal(result.text, text);
  }
  assert.equal(flattenResult({ isError: true, structuredContent: { success: true }, content: [{ type: 'text', text }] }).ok, false);
});

test('structured failure codes remain available even when error prose omits the failure category', () => {
  for (const [structuredContent, expected] of [
    [{ success: false, error: { code: 'RATE_LIMITED', message: 'Quota exhausted' } }, 'RATE_LIMITED'],
    [{ success: false, code: 'CAPTCHA_REQUIRED', message: 'Complete the puzzle' }, 'CAPTCHA_REQUIRED'],
  ]) {
    const result = flattenResult({ structuredContent, content: [{ type: 'text', text: 'Request failed.' }] });
    assert.equal(result.ok, false);
    assert.equal(result.upstream_code, expected);
    assert.equal(result.error, 'upstream_error');
  }
});

test('an unflagged standalone MCP quota notice is a rate-limit failure', () => {
  const text = "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.";
  const result = flattenResult({ content: [{ type: 'text', text }] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'upstream_error');
  assert.equal(result.message, text);
  assert.equal(result.status, 429);
});

test('ordinary document data and unflagged prose do not become service failures', () => {
  for (const payload of [
    { success: true, data: { success: false, error: 'This is a document example' } },
    { data: [{ ok: false, error: 'A listed record, not the request status' }] },
    { success: 'false', error: 'Not a boolean failure flag' },
  ]) {
    assert.equal(flattenResult({ content: [{ type: 'text', text: JSON.stringify(payload) }] }).ok, true);
  }
  assert.deepEqual(flattenResult({ content: [{ type: 'text', text: 'A page discussing rate limits and CAPTCHA.' }] }), {
    ok: true, text: 'A page discussing rate limits and CAPTCHA.',
  });
  const notice = "You've hit Exa's free MCP rate limit.";
  for (const text of [`The documentation quotes this error: ${notice}`, `"${notice}"`]) {
    assert.equal(flattenResult({ content: [{ type: 'text', text }] }).ok, true);
  }
  assert.equal(flattenResult({ structuredContent: { success: true, data: [] }, content: [{ type: 'text', text: notice }] }).ok, true);
});

test('HTTP rate limits expose status and Retry-After without retrying the request', async () => {
  let requests = 0;
  const client = new MCPClient({ transport: 'http', url: 'https://search.test/mcp' }, {
    fetchImpl: async () => {
      requests += 1;
      return new Response('Request quota exceeded', { status: 429, headers: { 'Retry-After': '120' } });
    },
  });
  await assert.rejects(client.callTool('search', {}), (error) => {
    assert.equal(error.code, 'mcp_http_error');
    assert.deepEqual(error.details, { status: 429, retry_after: '120', retry_after_ms: 120000 });
    return true;
  });
  assert.equal(requests, 1);
});

test('HTTP-date Retry-After uses the response Date and invalid values are omitted', async () => {
  for (const [retryAfter, expected] of [
    ['Fri, 11 Sep 2026 13:02:00 GMT', { status: 503, retry_after: 'Fri, 11 Sep 2026 13:02:00 GMT', retry_after_ms: 120000 }],
    ['not-a-date', { status: 503 }],
    ['-1', { status: 503 }],
  ]) {
    const client = new MCPClient({ transport: 'http', url: 'https://search.test/mcp' }, {
      fetchImpl: async () => new Response('Unavailable', { status: 503, headers: { Date: 'Fri, 11 Sep 2026 13:00:00 GMT', 'Retry-After': retryAfter } }),
    });
    await assert.rejects(client.callTool('search', {}), (error) => {
      assert.deepEqual(error.details, expected);
      return true;
    });
  }
});

test('HTTP authentication errors preserve the status for attention classification', async () => {
  for (const status of [401, 403]) {
    const client = new MCPClient({ transport: 'http', url: 'https://search.test/mcp' }, {
      fetchImpl: async () => new Response('Sign in required', { status }),
    });
    await assert.rejects(client.callTool('search', {}), (error) => {
      assert.equal(error.code, 'mcp_unauthorized');
      assert.equal(error.details.status, status);
      return true;
    });
  }
});
