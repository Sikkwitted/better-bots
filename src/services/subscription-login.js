import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexAuth } from '../model/codex-auth.js';
import { VERSION } from '../core/version.js';

// Official Codex app-server browser login. The browser OAuth URL and a
// short-lived callback relay are exposed to the authenticated console; tokens
// stay on the host. An isolated home keeps failed attempts from replacing the
// credentials currently used by running bots.
const LOGIN_ENV = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_BIN',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];

export class SubscriptionLogin {
  constructor({ auth = new CodexAuth(), spawnImpl = spawn, callbackFetch = globalThis.fetch, onConnected = () => {},
    env = process.env, timeoutMs = 10 * 60_000, requestTimeoutMs = 30_000 } = {}) {
    Object.assign(this, { auth, spawnImpl, callbackFetch, onConnected, env, timeoutMs, requestTimeoutMs });
    this.session = null;
  }

  status() {
    const s = this.session;
    return s ? { id: s.id, state: s.state, method: 'browser', verification_url: s.url ?? null, user_code: null,
      expires_at: s.expires_at, message: s.message ?? null } : { state: 'idle' };
  }

  async start() {
    if (['starting', 'waiting'].includes(this.session?.state)) return this.status();
    const s = { id: randomUUID(), state: 'starting', expires_at: new Date(Date.now() + this.timeoutMs).toISOString(),
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'better-bots-login-')), requests: new Map(), sequence: 0, buffer: '' };
    this.session = s;
    try {
      // An allowlist, not a denylist: the sign-in tool gets what it needs to run
      // and reach the network, never the host's other keys or the console token.
      const env = { CODEX_HOME: s.dir };
      for (const key of LOGIN_ENV) if (this.env[key] !== undefined) env[key] = this.env[key];
      s.child = this.spawnImpl(this.env.CODEX_BIN || 'codex', ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'], {
        cwd: s.dir, env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      s.child.stdin.on('error', () => this.#fail(s, 'The sign-in service closed. Please try again.'));
      s.child.stdout.on('data', chunk => this.#read(s, chunk));
      // Drain diagnostics without exposing CLI output, credentials or account data.
      s.child.stderr.resume();
      s.child.on('error', err => this.#fail(s, err.code === 'ENOENT'
        ? 'ChatGPT sign-in is unavailable on this host. Install or update the official Codex CLI, then try again.'
        : 'Could not start ChatGPT sign-in. Please try again.'));
      s.child.on('close', () => {
        if (['starting', 'waiting'].includes(s.state)) this.#fail(s, 'Sign-in ended before the account was linked. Please try again.');
        clearTimeout(s.killTimer);
        fs.rmSync(s.dir, { recursive: true, force: true });
      });
      s.timer = setTimeout(() => this.#finish(s, 'expired', 'This sign-in code expired. Start again for a new code.'), this.timeoutMs);
      s.timer.unref?.();
      await this.#request(s, 'initialize', { clientInfo: { name: 'better_bots', title: 'Better Bots', version: VERSION } });
      if (s.state !== 'starting') return this.status();
      s.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const result = await this.#request(s, 'account/login/start', { type: 'chatgpt' });
      if (s.state !== 'starting') return this.status();
      const url = new URL(result.authUrl);
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      const state = url.searchParams.get('state');
      if (!['https://auth.openai.com', 'https://chatgpt.com'].includes(url.origin)
        || url.username || url.password || url.searchParams.getAll('state').length !== 1
        || url.searchParams.getAll('redirect_uri').length !== 1 || !state || state.length > 1024
        || redirect.protocol !== 'http:' || redirect.hostname !== 'localhost'
        || redirect.username || redirect.password || !redirect.port
        || redirect.pathname !== '/auth/callback' || redirect.search || redirect.hash
        || typeof result.loginId !== 'string' || !result.loginId || result.type !== 'chatgpt') throw new Error('Invalid sign-in response');
      Object.assign(s, { state: 'waiting', url: url.href, redirect: redirect.href, oauthState: state, loginId: result.loginId });
      if (s.completed) this.#completed(s, s.completed);
    } catch (error) {
      this.#fail(s, error.code === 'ENOENT' ? 'ChatGPT sign-in is unavailable on this host. Install or update the official Codex CLI, then try again.' : 'Could not start browser sign-in. Update the official Codex CLI on this host, then try again.');
    }
    return this.status();
  }

  async submitCallback(id, callbackUrl) {
    const s = this.session;
    if (!s || s.id !== id || s.state !== 'waiting' || !s.redirect) throw new Error('This sign-in is no longer active. Start a new one.');
    if (s.callbackSubmitted) throw new Error('This callback was already sent. Wait for the result or start a new sign-in.');
    if (typeof callbackUrl !== 'string' || callbackUrl.length > 4096) throw new Error('Paste the complete localhost address from the OpenAI sign-in tab.');
    let callback;
    try { callback = new URL(callbackUrl.trim()); }
    catch { throw new Error('Paste the complete localhost address from the OpenAI sign-in tab.'); }
    const expected = new URL(s.redirect);
    const callbackState = callback.searchParams.get('state');
    // Codex allows this one suffix when ChatGPT appends onboarding metadata.
    const stateMatches = callbackState === s.oauthState
      || callbackState === `${s.oauthState}.onboarding_entrypoint=life_sciences`;
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || callback.username || callback.password || callback.hash
      || callback.searchParams.getAll('state').length !== 1 || !stateMatches
      || callback.searchParams.getAll('code').length !== 1 || !callback.searchParams.get('code')) {
      throw new Error('That address does not match this sign-in. Copy the full address after approving with your security key.');
    }
    // Reconstruct the request against loopback. Never fetch a user-supplied host
    // or return the OAuth code, callback page, or provider error to the browser.
    s.callbackSubmitted = true;
    const local = new URL(`http://127.0.0.1:${expected.port}/auth/callback`);
    local.searchParams.set('state', callbackState);
    local.searchParams.set('code', callback.searchParams.get('code'));
    try {
      const response = await this.callbackFetch(local.href, { redirect: 'manual', signal: AbortSignal.timeout(this.requestTimeoutMs) });
      if (s.state === 'connected') return this.status();
      if (!response.ok && response.status !== 302 && response.status !== 303) {
        this.#fail(s, 'The sign-in callback was rejected. Start a new browser sign-in.');
        return this.status();
      }
    } catch (error) {
      if (s.state === 'connected') return this.status();
      s.message = 'Could not confirm the sign-in callback. Wait for the result; if it does not connect, choose Cancel sign-in and start again.';
      throw new Error(s.message);
    }
    return this.status();
  }

  cancel(id) {
    if (id && id !== this.session?.id) return this.status();
    if (['starting', 'waiting'].includes(this.session?.state)) this.#finish(this.session, 'cancelled', 'Sign-in cancelled. Your previous connection was kept.');
    return this.status();
  }

  close() { this.cancel(); }

  #request(s, method, params) {
    return new Promise((resolve, reject) => {
      const id = ++s.sequence;
      const timer = setTimeout(() => { s.requests.delete(id); reject(new Error('Sign-in request timed out')); }, this.requestTimeoutMs);
      s.requests.set(id, { resolve, reject, timer });
      s.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  #read(s, chunk) {
    if (!['starting', 'waiting'].includes(s.state)) return;
    s.buffer += chunk.toString();
    if (s.buffer.length > 256_000) { this.#fail(s, 'Unexpected sign-in response. Please try again.'); return; }
    let end;
    while ((end = s.buffer.indexOf('\n')) !== -1) {
      const line = s.buffer.slice(0, end); s.buffer = s.buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const pending = s.requests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer); s.requests.delete(message.id);
        if (message.error) pending.reject(new Error('Sign-in request rejected'));
        else pending.resolve(message.result);
      } else if (message.method === 'account/login/completed') this.#completed(s, message.params);
    }
  }

  #completed(s, result) {
    if (!['starting', 'waiting'].includes(s.state)) return;
    if (!s.loginId) { s.completed = result; return; }
    if (result?.loginId && result.loginId !== s.loginId) return;
    if (result.success !== true) { this.#fail(s, 'OpenAI did not complete sign-in. Start a new browser sign-in and use your security key.'); return; }
    let tmp;
    try {
      const raw = fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8');
      const data = JSON.parse(raw);
      if (typeof data.tokens?.access_token !== 'string' || !data.tokens.access_token || typeof data.tokens?.refresh_token !== 'string' || !data.tokens.refresh_token) throw new Error('No subscription credentials');
      fs.mkdirSync(path.dirname(this.auth.file), { recursive: true, mode: 0o700 });
      tmp = `${this.auth.file}.${s.id}.tmp`;
      fs.writeFileSync(tmp, raw, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.auth.file);
      this.#finish(s, 'connected', 'ChatGPT is connected. Refreshing your available models…');
      // Credentials are already committed; discovery failure must not undo login.
      Promise.resolve().then(() => this.onConnected()).catch(() => {});
    } catch {
      if (tmp) fs.rmSync(tmp, { force: true });
      this.#fail(s, 'Sign-in finished, but the account could not be saved. Please try again.');
    }
  }

  #fail(s, message) { if (['starting', 'waiting'].includes(s.state)) this.#finish(s, 'failed', message); }

  #finish(s, state, message) {
    Object.assign(s, { state, message, url: null, redirect: null, oauthState: null });
    clearTimeout(s.timer);
    for (const request of s.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Sign-in ended')); }
    s.requests.clear();
    if (s.child) {
      s.child.kill('SIGTERM');
      s.killTimer = setTimeout(() => s.child.kill('SIGKILL'), 1000);
      s.killTimer.unref?.();
    } else fs.rmSync(s.dir, { recursive: true, force: true });
  }
}
