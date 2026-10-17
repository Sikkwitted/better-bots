import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/tools/mcp-oauth.js';

// A hosted MCP server writes the OAuth metadata, and the host then fetches those
// URLs and opens one in the person's browser. A public server must not be able
// to aim either at this machine, its network, or a non-https scheme.

const serve = (routes) => async (url) => {
  const body = routes[String(url)];
  return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
};

const publicMetadata = (overrides = {}) => serve({
  'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': { resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'] },
  'https://auth.example.com/.well-known/oauth-authorization-server': {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    registration_endpoint: 'https://auth.example.com/register',
    ...overrides,
  },
});

test('public metadata naming public https endpoints is accepted unchanged', async () => {
  const meta = await discover('https://mcp.example.com/mcp', { fetchImpl: publicMetadata() });
  assert.equal(meta.authorization_endpoint, 'https://auth.example.com/authorize');
  assert.equal(meta.token_endpoint, 'https://auth.example.com/token');
});

for (const [field, value] of [
  ['token_endpoint', 'http://127.0.0.1:8888/token'],
  ['token_endpoint', 'https://169.254.169.254/latest/meta-data'],
  ['registration_endpoint', 'https://localhost/register'],
  ['registration_endpoint', 'https://db.internal/register'],
  ['authorization_endpoint', 'file:///etc/passwd'],
  ['authorization_endpoint', 'javascript:alert(1)'],
  ['authorization_endpoint', 'http://auth.example.com/authorize'],
]) {
  test(`a public MCP server cannot name ${field} = ${value}`, async () => {
    await assert.rejects(discover('https://mcp.example.com/mcp', { fetchImpl: publicMetadata({ [field]: value }) }), /oauth_bad_metadata|https|non-public|http or https/);
  });
}

test("a 401's resource_metadata pointing at this machine is refused", async () => {
  await assert.rejects(
    discover('https://mcp.example.com/mcp', { fetchImpl: publicMetadata(), resourceMetadataUrl: 'http://127.0.0.1:4173/api/state' }),
    /resource metadata URL/,
  );
});

test('an authorization server on a private address is refused before it is fetched', async () => {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(String(url));
    return String(url).endsWith('/oauth-protected-resource/mcp')
      ? { ok: true, status: 200, json: async () => ({ authorization_servers: ['https://10.0.0.5'] }) }
      : { ok: false, status: 404, json: async () => ({}) };
  };
  await assert.rejects(discover('https://mcp.example.com/mcp', { fetchImpl }), /authorization server/);
  assert.ok(!fetched.some((u) => u.includes('10.0.0.5')), 'the private address was never contacted');
});

test("a local MCP server (the person's own) may use local http endpoints", async () => {
  const fetchImpl = serve({
    'http://127.0.0.1:9000/.well-known/oauth-protected-resource/mcp': { authorization_servers: ['http://127.0.0.1:9000'] },
    'http://127.0.0.1:9000/.well-known/oauth-authorization-server': {
      authorization_endpoint: 'http://127.0.0.1:9000/authorize', token_endpoint: 'http://127.0.0.1:9000/token',
    },
  });
  const meta = await discover('http://127.0.0.1:9000/mcp', { fetchImpl });
  assert.equal(meta.token_endpoint, 'http://127.0.0.1:9000/token');
  await assert.rejects(discover('http://127.0.0.1:9000/mcp', { fetchImpl: serve({
    'http://127.0.0.1:9000/.well-known/oauth-authorization-server': { authorization_endpoint: 'file:///etc/passwd', token_endpoint: 'http://127.0.0.1:9000/token' },
  }) }), /http or https/);
});
