import path from 'node:path';
import { createHash } from 'node:crypto';
import { JsonDoc } from '../core/store.js';
import { CodexAuth, defaultCodexAuthFile } from '../model/codex-auth.js';
import { CodexModelListError, listCodexModels } from '../model/codex-model-list.js';
import { PROVIDERS } from '../../web/models.js';

// Model IDs come from discovery or a manual entry an operator vouches for.
// Both share the picker/pin catalog.
const DISCOVERY = {
  anthropic: ['https://api.anthropic.com/v1/models', 'data'],
  glm: ['https://api.z.ai/api/coding/paas/v4/models', 'data'],
  openai: ['https://api.openai.com/v1/models', 'data'],
  openrouter: ['https://openrouter.ai/api/v1/models/user', 'data'],
  deepseek: ['https://api.deepseek.com/models', 'data'],
  atria: ['https://api.atria-asi.ai/v1/models', 'data'],
  local: ['http://127.0.0.1:11434/api/tags', 'models'],
};
// A cache file written under any other schema number is discarded, so every
// cached model ID has discovery or manual provenance.
const CACHE_SCHEMA = 2;

class DiscoveryError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

const safeError = (error) => error instanceof DiscoveryError ? error.message : 'Model discovery failed.';
const scopeFor = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export class ModelCatalog {
  #cache = new Map();
  #flights = new Map();
  #cacheError = null;

  constructor({ dir = null, env = process.env, fetchImpl = globalThis.fetch,
    codexAuth = new CodexAuth({ file: defaultCodexAuthFile(env) }), codexModelList = listCodexModels,
    providers = null,
    now = Date.now, ttl_ms = 3600000, timeout_ms = 10000 } = {}) {
    Object.assign(this, { env, fetchImpl, codexAuth, codexModelList, providers, now, ttl_ms, timeout_ms });
    this.doc = dir ? new JsonDoc(path.join(dir, 'model-catalog.json'), { providers: {} }) : null;
    try {
      const saved = this.doc?.read();
      for (const [id, entry] of Object.entries(saved?.schema === CACHE_SCHEMA ? saved.providers ?? {} : {})) {
        if (this.#known(id) && typeof entry?.scope === 'string' && Array.isArray(entry.models)
          && Number.isFinite(entry.retry_at) && ['ready', 'stale', 'error'].includes(entry.state)) {
          this.#cache.set(id, entry);
        }
      }
    } catch { /* An unreadable discovery cache is expendable; never invent a fallback. */ }
  }

  /** A provider is known when it is built-in or was added by an operator. */
  #known(id) {
    return Object.hasOwn(PROVIDERS, id) || Boolean(this.providers?.normalize(id));
  }

  async list({ force = false, provider = null } = {}) {
    const ids = Object.keys(this.providers?.all() ?? PROVIDERS).filter(id => !provider || id === provider);
    const entries = await Promise.all(ids.map((id) => this.#provider(id, force)));
    // A different provider can finish slowly while credentials are being edited.
    const scopes = await Promise.all(ids.map((id) => this.#context(id).then((ctx) => ctx?.scope ?? null, () => null)));
    if (entries.some((entry, i) => entry.scope !== scopes[i]
      || (entry.scope && this.#cache.get(ids[i]) !== entry))) return this.list({ provider });
    const models = [];
    const seen = new Set();
    const providers = entries.map((entry, i) => {
      const id = ids[i];
      for (const model of entry.models) {
        const { id: modelId, label, description, is_default, is_free } = model;
        const key = `${id}\0${modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        models.push({ id: modelId, provider: id, label, description,
          ...(typeof is_default === 'boolean' ? { is_default } : {}),
          ...(typeof is_free === 'boolean' ? { is_free } : {}),
          ...(entry.state === 'stale' ? { stale: true } : {}) });
      }
      return { id, label: this.providers?.get(id)?.label ?? PROVIDERS[id].label, state: entry.state, error: entry.error,
        updated_at: entry.updated_at, checked_at: entry.checked_at,
        ...(this.#cacheError ? { cache_error: this.#cacheError } : {}) };
    });
    // A manual entry is a person vouching that this id is reachable on this
    // provider. It is never stale and never filtered by catalog availability,
    // but it does not shadow a discovered model when the provider lists it too.
    for (const manual of this.providers?.manualModels() ?? []) {
      if (provider && manual.provider !== provider) continue;
      const key = `${manual.provider}\0${manual.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(manual);
    }
    return { models, providers };
  }

  invalidate(provider) {
    this.#cache.delete(provider);
    this.#flights.delete(provider);
    this.#save();
  }

  #save() {
    try {
      this.doc?.write({ schema: CACHE_SCHEMA, providers: Object.fromEntries(this.#cache) });
      this.#cacheError = null;
    } catch { this.#cacheError = 'Model catalog cache could not be saved.'; }
  }

  async #bounded(fn, ms = this.timeout_ms) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new DiscoveryError('Model discovery timed out.'));
            controller.abort();
          }, Math.max(1, ms));
        }),
        Promise.resolve().then(() => fn(controller.signal)),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async #context(id, force = false) {
    const headers = { accept: 'application/json' };
    if (id === 'codex') {
      if (!this.codexAuth.status().signed_in) return null;
      const credentials = await this.#bounded(() => this.codexAuth.credentials({ force }));
      const status = this.codexAuth.status();
      if (!status.signed_in) return null;
      if (status.account_id && credentials.account_id && status.account_id !== credentials.account_id) {
        if (!force) return this.#context(id, true);
        throw new DiscoveryError('Codex credentials do not match the signed-in account.', 401);
      }
      if (!credentials.access_token) throw new DiscoveryError('Codex credentials are unavailable.', 401);
      const account = status.account_id ?? credentials.account_id ?? null;
      return { scope: scopeFor(id, account, credentials.access_token) };
    }
    if (id === 'local') return { headers, scope: scopeFor(id, DISCOVERY.local[0]) };
    const spec = this.providers?.get(id) ?? PROVIDERS[id];
    if (!spec) return null;
    // A custom provider's key may be held by the store rather than the
    // environment; check both before declaring the provider unconfigured.
    let keyName = spec.key_env.find((name) => typeof this.env[name] === 'string' && this.env[name].trim()) ?? null;
    let key = keyName ? this.env[keyName] : null;
    if (!key && this.providers?.isCustom(id)) {
      const stored = this.providers.keyFor(id);
      if (stored) { keyName = 'stored'; key = stored; }
    }
    if (!keyName) return null;
    if (id === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (keyName === 'ANTHROPIC_API_KEY') headers['x-api-key'] = key;
      else headers.authorization = `Bearer ${key}`;
    } else headers.authorization = `Bearer ${key}`;
    return { headers, scope: scopeFor(id, keyName, key) };
  }

  async #provider(id, force) {
    let context;
    const empty = { scope: null, models: [], state: 'unconfigured', error: null, updated_at: null, checked_at: this.now() };
    try { context = await this.#context(id); }
    catch (error) {
      this.invalidate(id);
      return { ...empty, state: 'error', error: safeError(error) };
    }
    let previous = this.#cache.get(id);
    let flight = this.#flights.get(id);
    if ((previous && previous.scope !== context?.scope) || (flight && flight.scope !== context?.scope)) {
      this.invalidate(id);
      previous = flight = null;
    }
    if (!context) return empty;
    if (!force && previous && this.now() < previous.retry_at) return previous;
    if (!flight) {
      flight = { scope: context.scope };
      this.#flights.set(id, flight);
      flight.promise = this.#refresh(id, context, previous, flight).then((entry) => {
        if (this.#flights.get(id) === flight) {
          this.#cache.set(id, entry);
          this.#save();
        }
        return entry;
      }).finally(() => {
        if (this.#flights.get(id) === flight) this.#flights.delete(id);
      });
    }
    return flight.promise;
  }

  async #refresh(id, context, previous, flight) {
    let models;
    let error = null;
    try {
      try { models = await this.#discover(id, context); }
      catch (failure) {
        if (failure instanceof DiscoveryError && [401, 403].includes(failure.status)) {
          previous = null;
          if (this.#flights.get(id) === flight) { this.#cache.delete(id); this.#save(); }
        }
        if (id !== 'codex' || failure.status !== 401) throw failure;
        const refreshed = await this.#context(id, true);
        if (!refreshed) throw new DiscoveryError('Codex is no longer signed in.', 401);
        context = refreshed;
        models = await this.#discover(id, context);
      }
    } catch (failure) {
      error = safeError(failure);
      if ([401, 403].includes(failure.status) || previous?.scope !== context?.scope) previous = null;
      models = previous?.models ?? [];
    }
    const checked_at = this.now();
    return { scope: context?.scope ?? null, models, error,
      state: error ? (models.length ? 'stale' : 'error') : 'ready', checked_at,
      updated_at: error ? (previous?.updated_at ?? null) : checked_at,
      retry_at: checked_at + (error ? Math.min(this.ttl_ms, 30000) : this.ttl_ms) };
  }

  async #discover(id, context) {
    if (id === 'codex') {
      const file = path.resolve(this.codexAuth.file ?? defaultCodexAuthFile(this.env));
      if (path.basename(file) !== 'auth.json') throw new DiscoveryError('Codex credential file must be named auth.json.');
      try {
        const rows = await this.#bounded((signal) => this.codexModelList({
          bin: this.env.CODEX_BIN || 'codex', home: path.dirname(file), env: this.env,
          signal, timeoutMs: this.timeout_ms,
        }));
        if (!Array.isArray(rows)) throw new DiscoveryError('Invalid Codex model catalog response.');
        return this.#parse(id, rows);
      } catch (error) {
        if (error instanceof DiscoveryError) throw error;
        throw new DiscoveryError(error instanceof CodexModelListError
          ? error.message : 'Codex model discovery failed.', error?.status ?? null);
      }
    }
    const [endpoint, field] = this.#endpoint(id);
    if (!endpoint) throw new DiscoveryError('Model discovery is not supported for this provider.');
    let url = new URL(endpoint);
    const headers = { ...context.headers };
    return this.#bounded(async (signal) => {
      const origin = url.origin;
      const seen = new Set();
      const rows = [];
      while (url) {
        signal.throwIfAborted();
        if (url.origin !== origin || url.username || url.password || seen.has(url.href) || seen.size >= 100) {
          throw new DiscoveryError('Unsafe or repeated model catalog pagination.');
        }
        seen.add(url.href);
        // Reject redirects too: checking only links.next would still leak headers.
        const response = await this.fetchImpl(url.href, { method: 'GET', headers, signal, redirect: 'error' });
        if (!response.ok) throw new DiscoveryError(`Model discovery failed (HTTP ${response.status}).`, response.status);
        const body = await response.json();
        if (!Array.isArray(body?.[field])) throw new DiscoveryError('Invalid model catalog response.');
        rows.push(...body[field]);
        if (id === 'anthropic' && body.has_more) {
          if (typeof body.last_id !== 'string' || !body.last_id) throw new DiscoveryError('Missing model catalog pagination cursor.');
          url.searchParams.set('after_id', body.last_id);
        } else if (id === 'openrouter' && body.links?.next) {
          if (typeof body.links.next !== 'string') throw new DiscoveryError('Invalid model catalog pagination.');
          url = new URL(body.links.next, url);
        } else url = null;
      }
      return this.#parse(id, rows);
    }, id === 'local' ? Math.min(this.timeout_ms, 1000) : this.timeout_ms);
  }

  /**
   * Built-ins have a per-provider endpoint. A custom provider's catalog hangs
   * off its own base URL in the conventional OpenAI place, so discovery is not
   * a second thing an operator has to configure.
   */
  #endpoint(id) {
    if (DISCOVERY[id]) return DISCOVERY[id];
    const spec = this.providers?.get(id);
    if (spec?.base_url) return [`${spec.base_url.replace(/\/$/, '')}/models`, 'data'];
    return null;
  }

  #parse(provider, rows) {
    const found = new Map();
    let explicit = null;
    for (const item of rows) {
      const row = typeof item === 'string' ? { id: item } : item;
      if (!row || typeof row !== 'object') continue;
      const id = provider === 'codex' ? (row.model ?? row.id) : provider === 'local' ? (row.model ?? row.name) : row.id;
      if (typeof id !== 'string' || !id.trim() || /[\x00-\x1f\x7f]/.test(id) || found.has(id)) continue;
      if (provider === 'codex' && row.hidden === true) continue;
      if (provider === 'openrouter' || provider === 'openai') {
        const output = row.architecture?.output_modalities ?? row.architecture?.modality?.split('->')[1]?.split('+');
        if (Array.isArray(output) && !output.includes('text')) continue;
        if (Array.isArray(row.supported_parameters) && !row.supported_parameters.some((p) => p === 'tools' || p === 'tool_choice')) continue;
        if (row.capabilities?.tools === false) continue;
      }
      const label = [row.displayName, row.display_name, row.name].find((value) => typeof value === 'string' && value.trim()) ?? id;
      const pricing = row.pricing;
      const zero = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number(value) === 0;
      const priceKnown = pricing && pricing.prompt != null && pricing.completion != null;
      const is_free = priceKnown ? Object.values(pricing).every(zero) : undefined;
      found.set(id, { id, provider, label, ...(is_free === undefined ? {} : { is_free }), description: typeof row.description === 'string' ? row.description : '',
        ...(provider !== 'codex' && typeof row.is_default === 'boolean' ? { is_default: row.is_default } : {}) });
      if (provider === 'codex') {
        if (row.isDefault === true) explicit ??= id;
      }
    }
    if (provider === 'codex' && explicit) found.get(explicit).is_default = true;
    // Catalog availability alone is not a guarantee of inference/tool support.
    return [...found.values()];
  }
}
