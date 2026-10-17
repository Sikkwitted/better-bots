import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// A ChatGPT Plus/Pro subscription as a model provider. The person signs in once
// through the Better Bots console or official Codex CLI browser flow; it writes
// `auth.json`. We read that file, use the access token, and
// refresh it through the same OAuth endpoint the CLI uses. Refresh tokens rotate
// and a reused one is rejected, so exactly one machine may own an auth.json —
// the box the agents run on. Nothing here is written to git.

const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_SKEW_MS = 60_000;
// Catalog and adapters share one rotating credential file.
const refreshFlights = new Map();
const TERMINAL = new Set(['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated', 'invalid_grant']);
const fingerprint = data => createHash('sha256').update(JSON.stringify(data.tokens ?? {})).digest('hex');

export function defaultCodexAuthFile(env = process.env) {
  if (env.BETTER_BOTS_CODEX_AUTH_FILE) return env.BETTER_BOTS_CODEX_AUTH_FILE;
  return path.join(env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), '.codex'), 'auth.json');
}

export function decodeJwt(token) {
  try {
    const [, payload] = String(token).split('.');
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export class CodexAuth {
  constructor({ file = defaultCodexAuthFile(), fetch = globalThis.fetch, now = () => Date.now() } = {}) {
    this.file = path.resolve(file);
    this.fetch = fetch;
    this.now = now;
    this.tokens = null;
    this.refreshing = null;
  }

  /** Is anyone signed in? Never throws; the console asks this to show a status. */
  status() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const t = data.tokens ?? {};
      if (!t.access_token) return { signed_in: false, file: this.file, why: 'no access token in auth.json' };
      const failure = this.#failure(data);
      if (failure) return { signed_in: false, needs_reconnect: true, file: this.file, why: 'Your ChatGPT sign-in expired or was revoked. Reconnect to continue.' };
      const claims = decodeJwt(t.access_token);
      return {
        signed_in: true, file: this.file,
        account_id: t.account_id ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null,
        expires_at: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
        plan: claims?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null,
      };
    } catch (err) {
      return { signed_in: false, file: this.file, why: err.code === 'ENOENT' ? 'not signed in (no auth.json)' : err.message };
    }
  }

  #failure(data) {
    try { const failure = JSON.parse(fs.readFileSync(`${this.file}.status.json`, 'utf8')); return failure.fingerprint === fingerprint(data) ? failure : null; } catch { return null; }
  }

  #load() {
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const t = data.tokens ?? {};
    if (!t.access_token) throw new Error(`codex auth.json at ${this.file} has no access token; connect ChatGPT in App settings → AI providers`);
    const failure = this.#failure(data);
    if (failure) throw new Error(`codex token refresh failed (${failure.code}); reconnect ChatGPT in App settings → AI providers`);
    const claims = decodeJwt(t.access_token) ?? {};
    this.tokens = {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? null,
      id_token: t.id_token ?? null,
      account_id: t.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id ?? null,
      expires_at: claims.exp ? claims.exp * 1000 : null,
    };
    this.raw = data;
    return this.tokens;
  }

  #stale() {
    const exp = this.tokens?.expires_at;
    return exp ? this.now() + REFRESH_SKEW_MS >= exp : false;
  }

  /** A usable access token and account id, refreshing first if the token is about to expire. */
  async credentials({ force = false } = {}) {
    this.#load();
    if (force || this.#stale()) await this.refresh();
    return { access_token: this.tokens.access_token, account_id: this.tokens.account_id };
  }

  async refresh() {
    const existing = refreshFlights.get(this.file);
    if (existing) {
      await existing;
      return this.#load();
    }
    const flight = (async () => {
      // Re-read: another process (the CLI) may have rotated the token since we loaded.
      this.#load();
      if (!this.tokens.refresh_token) throw new Error('codex auth has no refresh token; reconnect ChatGPT in App settings → AI providers');
      const original = fs.readFileSync(this.file, 'utf8');
      const res = await this.fetch(REFRESH_URL, {
        signal: AbortSignal.timeout(30_000),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token }),
      });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = {}; }
      // A new CLI login wins over an in-flight refresh, including a failed one.
      if (fs.readFileSync(this.file, 'utf8') !== original) return this.#load();
      if (!res.ok) {
        const code = body.error?.code ?? body.error ?? '';
        const terminal = TERMINAL.has(String(code));
        if (terminal) {
          const marker = `${this.file}.status.json`;
          fs.writeFileSync(`${marker}.tmp`, JSON.stringify({ fingerprint: fingerprint(this.raw), code: String(code) }), { mode: 0o600 });
          fs.renameSync(`${marker}.tmp`, marker);
        }
        throw new Error(`codex token refresh failed (${res.status}${code ? ` ${code}` : ''})${terminal ? '; reconnect ChatGPT in App settings → AI providers' : ''}`);
      }
      if (typeof body.access_token !== 'string' || !body.access_token) {
        throw new Error('codex token refresh returned no access token; credentials were preserved');
      }
      const updated = {
        ...this.raw,
        tokens: {
          ...(this.raw.tokens ?? {}),
          access_token: body.access_token ?? this.tokens.access_token,
          refresh_token: body.refresh_token ?? this.tokens.refresh_token,
          id_token: body.id_token ?? this.tokens.id_token,
          account_id: this.tokens.account_id,
        },
        last_refresh: new Date(this.now()).toISOString(),
      };
      // Atomic: the CLI reads this file too, and a half-written one signs everybody out.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.#load();
      return this.tokens;
    })();
    refreshFlights.set(this.file, flight);
    try { return await flight; }
    finally { if (refreshFlights.get(this.file) === flight) refreshFlights.delete(this.file); }
  }
}
