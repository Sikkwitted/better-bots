import { spawn } from 'node:child_process';
import { HostError } from '../core/util.js';
import { sse } from '../model/codex-adapter.js';
import { VERSION } from '../core/version.js';

// A Model Context Protocol client, so any MCP server becomes a set of tools an
// agent can be offered. JSON-RPC 2.0 over one of two transports: a child
// process speaking newline-delimited JSON on stdio, or streamable HTTP, where
// each request is one POST and the answer is JSON or a short SSE stream. No
// dependency: the protocol is small and the host stays dependency-free.
//
// The client is deliberately plain. It initialises, lists tools, and calls
// them. Resources, prompts, sampling, and server-initiated requests are not
// needed for tools and are not implemented.

export const PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const STARTUP_TIMEOUT_MS = 120_000; // uvx/npx may download on first run

export class MCPClient {
  /**
   * @param {object} spec
   * @param {'stdio'|'http'} spec.transport
   * @param {string} [spec.command]     stdio: the executable
   * @param {string[]} [spec.args]      stdio: its arguments
   * @param {object} [spec.env]         stdio: extra environment (merged over a scrubbed base)
   * @param {string} [spec.url]         http: the MCP endpoint
   * @param {object} [spec.headers]     http: extra headers (an Authorization bearer, usually)
   * @param {object} [options.auth]     http: { token(): Promise<string>, refresh(): Promise<string> } for OAuth;
   *                                    the bearer is fetched per request and refreshed once on a 401
   */
  constructor(spec, { fetchImpl = globalThis.fetch, timeout_ms = DEFAULT_TIMEOUT_MS, auth = null } = {}) {
    this.spec = spec;
    this.fetchImpl = fetchImpl;
    this.timeout_ms = timeout_ms;
    this.auth = auth;
    this.unauthorized = null;   // { status, www_authenticate } from the last 401, for the sign-in flow
    this.nextId = 1;
    this.pending = new Map();   // id -> { resolve, reject, timer }
    this.child = null;
    this.sessionId = null;
    this.server = null;         // serverInfo from initialize
    this.closed = false;
  }

  // ------------------------------------------------------------- lifecycle

  /** Start (stdio) and perform the initialize handshake. Resolves to server info. */
  async connect() {
    if (this.spec.transport === 'stdio') this.#spawn();
    else if (this.spec.transport !== 'http') throw new HostError('bad_transport', `unknown MCP transport ${this.spec.transport}`);
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'better-bots', version: VERSION },
    }, { timeout_ms: STARTUP_TIMEOUT_MS });
    this.server = result?.serverInfo ?? null;
    this.serverProtocol = result?.protocolVersion ?? PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    return result;
  }

  async close() {
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new HostError('mcp_closed', 'client closed')); }
    this.pending.clear();
    if (this.child) {
      const child = this.child;
      this.child = null;
      try { child.stdin.end(); } catch { /* already gone */ }
      const gone = new Promise((resolve) => child.once('exit', resolve));
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3_000);
      await gone;
      clearTimeout(timer);
    } else if (this.sessionId) {
      // Streamable HTTP: tell the server the session is over. Best effort.
      try {
        await this.fetchImpl(this.spec.url, { method: 'DELETE', headers: await this.#httpHeaders(), signal: AbortSignal.timeout(10_000) });
      } catch { /* the session will time out on its own */ }
    }
  }

  // ----------------------------------------------------------------- tools

  /** Every tool the server offers, following pagination to the end. */
  async listTools() {
    const tools = [];
    let cursor;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Call one tool. The MCP result is a content list; this flattens it to text
   * for the model and keeps any structured payload alongside. `isError` from the
   * server is a tool-level failure, not a protocol one, so it is returned, not thrown.
   */
  async callTool(name, args = {}, { timeout_ms, signal } = {}) {
    const result = await this.request('tools/call', { name, arguments: args ?? {} }, { timeout_ms, signal });
    return flattenResult(result);
  }

  // --------------------------------------------------------------- JSON-RPC

  async request(method, params = {}, { timeout_ms = this.timeout_ms, signal } = {}) {
    signal?.throwIfAborted();
    if (this.closed) throw new HostError('mcp_closed', 'client closed');
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    if (this.spec.transport === 'stdio') return this.#stdioRequest(id, message, timeout_ms, signal);
    return this.#httpRequest(id, message, timeout_ms, { signal });
  }

  async notify(method, params = {}) {
    const message = { jsonrpc: '2.0', method, params };
    if (this.spec.transport === 'stdio') { this.#write(message); return; }
    // A notification over HTTP is a POST the server answers with 202 and no body.
    try {
      await this.fetchImpl(this.spec.url, { method: 'POST', headers: await this.#httpHeaders(), body: JSON.stringify(message), signal: AbortSignal.timeout(10_000) });
    } catch { /* notifications are fire-and-forget */ }
  }

  // ------------------------------------------------------------------ stdio

  #spawn() {
    const { command, args = [], env = {}, cwd } = this.spec;
    if (!command) throw new HostError('bad_integration', 'a stdio integration needs a command');
    // A scrubbed environment, like the sandbox shell: the server gets PATH and
    // HOME so it can find its runtime and caches, plus what the integration
    // declares. Not the host's credentials.
    const base = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8', TERM: 'dumb' };
    for (const key of ['UV_CACHE_DIR', 'XDG_CACHE_HOME', 'npm_config_cache', 'TMPDIR']) if (process.env[key]) base[key] = process.env[key];
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...base, ...env }, cwd: cwd ?? undefined });
    this.stderr = '';
    // Decode as a stream: a multibyte character split across chunks must not turn into U+FFFD.
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-4_000); });
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // a server's stray log line
        this.#dispatch(msg);
      }
    });
    this.child.on('error', (err) => {
      // A process that never started has no exit to wait for.
      if (this.child?.pid === undefined) this.child = null;
      this.#failAll(new HostError('mcp_spawn_failed', `${command}: ${err.message}`));
    });
    this.child.on('exit', (code, signal) => {
      const detail = this.stderr.trim().split('\n').slice(-3).join(' | ');
      this.#failAll(new HostError('mcp_exited', `${command} exited (${signal ?? code})${detail ? `: ${detail}` : ''}`));
      this.child = null;
    });
  }

  #write(message) {
    if (!this.child?.stdin.writable) throw new HostError('mcp_not_running', 'the MCP server is not running');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #stdioRequest(id, message, timeout_ms, signal) {
    let abort;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError('mcp_timeout', `${message.method} took longer than ${timeout_ms}ms`));
      }, timeout_ms);
      abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        try { this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'run cancelled' } }); } catch { /* connection may be gone */ }
        reject(new HostError('run_interrupted', 'MCP request cancelled; external outcome requires reconciliation'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, timer });
      try { this.#write(message); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    }).finally(() => signal?.removeEventListener('abort', abort));
  }

  #dispatch(msg) {
    if (msg.id === undefined || msg.id === null) return; // a notification from the server; nothing listens
    if (msg.method) {
      // A server-to-client request (sampling, roots, elicitation). Decline politely.
      try { this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } }); } catch { /* gone */ }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(rpcError(msg.error));
    else p.resolve(msg.result);
  }

  #failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  // ------------------------------------------------------------------- http

  async #httpHeaders(extra = {}) {
    const bearer = this.auth ? await this.auth.token() : null;
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.serverProtocol ?? PROTOCOL_VERSION,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(this.spec.headers ?? {}),
      ...extra,
    };
  }

  async #httpRequest(id, message, timeout_ms, { retried = false, signal } = {}) {
    signal?.throwIfAborted();
    if (!this.spec.url) throw new HostError('bad_integration', 'an http integration needs a url');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeout_ms);
    let res;
    try {
      res = await this.fetchImpl(this.spec.url, { method: 'POST', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, headers: await this.#httpHeaders(), body: JSON.stringify(message) });
    } catch (err) {
      clearTimeout(timer);
      throw new HostError('mcp_fetch_failed', `${new URL(this.spec.url).host}: ${err.message ?? err}`);
    }
    try {
      const session = res.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (res.status === 401 || res.status === 403) {
        this.unauthorized = { status: res.status, www_authenticate: res.headers.get('www-authenticate') };
        // An expired OAuth token is refreshed once; anything else is the person's to fix.
        if (this.auth && !retried) {
          clearTimeout(timer);
          await this.auth.refresh();
          return this.#httpRequest(id, message, timeout_ms, { retried: true, signal });
        }
        throw new HostError('mcp_unauthorized', `${new URL(this.spec.url).host} refused the credentials (${res.status})`, httpFailureDetails(res));
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HostError('mcp_http_error', `${new URL(this.spec.url).host} answered ${res.status}: ${text.slice(0, 300)}`, httpFailureDetails(res));
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type.includes('text/event-stream')) {
        // The answer arrives as one or more events; the one carrying our id is the response.
        for await (const event of sse(res.body)) {
          if (event?.id === id) {
            if (event.error) throw rpcError(event.error);
            return event.result;
          }
        }
        throw new HostError('mcp_no_response', `${message.method}: the stream ended without a response`);
      }
      const body = await res.json();
      const reply = Array.isArray(body) ? body.find((m) => m.id === id) : body;
      if (!reply) throw new HostError('mcp_no_response', `${message.method}: no response with id ${id}`);
      if (reply.error) throw rpcError(reply.error);
      return reply.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

function rpcError(error) {
  return new HostError('mcp_error', `${error.message ?? 'error'}${error.code !== undefined ? ` (${error.code})` : ''}`);
}

function httpFailureDetails(response) {
  const details = { status: response.status };
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return details;
  const serverTime = Date.parse(response.headers.get('date'));
  const retryAt = /[a-z]{3}/i.test(value) ? Date.parse(value) : NaN;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000
    : Math.max(0, retryAt - (Number.isFinite(serverTime) ? serverTime : Date.now()));
  if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) {
    Object.assign(details, { retry_after: value, retry_after_ms: milliseconds });
  }
  return details;
}

function serviceFailure(payload) {
  if (payload?.success !== false && payload?.ok !== false) return null;
  const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? payload.message;
  const code = payload.error?.code ?? payload.code;
  const status = payload.status ?? payload.statusCode;
  return {
    error: 'upstream_error',
    ...(typeof code === 'string' && code ? { upstream_code: code } : {}),
    message: typeof detail === 'string' ? detail : 'The upstream service reported a failed request.',
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
    ...(Number.isSafeInteger(payload.retry_after_ms) && payload.retry_after_ms >= 0 ? { retry_after_ms: payload.retry_after_ms } : {}),
  };
}

/** MCP content list -> { ok, text, content, structured }. */
export function flattenResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((c) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'image') return `[image ${c.mimeType ?? ''}]`;
      if (c.type === 'audio') return `[audio ${c.mimeType ?? ''}]`;
      if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
      if (c.type === 'resource_link') return `[resource ${c.uri ?? ''}]`;
      return `[${c.type ?? 'content'}]`;
    })
    .filter(Boolean)
    .join('\n');
  // Some servers put their own failure envelope inside a successful MCP
  // response. Only inspect explicit root flags, never nested document data.
  let failure = serviceFailure(result?.structuredContent);
  const structuredSuccess = result?.structuredContent?.success === true || result?.structuredContent?.ok === true;
  for (const block of content) {
    if (failure || structuredSuccess || block.type !== 'text') continue;
    try { failure = serviceFailure(JSON.parse(block.text)); } catch { /* ordinary page text */ }
  }
  // A known service quota notice also arrives without isError or JSON. Keep
  // this narrow: a standalone provider notice, not prose quoting an error.
  if (!failure && result?.structuredContent == null && content.length === 1 && content[0].type === 'text'
      && /^You['’]ve hit [^\n.]{1,80}\bMCP rate limit\.(?:\s|$)/i.test(text)) {
    failure = { error: 'upstream_error', message: text, status: 429 };
  }
  return {
    ok: !result?.isError && !failure,
    text,
    ...(result?.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
    ...failure,
    ...(result?.isError ? { error: 'tool_error' } : {}),
  };
}
