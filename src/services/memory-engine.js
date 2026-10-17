// Hindsight behind MemoryService: store broadly, retrieve narrowly.
//
// The host decides which bank a call may touch; this class only speaks HTTP to
// one bank at a time. Every method rejects on failure and the caller falls back
// to the local ranking, so the engine being down costs recall quality, never a
// turn. Bank ids are `<scope>-<owner_id>`: one bank per memory scope, and the
// engine enforces that a bank cannot see another bank's facts.

import path from 'node:path';
import { SqliteEngine } from './sqlite-engine.js';

const RETAIN_TIMEOUT_MS = 90_000; // extraction is a model call
const RECALL_TIMEOUT_MS = 4_000;  // a turn should not wait long on memory
export const STANDING_ID = 'standing-knowledge';

export class HindsightEngine {
  constructor({ url, api_key, fetch = globalThis.fetch, tenant = 'default' }) {
    if (!url) throw new Error('HindsightEngine needs a url');
    this.url = String(url).replace(/\/+$/, '');
    this.api_key = api_key ?? null;
    this.fetch = fetch;
    this.tenant = tenant;
    this.name = 'hindsight';
    this.supportsAsyncRetention = true;
  }

  static bankId(scope, ownerId) {
    return `${scope}-${String(ownerId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  }

  async #call(method, path, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`hindsight ${path} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await this.fetch(`${this.url}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.api_key ? { authorization: `Bearer ${this.api_key}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = new Error(`hindsight ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
        error.status = res.status;
        const retry = res.headers?.get('retry-after');
        error.retry_after_ms = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
        if (!Number.isFinite(error.retry_after_ms)) error.retry_after_ms = 0;
        throw error;
      }
      return res.status === 204 ? null : res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    return this.#call('GET', '/health', undefined, RECALL_TIMEOUT_MS);
  }

  /**
   * Make a bank ours: create it if needed, turn on Memory Defense so a secret or
   * PII pasted into a turn is redacted before it is stored, and give it one
   * standing-knowledge mental model that refreshes after each consolidation.
   * Idempotent; called once per bank per process.
   */
  async ensureBank(bank, { name = bank, standing_query = null, max_tokens = 256 } = {}) {
    const banks = `/v1/${this.tenant}/banks/${bank}`;
    await this.#call('PUT', banks, { name }, RECALL_TIMEOUT_MS);
    await this.#call('PATCH', `${banks}/config`, {
      updates: { memory_defense: { enabled: true, rules: [{ on: 'sensitive_data', action: 'redact' }] } },
    }, RECALL_TIMEOUT_MS);
    if (standing_query) {
      const existing = await this.#call('GET', `${banks}/mental-models/${STANDING_ID}?detail=metadata`, undefined, RECALL_TIMEOUT_MS).catch((err) => (/-> 404/.test(err.message) ? null : Promise.reject(err)));
      if (!existing) {
        await this.#call('POST', `${banks}/mental-models`, {
          id: STANDING_ID, name: 'Standing knowledge', source_query: standing_query, max_tokens: Math.max(256, max_tokens),
          trigger: { refresh_after_consolidation: true, min_refresh_interval_seconds: 3600 },
        }, RETAIN_TIMEOUT_MS);
      }
    }
    return true;
  }

  /** The bank's standing knowledge: a database read, no model call. Null until it has been written. */
  async standingKnowledge(bank) {
    const data = await this.#call('GET', `/v1/${this.tenant}/banks/${bank}/mental-models/${STANDING_ID}?detail=content`, undefined, RECALL_TIMEOUT_MS)
      .catch((err) => (/-> 404/.test(err.message) ? null : Promise.reject(err)));
    const text = data?.content?.trim();
    // The engine writes a placeholder while a refresh runs; that is not knowledge.
    if (!text || /^Generating content/i.test(text)) return null;
    return { text, refreshed_at: data.last_refreshed_at ?? null };
  }

  /**
   * Store one passage; the engine extracts the facts. `metadata` values must be
   * strings and come back on recall, which is how tier, writer, and the source
   * run survive the trip.
   */
  async retain(bank, { content, context = null, timestamp = null, metadata = {}, document_id = null, operation_id = null }) {
    const item = {
      content: String(content),
      ...(context ? { context } : {}),
      ...(timestamp ? { timestamp } : {}),
      ...(document_id ? { document_id } : {}),
      metadata: Object.fromEntries(
        Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
      ),
    };
    return this.#call('POST', `/v1/${this.tenant}/banks/${bank}/memories`, { items: [item], async: Boolean(operation_id), ...(operation_id ? {operation_id} : {}) }, operation_id ? RECALL_TIMEOUT_MS : RETAIN_TIMEOUT_MS);
  }

  async retentionStatus(bank, operationId) {
    return this.#call('GET', `/v1/${this.tenant}/banks/${encodeURIComponent(bank)}/operations/${encodeURIComponent(operationId)}`, undefined, RECALL_TIMEOUT_MS);
  }

  /** Ranked facts for a query, within a token budget. One bank per call, always. */
  async recall(bank, { query, max_tokens = 600, budget = 'low', query_timestamp = null }) {
    const body = {
      query: String(query),
      max_tokens,
      budget,
      ...(query_timestamp ? { query_timestamp } : {}),
    };
    const data = await this.#call('POST', `/v1/${this.tenant}/banks/${bank}/memories/recall`, body, RECALL_TIMEOUT_MS);
    return (data?.results ?? []).map((r) => ({
      id: r.id,
      text: r.text,
      type: r.type ?? null,
      metadata: r.metadata ?? {},
      mentioned_at: r.mentioned_at ?? null,
      occurred_start: r.occurred_start ?? null,
    }));
  }
}

/**
 * The memory engine for a data folder. SQLite is the default and needs nothing
 * installed; Hindsight is optional and used only when HINDSIGHT_URL names one.
 * BETTER_BOTS_MEMORY_ENGINE=sqlite|hindsight|local overrides the choice; `local`
 * is word-overlap ranking over the files alone. Null means local.
 */
export function engineFromEnv(env = process.env, { dir = env.BETTER_BOTS_DIR ?? null } = {}) {
  const choice = env.BETTER_BOTS_MEMORY_ENGINE ?? (env.HINDSIGHT_URL ? 'hindsight' : 'sqlite');
  if (choice === 'hindsight') {
    if (!env.HINDSIGHT_URL) throw new Error('BETTER_BOTS_MEMORY_ENGINE=hindsight needs HINDSIGHT_URL');
    return new HindsightEngine({ url: env.HINDSIGHT_URL, api_key: env.HINDSIGHT_API_KEY ?? null });
  }
  if (choice === 'sqlite' && dir) return SqliteEngine.open({ file: path.join(dir, 'memory', 'memory.sqlite') });
  return null;
}
