import crypto from 'node:crypto';
import net from 'node:net';
import { HostError } from '../core/util.js';
import { isNonPublicAddress, vetPublicUrl } from './web-tool.js';

// OAuth for MCP servers that want a person, not a key (Composio Connect, and
// any server whose 401 points at resource metadata). The standard flow, with
// nothing invented: RFC 9728 protected-resource discovery, RFC 8414 server
// metadata, RFC 7591 dynamic client registration, authorization code + PKCE,
// RFC 8707 resource indicator, refresh tokens. The host is a public client
// (no secret); the redirect lands on the console, wherever the person
// reached it from, so an SSH tunnel to 127.0.0.1:4173 works.

const CLIENT_NAME = 'Better Bots (better-bots)';

const isLocalHost = (hostname) => {
  const name = hostname.replace(/^\[|\]$/g, '');
  if (name === 'localhost' || /\.(localhost|local|internal)$/.test(name)) return true;
  return net.isIP(name) !== 0 && isNonPublicAddress(name);
};

/**
 * Every URL the metadata names is fetched by this host or opened in the
 * person's browser, so it is only as trusted as the MCP server that named it.
 * A local server (the person's own) may point anywhere. A public one may name
 * only public https URLs: never this machine, its network, or another scheme.
 */
function vetMetadataUrl(value, mcpUrl, what) {
  let url;
  try { url = new URL(String(value)); } catch { throw new HostError('oauth_bad_metadata', `${what} is not a valid URL`); }
  if (url.username || url.password) throw new HostError('oauth_bad_metadata', `${what} carries credentials`);
  if (isLocalHost(mcpUrl.hostname)) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HostError('oauth_bad_metadata', `${what} must be http or https`);
    return String(value);
  }
  if (url.protocol !== 'https:') throw new HostError('oauth_bad_metadata', `${what} must use https`);
  try { vetPublicUrl(url.href); } catch { throw new HostError('oauth_bad_metadata', `${what} points at a non-public host`); }
  return String(value);
}

// Redirects are not followed: a hop could lead somewhere the vetting refused.
async function getJson(fetchImpl, url, what) {
  let res;
  try { res = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'manual' }); }
  catch (err) { throw new HostError('oauth_discovery_failed', `${what}: ${err.message}`); }
  if (!res.ok) throw new HostError('oauth_discovery_failed', `${what}: ${res.status}`);
  return res.json();
}

/** Where to sign in for one MCP endpoint. Follows the 401's resource_metadata, else the well-known paths. */
export async function discover(mcpUrl, { fetchImpl = globalThis.fetch, resourceMetadataUrl = null } = {}) {
  const url = new URL(mcpUrl);
  const vet = (value, what) => vetMetadataUrl(value, url, what);
  const candidates = resourceMetadataUrl ? [vet(resourceMetadataUrl, 'resource metadata URL')] : [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
  let resource = null;
  for (const candidate of candidates) {
    try { resource = await getJson(fetchImpl, candidate, 'protected resource metadata'); break; } catch { /* next */ }
  }
  const issuer = vet(resource?.authorization_servers?.[0] ?? url.origin, 'authorization server');
  const issuerUrl = new URL(issuer);
  const metadataUrls = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname === '/' ? '' : issuerUrl.pathname}`,
    `${issuerUrl.origin}/.well-known/openid-configuration`,
  ];
  let server = null;
  for (const candidate of metadataUrls) {
    try { server = await getJson(fetchImpl, candidate, 'authorization server metadata'); break; } catch { /* next */ }
  }
  if (!server?.authorization_endpoint || !server?.token_endpoint) {
    throw new HostError('oauth_unsupported', `${url.host} did not publish an authorization server`);
  }
  return {
    resource: resource?.resource ?? mcpUrl,
    issuer: server.issuer ?? issuer,
    authorization_endpoint: vet(server.authorization_endpoint, 'authorization endpoint'),
    token_endpoint: vet(server.token_endpoint, 'token endpoint'),
    registration_endpoint: server.registration_endpoint ? vet(server.registration_endpoint, 'registration endpoint') : null,
    scopes: resource?.scopes_supported ?? server.scopes_supported ?? [],
    pkce: (server.code_challenge_methods_supported ?? ['S256']).includes('S256'),
  };
}

/** Register this host as a public client for one redirect URI. Returns the client_id. */
export async function registerClient(meta, redirectUri, { fetchImpl = globalThis.fetch } = {}) {
  if (!meta.registration_endpoint) throw new HostError('oauth_no_registration', `${meta.issuer} does not register clients dynamically; it needs a pre-issued client id`);
  const res = await fetchImpl(meta.registration_endpoint, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) throw new HostError('oauth_registration_failed', `${meta.issuer}: ${res.status} ${body.error_description ?? body.error ?? ''}`.trim());
  return body.client_id;
}

/** A fresh PKCE pair and state. The verifier and state stay on the host. */
export function beginAuthorization(meta, { client_id, redirect_uri }) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client_id);
  url.searchParams.set('redirect_uri', redirect_uri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', meta.resource);
  if (meta.scopes?.length) url.searchParams.set('scope', meta.scopes.join(' '));
  return { authorize_url: url.toString(), verifier, state };
}

async function tokenRequest(meta, params, { fetchImpl }) {
  const res = await fetchImpl(meta.token_endpoint, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...params, resource: meta.resource }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new HostError('oauth_token_failed', `${new URL(meta.token_endpoint).host}: ${res.status} ${body.error_description ?? body.error ?? ''}`.trim());
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? params.refresh_token ?? null,
    expires_at: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null,
    scope: body.scope ?? null,
  };
}

export function exchangeCode(meta, { client_id, code, verifier, redirect_uri }, { fetchImpl = globalThis.fetch } = {}) {
  return tokenRequest(meta, { grant_type: 'authorization_code', client_id, code, code_verifier: verifier, redirect_uri }, { fetchImpl });
}

export function refreshTokens(meta, { client_id, refresh_token }, { fetchImpl = globalThis.fetch } = {}) {
  if (!refresh_token) throw new HostError('oauth_no_refresh', 'no refresh token; sign in again');
  return tokenRequest(meta, { grant_type: 'refresh_token', client_id, refresh_token }, { fetchImpl });
}

/** The resource_metadata URL an MCP server's 401 points at, if it does. */
export function resourceMetadataFrom(wwwAuthenticate) {
  return String(wwwAuthenticate ?? '').match(/resource_metadata="([^"]+)"/)?.[1] ?? null;
}
