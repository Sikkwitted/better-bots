import fs from 'node:fs';
import path from 'node:path';
import { JsonDoc } from '../core/store.js';
import { writeEnvVar } from '../core/env-file.js';
import {
  PROVIDERS, normalizeModel, normalizeProvider, providerSlug, keyEnvName, normalizeBaseUrl,
} from '../../web/models.js';

// Providers come in two kinds. The built-ins in web/models.js are protocol
// configuration shipped with the host. Custom providers are an operator's own
// endpoint — added from the console or the CLI with a base URL and a key — and
// are stored here, because a model the account can reach but the vendor does
// not list should not need a code change to use.
//
// Custom providers speak the OpenAI chat-completions shape. That covers the
// hosted gateways and every local runtime worth naming; an Anthropic-shaped
// custom endpoint would need its own adapter wiring and is not here.

const CUSTOM_WIRES = ['openai'];
const MAX_LABEL = 40;

/** A provider id safe to store and to turn into an env-var name. */
class ProviderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const modelKey = (provider, id) => `${provider}\0${id}`;
const isCustomId = (id) => typeof id === 'string' && !Object.hasOwn(PROVIDERS, id);

export class ProviderStore {
  #applied = new Set();

  constructor({ dir = null, env = process.env, now = Date.now } = {}) {
    Object.assign(this, { env, now });
    this.doc = dir ? new JsonDoc(path.join(dir, 'providers.json'), { providers: {}, models: {} }) : null;
    this.secrets = dir ? new JsonDoc(path.join(dir, 'providers-secrets.json'), { keys: {} }, { mode: 0o600 }) : null;
    this.#load();
  }

  // ------------------------------------------------------------------ read

  /** Built-in first, then custom, so ordering in a picker is stable. */
  all() {
    return { ...PROVIDERS, ...this.custom() };
  }

  custom() {
    const stored = this.doc?.read()?.providers ?? {};
    const out = {};
    for (const [id, spec] of Object.entries(stored)) {
      if (!isCustomId(id) || !this.#validSpec(spec)) continue;
      out[id] = { ...spec, key_env: Array.isArray(spec.key_env) ? spec.key_env : [keyEnvName(id)] };
    }
    return out;
  }

  get(id) {
    if (!isCustomId(id)) return PROVIDERS[id];
    return this.custom()[id] ?? undefined;
  }

  normalize(id) {
    return this.get(id) ? id : null;
  }

  isCustom(id) {
    return Boolean(this.custom()[id]);
  }

  wire(id) {
    return this.get(id)?.wire ?? (isCustomId(id) ? 'openai' : 'anthropic');
  }

  /** Manual model entries: a model id a person vouches for, by provider. */
  manualModels() {
    const stored = this.doc?.read()?.models ?? {};
    const out = [];
    for (const entry of Object.values(stored)) {
      if (!this.#validModel(entry)) continue;
      out.push({ id: entry.id, provider: entry.provider, label: entry.label ?? null, manual: true });
    }
    return out;
  }

  one(provider, id) {
    return this.manualModels().find((m) => m.provider === provider && m.id === id) ?? null;
  }

  /**
   * The key for a provider, resolved the same way the adapters resolve it.
   * Custom keys live in the secrets file and are applied to the environment on
   * load, so an adapter that reads process.env finds them either way.
   */
  keyFor(id) {
    const spec = this.get(id);
    return spec?.key_env?.map((name) => process.env[name]).find(Boolean) ?? null;
  }

  /** True when this provider could serve a turn — a key, or no key needed. */
  keyed(id) {
    const spec = this.get(id);
    if (!spec) return false;
    if (!spec.key_env?.length) return true; // local runtime
    return Boolean(this.keyFor(id));
  }

  // ---------------------------------------------------------------- write

  addProvider({ label, base_url, key, wire = 'openai' } = {}) {
    const id = providerSlug(label);
    if (!id) throw new ProviderError('invalid_provider_label', 'A provider name needs letters, numbers, or dashes (up to 40).');
    if (Object.hasOwn(PROVIDERS, id)) throw new ProviderError('provider_reserved', `"${id}" is a built-in provider; save a key for it instead.`);
    if (this.custom()[id]) throw new ProviderError('provider_exists', `A provider named "${id}" already exists.`);
    const url = normalizeBaseUrl(base_url);
    if (!url) throw new ProviderError('invalid_base_url', 'The base URL must be http:// or https://, with no credentials, query string or fragment.');
    // A custom key name that equals a built-in's would share (and overwrite) that built-in's key.
    if (Object.values(PROVIDERS).some((p) => p.key_env?.includes(keyEnvName(id)))) throw new ProviderError('provider_reserved', `"${id}" collides with a built-in credential name; choose another name.`);
    if (!CUSTOM_WIRES.includes(wire)) throw new ProviderError('unsupported_wire', 'Custom providers must speak the OpenAI chat-completions format.');
    const spec = { id, label: String(label).trim().slice(0, MAX_LABEL), base_url: url,
      key_env: [keyEnvName(id)], wire, custom: true, added_at: this.now() };
    this.#writeSpecs((s) => { s.providers[id] = spec; return s; });
    if (key) this.#saveKey(spec.id, key);
    return spec;
  }

  updateProvider(id, { label, base_url, key } = {}) {
    const previous = this.custom()[id];
    if (!previous) throw new ProviderError('unknown_provider', 'No such custom provider.');
    const nextLabel = label === undefined ? previous.label : label;
    if (!providerSlug(nextLabel)) throw new ProviderError('invalid_provider_label', 'Enter a provider name with letters or numbers.');
    const url = normalizeBaseUrl(base_url === undefined ? previous.base_url : base_url);
    if (!url) throw new ProviderError('invalid_base_url', 'The base URL must be http:// or https://, with no credentials, query string or fragment.');
    const spec = { ...previous, label: String(nextLabel).trim().slice(0, MAX_LABEL), base_url: url };
    // Identity and credential names stay stable so model assignments survive edits.
    this.#writeSpecs(s => { s.providers[id] = spec; return s; });
    if (String(key ?? '').trim()) this.#saveKey(id, key);
    return spec;
  }

  removeProvider(id) {
    if (!isCustomId(id) || !this.custom()[id]) throw new ProviderError('unknown_provider', `No custom provider "${id}".`);
    // The key is cleared while the provider still exists, then its entry and models go.
    this.#saveKey(id, null);
    this.#writeSpecs((s) => {
      delete s.providers[id];
      for (const key of Object.keys(s.models).filter((k) => s.models[k].provider === id)) delete s.models[key];
      return s;
    });
  }

  addModel({ provider, model, label = null, key = null } = {}) {
    const spec = this.get(provider);
    if (!spec) throw new ProviderError('unknown_provider', `Unknown provider "${provider}".`);
    const id = normalizeModel(model);
    if (!id) throw new ProviderError('invalid_model', 'A model ID must be a nonempty string without control characters.');
    if (this.one(provider, id)) throw new ProviderError('model_exists', `${provider} / ${id} is already added.`);
    const entry = { id, provider, label: String(label ?? '').trim().slice(0, 120) || null, manual: true, added_at: this.now() };
    this.#writeSpecs((s) => { s.models[modelKey(provider, id)] = entry; return s; });
    if (key) this.#saveKey(provider, key);
    return entry;
  }

  removeModel(provider, id) {
    const model = normalizeModel(id);
    if (!model || !this.one(provider, model)) throw new ProviderError('unknown_model', `No manually added model ${provider} / ${id}.`);
    this.#writeSpecs((s) => { delete s.models[modelKey(provider, model)]; return s; });
  }

  /**
   * Save a credential for a provider, whichever kind it is: a built-in's key
   * reaches the env file the service unit reads, a custom provider's key stays
   * in the secrets file. One entry point so callers cannot pick the wrong one.
   */
  saveKey(providerId, key) {
    if (!this.get(providerId)) throw new ProviderError('unknown_provider', `no provider ${providerId}`);
    const name = this.get(providerId).key_env?.[0];
    if (!name) throw new ProviderError('no_credential', `${providerId} takes no key`);
    this.#saveKey(providerId, String(key ?? '').trim() || null);
  }

  // ------------------------------------------------------------ internals

  #validSpec(spec) {
    return typeof spec === 'object' && normalizeBaseUrl(spec.base_url)
      && Array.isArray(spec.key_env) && typeof spec.label === 'string' && spec.label.trim();
  }

  #validModel(entry) {
    return typeof entry === 'object' && Boolean(normalizeModel(entry.id)) && Boolean(this.get(entry.provider));
  }

  #writeSpecs(fn) {
    if (!this.doc) throw new ProviderError('no_store', 'This host keeps no provider store.');
    this.doc.update((doc) => fn({ providers: doc.providers ?? {}, models: doc.models ?? {} }));
    try { fs.chmodSync(this.doc.file, 0o600); } catch { /* not every filesystem cares */ }
    this.#load();
  }

  /**
   * A custom key is the operator's own: it goes to the secrets file and to the
   * environment the adapters read. A built-in provider's key belongs in the env
   * file the service unit reads at boot, so it is not duplicated into the
   * secrets file. A null key clears what was set.
   */
  #saveKey(providerId, key) {
    const spec = this.get(providerId);
    const name = spec?.key_env?.[0];
    if (!name) throw new ProviderError('no_credential', `Provider ${providerId} takes no key`);
    const value = key === null || key === undefined ? null : String(key).trim();
    if (!value) {
      if (this.secrets) this.secrets.update((s) => { delete s.keys?.[name]; return s; });
      if (this.#applied.has(name)) { delete process.env[name]; this.#applied.delete(name); }
      return;
    }
    if (isCustomId(providerId)) {
      if (!this.secrets) throw new ProviderError('no_store', 'This host keeps no provider store.');
      this.secrets.update((s) => { s.keys ??= {}; s.keys[name] = value; return s; });
      try { fs.chmodSync(this.secrets.file, 0o600); } catch { /* not every filesystem cares */ }
    } else {
      // Persist before reporting success, even when the host env file is not writable.
      if (this.secrets) {
        this.secrets.update(s => { s.keys ??= {}; s.keys[name] = value; return s; });
        fs.chmodSync(this.secrets.file, 0o600);
        try { writeEnvVar(name, value); } catch { /* durable secrets store is authoritative */ }
      } else {
        writeEnvVar(name, value);
      }
    }
    process.env[name] = value;
    this.#applied.add(name);
  }

  #load() {
    if (!this.secrets) return;
    const keys = this.secrets.read()?.keys ?? {};
    for (const [name, value] of Object.entries(keys)) {
      if (typeof value !== 'string' || !value) continue;
      process.env[name] = value;
      this.#applied.add(name);
    }
  }
}
