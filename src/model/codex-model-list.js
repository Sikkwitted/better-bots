import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { VERSION } from '../core/version.js';

export class CodexModelListError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

function requestError(error) {
  // App-server error details can contain account or upstream data. Only expose
  // a status category to the catalog; never return its raw message.
  const detail = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.data?.status ?? ''} ${error?.data?.message ?? ''}`;
  if (/\b401\b|unauthori[sz]ed|not logged in|not signed in|authentication required/i.test(detail)) {
    return new CodexModelListError('ChatGPT sign-in is no longer authorized.', 401);
  }
  if (/\b403\b|forbidden|permission denied/i.test(detail)) {
    return new CodexModelListError('ChatGPT account cannot list models.', 403);
  }
  return new CodexModelListError('Codex model discovery was rejected.');
}

/** Read the installed Codex CLI's account-specific picker through its app-server protocol. */
export function listCodexModels({ bin = 'codex', home, env = process.env, spawnImpl = spawn,
  signal, timeoutMs = 10000 } = {}) {
  if (typeof home !== 'string' || !home) {
    return Promise.reject(new CodexModelListError('Codex credential directory is unavailable.'));
  }
  const childEnv = { ...env, CODEX_HOME: home };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_AUTH_JSON', 'CODEX_ACCESS_TOKEN', 'CODEX_REFRESH_TOKEN']) {
    delete childEnv[key];
  }
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let buffer = '';
    let bytes = 0;
    let pending = 1;
    let nextId = 1;
    let pages = 0;
    const rows = [];
    const cursors = new Set();
    const decoder = new StringDecoder('utf8');
    let killTimer;
    const stop = () => {
      if (!child) return;
      try { child.kill('SIGTERM'); } catch { /* Already exited. */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
      }, 1000);
      killTimer.unref?.();
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stop();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new CodexModelListError('Model discovery timed out.'));
    const timer = setTimeout(abort, Math.max(1, timeoutMs));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch { finish(new CodexModelListError('Codex model discovery connection closed.')); }
    };
    const page = (cursor = null) => {
      if (++pages > 100 || (cursor !== null && (typeof cursor !== 'string' || !cursor || cursors.has(cursor)))) {
        finish(new CodexModelListError('Invalid Codex model pagination.'));
        return;
      }
      if (cursor !== null) cursors.add(cursor);
      pending = ++nextId;
      send({ id: pending, method: 'model/list', params: {
        limit: 100, includeHidden: false, ...(cursor === null ? {} : { cursor }),
      } });
    };
    const receive = (message) => {
      if (settled || message?.id !== pending) return;
      if (message.error) { finish(requestError(message.error)); return; }
      if (pending === 1) {
        if (!message.result || typeof message.result !== 'object') {
          finish(new CodexModelListError('Invalid Codex initialization response.'));
          return;
        }
        send({ method: 'initialized', params: {} });
        page();
        return;
      }
      const result = message.result;
      if (!Array.isArray(result?.data)) {
        finish(new CodexModelListError('Invalid Codex model catalog response.'));
        return;
      }
      rows.push(...result.data);
      if (rows.length > 10000) {
        finish(new CodexModelListError('Codex model catalog is too large.'));
        return;
      }
      if (result.nextCursor === null || result.nextCursor === undefined) finish(null, rows);
      else page(result.nextCursor);
    };
    try {
      child = spawnImpl(bin, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'], {
        env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish(new CodexModelListError('Codex CLI is unavailable on this host.'));
      return;
    }
    child.once('error', () => finish(new CodexModelListError('Codex CLI is unavailable on this host.')));
    child.once('close', () => {
      clearTimeout(killTimer);
      if (!settled) finish(new CodexModelListError('Codex model discovery connection closed.'));
    });
    child.stdin.on('error', () => finish(new CodexModelListError('Codex model discovery connection closed.')));
    child.stdout.on('error', () => finish(new CodexModelListError('Codex model discovery connection closed.')));
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 10_000_000) {
        finish(new CodexModelListError('Codex model catalog is too large.'));
        return;
      }
      buffer += decoder.write(chunk);
      if (buffer.length > 2_000_000) {
        finish(new CodexModelListError('Codex model catalog response is too large.'));
        return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1 && !settled) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { finish(new CodexModelListError('Invalid Codex protocol response.')); return; }
        receive(message);
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'better_bots', title: 'Better Bots', version: VERSION },
    } });
  });
}
