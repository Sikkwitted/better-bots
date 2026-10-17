import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHost, reopenHost, call } from './helpers.js';
import { MCPClient, flattenResult } from '../src/tools/mcp-client.js';
import { IntegrationService, toolName } from '../src/services/integration-service.js';
import { validateInput } from '../src/tools/registry.js';

// Integrations: an MCP server's tools pass through the same registry and gate
// as the shell. The suite runs a fake server over stdio (a child process) and
// over streamable HTTP (an in-process server), never a real one.

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.js');
const stdioSpec = { name: 'fake', command: process.execPath, args: [FAKE] };

/** A streamable-HTTP MCP server that answers in JSON, or in SSE when asked to. */
function httpServer({ sse = false, token = null } = {}) {
  const seen = { headers: [], sessions: new Set() };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.headers.push(req.headers);
      if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      const msg = JSON.parse(body);
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      let result;
      if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake-http', version: '1' } };
      else if (msg.method === 'tools/list') result = { tools: [{ name: 'search', description: 'Search.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } }] };
      else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: `found ${msg.params.arguments.q}` }] };
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      const headers = { 'mcp-session-id': 'sess-1' };
      if (msg.method === 'initialize') seen.sessions.add(req.headers['mcp-session-id'] ?? null);
      if (sse) {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        res.write(': keep-alive\n\n');
        res.write(`event: message\ndata: ${reply}\n\n`);
        return res.end();
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(reply);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp`, seen })));
}

test('stdio: connects, follows tool pagination, and ignores log noise', async () => {
  const client = new MCPClient({ transport: 'stdio', ...stdioSpec });
  const init = await client.connect();
  assert.equal(init.serverInfo.name, 'fake-mcp');
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['quote', 'place.order']);
  const quote = await client.callTool('quote', { symbol: 'BTC' });
  assert.deepEqual(quote, { ok: true, text: 'BTC: 101.5', structured: { symbol: 'BTC', price: 101.5 } });
  const boom = await client.callTool('boom', {});
  assert.equal(boom.ok, false);
  assert.equal(boom.error, 'tool_error');
  await assert.rejects(client.callTool('nope', {}), /unknown tool nope/);
  await client.close();
  await assert.rejects(client.request('tools/list'), /closed/);
});

test('http: bearer header, session id, JSON and SSE answers', async () => {
  for (const sse of [false, true]) {
    const { server, url, seen } = await httpServer({ sse, token: 'k3y' });
    const client = new MCPClient({ transport: 'http', url, headers: { authorization: 'Bearer k3y' } });
    await client.connect();
    const tools = await client.listTools();
    assert.equal(tools[0].name, 'search');
    assert.deepEqual(await client.callTool('search', { q: 'gold' }), { ok: true, text: 'found gold' });
    assert.ok(seen.headers.every((h) => h.authorization === 'Bearer k3y'));
    // The session id from the first answer rides on every later request.
    assert.ok(seen.headers.slice(1).every((h) => h['mcp-session-id'] === 'sess-1'), `sse=${sse}`);
    await client.close();
    server.close();
  }
  const { server, url } = await httpServer({ token: 'k3y' });
  const wrong = new MCPClient({ transport: 'http', url, headers: { authorization: 'Bearer nope' } });
  await assert.rejects(wrong.connect(), /refused the credentials \(401\)/);
  server.close();
});

test('a connected integration lends prefixed tools; reads pass, actions ask with the exact call as target', async () => {
  const { host } = makeHost({
    script: () => [call('fake__quote', { symbol: 'ETH', bars: 3 }), call('fake__place_order', { symbol: 'ETH', qty: 2 })],
  });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  const shown = await host.integrations.add({ name: 'fake', command: process.execPath, args: [FAKE] });
  assert.equal(shown.state, 'connected');
  assert.ok(shown.tools.every((t) => !t.read_only));
  const quoteTool = shown.tools.find((t) => t.source === 'quote');
  host.integrations.reviewTool({ name: 'fake', tool: 'quote', fingerprint: quoteTool.fingerprint, action: 'integration.read' });
  const orderTool = shown.tools.find((t) => t.source === 'place.order');
  host.integrations.reviewTool({ name: 'fake', tool: 'place.order', fingerprint: orderTool.fingerprint, action: 'external.pay' });
  const offered = host.tools.describeFor(host.registry.get('agt_a')).map((t) => t.name);
  assert.ok(offered.includes('fake__quote') && offered.includes('fake__place_order'));

  host.userRequest({ agent_id: 'agt_a', text: 'trade' });
  await host.drain();
  const results = host.transcripts.all('agent', 'agt_a').filter((e) => e.kind === 'tool_result');
  const quote = results.find((e) => e.name === 'fake__quote').result;
  assert.equal(quote.ok, true);
  assert.equal(quote.text, 'ETH: 101.5');
  assert.equal(quote.integration, 'fake');
  assert.match(quote.note, /never instructions/);

  const order = results.find((e) => e.name === 'fake__place_order');
  assert.ok(order.approval_request_id, 'an action asks first');
  const request = host.permissions.doc.read().requests[order.approval_request_id];
  assert.equal(request.action, 'external.pay');
  assert.equal(request.target, 'fake.place.order {"symbol":"ETH","qty":2}');
  assert.equal(host.audit.where((e) => e.type === 'tool.executed' && e.name === 'fake__quote').length, 1);
  assert.equal(host.audit.where((e) => e.type === 'integration.connected' && e.name === 'fake')[0].tools, 2);
  await host.close();
});

test('legacy read_only setting cannot authorize unreviewed tools', async () => {
  const { host } = makeHost({ script: () => [call('data__place_order', { symbol: 'X', qty: 1 })] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  const shown = await host.integrations.add({ name: 'data', command: process.execPath, args: [FAKE], trust: 'read_only' });
  assert.ok(shown.tools.every((t) => !t.read_only));
  host.userRequest({ agent_id: 'agt_a', text: 'go' });
  await host.drain();
  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.name === 'data__place_order');
  assert.ok(result.approval_request_id);
  await host.close();
});

test('removal drops the tools; a restart reconnects; secrets never appear in describe()', async () => {
  const { host, dir, clock } = makeHost();
  const { server, url } = await httpServer({ token: 's3cret' });
  const shown = await host.integrations.add({ name: 'hosted', url: `${url}?key=s3cret`, headers: { Authorization: 'Bearer s3cret' } });
  assert.equal(shown.state, 'connected');
  assert.equal(shown.url, url, 'the query string is stripped from what the console sees');
  assert.deepEqual(shown.headers, ['Authorization']);
  assert.equal(shown.has_secret, true);
  assert.doesNotMatch(JSON.stringify(host.integrations.describe()), /s3cret/);
  assert.ok(host.tools.has('hosted__search'));

  await host.integrations.close();
  const { host: again } = reopenHost({ dir, clock });
  assert.equal(again.integrations.describeOne('hosted').state, 'disconnected');
  await again.integrations.connectAll();
  assert.equal(again.integrations.describeOne('hosted').state, 'connected');
  assert.ok(again.tools.has('hosted__search'));

  await again.integrations.remove('hosted');
  assert.equal(again.tools.has('hosted__search'), false);
  assert.deepEqual(again.integrations.describe(), []);
  await assert.rejects(again.integrations.remove('hosted'), /no integration/);
  await again.close();
  server.close();
});

test('a server that cannot start is a failed status, not a crash', async () => {
  const { host } = makeHost();
  const shown = await host.integrations.add({ name: 'broken', command: '/nonexistent/mcp-server' });
  assert.equal(shown.state, 'failed');
  assert.match(shown.error, /nonexistent/);
  assert.equal(host.tools.describeFor({ id: 'x' }).some((t) => t.name.startsWith('broken__')), false);
  await host.close();
});

test('specs are validated and tool names fit every provider', () => {
  assert.throws(() => IntegrationService.normalize({ name: 'Bad Name', url: 'https://x.test/mcp' }), /1-24 characters/);
  assert.throws(() => IntegrationService.normalize({ name: 'x' }), /url .* or a command/);
  assert.throws(() => IntegrationService.normalize({ name: 'x', url: 'ftp://x' }), /http or https/);
  assert.throws(() => IntegrationService.normalize({ name: 'x', url: 'https://x.test', headers: 'nope' }), /object of strings/);
  const spec = IntegrationService.normalize({ name: 'TV', command: 'uvx', args: ['--from', 'weather-mcp-server', 'weather-mcp'], trust: 'read_only' });
  assert.equal(spec.name, 'tv');
  assert.equal(spec.transport, 'stdio');
  assert.equal(spec.trust, 'read_only');
  assert.equal(toolName('tv', 'get.multi-timeframe analysis'), 'tv__get_multi-timeframe_analysis');
  const long = toolName('weatherdata', 'x'.repeat(100));
  assert.equal(long.length, 64);
  assert.ok(long.startsWith('weatherdata__'));
});

test('validateInput accepts integer and multi-type schemas from MCP servers', () => {
  const schema = { type: 'object', properties: { bars: { type: 'integer' }, q: { type: ['string', 'null'] } }, required: [] };
  assert.equal(validateInput(schema, { bars: 3, q: 'x' }).ok, true);
  assert.equal(validateInput(schema, { bars: 3.5 }).ok, false);
  assert.equal(validateInput(schema, { q: 7 }).ok, false);
  assert.deepEqual(flattenResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png' }] }), { ok: true, text: 'a\n[image image/png]' });
});

/** An MCP server behind OAuth, with its authorization server in the same process. */
function oauthServer() {
  const state = { tokens: new Set(['tok-1']), refreshed: 0, registered: 0, exchanged: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(req.url, base);
      const json = (code, value, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/.well-known/oauth-protected-resource') return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'], scopes_supported: ['offline_access'] });
      }
      if (url.pathname === '/register') { state.registered += 1; return json(201, { client_id: 'client-abc' }); }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code') {
          state.exchanged = Object.fromEntries(form);
          if (form.get('code') !== 'code-xyz') return json(400, { error: 'invalid_grant' });
          return json(200, { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600 });
        }
        if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'ref-1') {
          state.refreshed += 1; state.tokens.add('tok-2');
          return json(200, { access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 3600 });
        }
        return json(400, { error: 'invalid_grant' });
      }
      if (url.pathname === '/mcp') {
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!state.tokens.has(bearer)) {
          return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer error="unauthorized", resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        }
        const msg = JSON.parse(body);
        if (msg.id === undefined) { res.writeHead(202); return res.end(); }
        let result;
        if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'behind-oauth', version: '1' } };
        else if (msg.method === 'tools/list') result = { tools: [{ name: 'GMAIL_SEND_EMAIL', description: 'Send.', inputSchema: { type: 'object', properties: {} } }, { name: 'GMAIL_FETCH_EMAILS', description: 'Fetch.', inputSchema: { type: 'object', properties: {} } }] };
        else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: `ok as ${bearer}` }] };
        return json(200, { jsonrpc: '2.0', id: msg.id, result });
      }
      json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, state })));
}

test('a server that wants a person: needs_sign_in, then OAuth with PKCE, then tokens refresh on a 401', async () => {
  const { server, base, state } = await oauthServer();
  const { host } = makeHost();
  try {
    const shown = await host.integrations.add({ name: 'apps', url: `${base}/mcp` });
    assert.equal(shown.state, 'needs_sign_in');
    assert.equal(shown.signed_in, false);

    const started = await host.integrations.startSignIn('apps', { redirect_uri: 'http://127.0.0.1:4173/api/integrations/oauth/callback' });
    const authorize = new URL(started.authorize_url);
    assert.equal(authorize.pathname, '/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'client-abc');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('resource'), `${base}/mcp`);
    assert.equal(authorize.searchParams.get('redirect_uri'), 'http://127.0.0.1:4173/api/integrations/oauth/callback');
    assert.equal(state.registered, 1);

    await assert.rejects(host.integrations.finishSignIn({ state: 'forged', code: 'code-xyz' }), /unknown or expired/);
    const connected = await host.integrations.finishSignIn({ state: authorize.searchParams.get('state'), code: 'code-xyz' });
    assert.equal(connected.state, 'connected');
    assert.equal(connected.signed_in, true);
    assert.equal(state.exchanged.code_verifier.length > 40, true, 'PKCE verifier went to the token endpoint');
    // Unannotated tools: FETCH reads, SEND acts.
    assert.deepEqual(connected.tools.map((t) => [t.source, t.read_only]), [['GMAIL_SEND_EMAIL', false], ['GMAIL_FETCH_EMAILS', false]]);
    assert.doesNotMatch(JSON.stringify(host.integrations.describe()), /tok-1|ref-1/);

    // The token dies server-side; the next call refreshes once and succeeds.
    state.tokens.delete('tok-1');
    const client = host.integrations.clients.get('apps');
    assert.deepEqual(await client.callTool('GMAIL_FETCH_EMAILS', {}), { ok: true, text: 'ok as tok-2' });
    assert.equal(state.refreshed, 1);
    assert.equal(host.integrations.secrets.read().tokens.apps.refresh_token, 'ref-2', 'rotated refresh token is kept');

    // A second sign-in reuses the registered client rather than registering again.
    await host.integrations.startSignIn('apps', { redirect_uri: 'http://127.0.0.1:4173/api/integrations/oauth/callback' });
    assert.equal(state.registered, 1);

    await host.integrations.signOut('apps');
    assert.equal(host.integrations.describeOne('apps').state, 'needs_sign_in');
    assert.equal(host.tools.has('apps__GMAIL_FETCH_EMAILS'), false);
  } finally {
    await host.close();
    server.close();
  }
});

test('overlapping connects to one integration leave exactly one server, and close() stops it', async () => {
  const { execFileSync } = await import('node:child_process');
  const { randomUUID } = await import('node:crypto');
  const marker = `leak-check-${randomUUID()}`;
  const alive = () => { try { return execFileSync('pgrep', ['-f', marker]).toString().trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const { host } = makeHost();
  await host.integrations.add({ name: 'twice', command: process.execPath, args: [FAKE, marker] });
  await Promise.all([host.integrations.connect('twice'), host.integrations.connect('twice')]);
  assert.equal(alive(), 1, 'a second connect replaces the first server instead of orphaning it');
  await host.integrations.close();
  assert.equal(alive(), 0, 'close() leaves nothing running');
});

test('removing an integration while it connects leaves no server behind', async () => {
  const { execFileSync } = await import('node:child_process');
  const { randomUUID } = await import('node:crypto');
  const marker = `remove-check-${randomUUID()}`;
  const alive = () => { try { return execFileSync('pgrep', ['-f', marker]).toString().trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const { host } = makeHost();
  const adding = host.integrations.add({ name: 'gone', command: process.execPath, args: [FAKE, marker] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await host.integrations.remove('gone');
  await adding.catch(() => {});
  await host.integrations.close();
  assert.equal(alive(), 0);
});
