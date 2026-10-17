import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRetention } from './memory-retention.js';
import { JsonlLog } from '../core/store.js';
import { newId, overlapScore, HostError } from '../core/util.js';

// Memory has tiers and scopes.
//
// Tiers:  profile (enduring, always visible) | log (substantive history) | note (on disk only)
// Scopes: agent (private) | user (shared, per-assistant shards) | project (shared, per-assistant shards)
//
// Shared scopes are stored in per-assistant shards so every file has exactly one
// writer: shared memory uses single-writer records.
//
// Design rule: store broadly, retrieve narrowly, and show the model
// only what the current turn can justify.
//
// The JSONL files are the source of truth. An optional engine (Hindsight) sits
// behind them for extraction and semantic ranking: every fact is also retained
// into the bank for its scope, and recall asks the engine for the ranked slice.
// The host still decides which banks a caller may read, so the engine never sees
// a cross-scope query; and if the engine is down, ranking falls back to the local
// word-overlap ordering. The engine can be rebuilt from the files at any time.

export const TIERS = ['profile', 'log', 'note'];
export const SCOPES = ['agent', 'user', 'project'];

const TIER_WEIGHT = { profile: 3, log: 2, note: 0 };
// What each bank's standing knowledge answers. Written by the engine after
// consolidation, read as a row at recall time: the profile that writes itself.
const STANDING_QUERY = {
  agent: 'What should this agent keep in mind at all times: its responsibilities, commitments it has made, how it works, and settled facts about its current work? Only settled knowledge, briefly.',
  user: 'Who is the person these agents work for, and what do they prefer, dislike, and expect? Only settled knowledge, briefly.',
  project: 'What is the current state of the shared project: decisions in force, owners, deadlines, and conventions? Only settled knowledge, briefly.',
};
const STANDING_DISPLAY_CHARS = 500;
export const DEFAULT_RECALL_BUDGET_CHARS = 1600;
const CHARS_PER_TOKEN = 4;

export class MemoryService {
  constructor({ dir, clock, audit, budgetChars = DEFAULT_RECALL_BUDGET_CHARS, engine = null }) {
    this.dir = dir;
    this.clock = clock;
    this.audit = audit;
    this.budgetChars = budgetChars;
    this.engine = engine;
    // Verified standing knowledge (memory-consolidation.js), set by the host.
    // When present it wins over an engine's own unverified summary.
    this.consolidation = null;
    this.logs = new Map();
    this.ensured = new Map();
    this.retention = new MemoryRetention({ dir, clock, audit, engine,
      bank: (scope, owner) => this.#bank(scope, owner),
      ensureBank: (scope, owner) => this.#ensureBank(scope, owner),
      writeFact: (fact) => {
        const shard = this.#shard(fact.owner_scope, fact.owner_id, fact.writer_agent_id);
        if (!shard.readAll().some((f) => f.id === fact.id)) shard.append(fact);
      },
    });
  }

  /** One file per (scope, owner, writing agent). One writer per file, always. */
  #shard(scope, ownerId, writerAgentId) {
    if (!SCOPES.includes(scope)) throw new HostError('bad_scope', `unknown scope ${scope}`);
    const file =
      scope === 'agent'
        ? path.join(this.dir, 'agents', ownerId, 'memory.jsonl')
        : path.join(this.dir, 'memory', scope, ownerId, `shard-${writerAgentId}.jsonl`);
    if (!this.logs.has(file)) this.logs.set(file, new JsonlLog(file, { validate: (r) => typeof r.id === 'string' && typeof r.text === 'string' && TIERS.includes(r.tier) && r.owner_scope === scope && r.owner_id === ownerId }));
    return this.logs.get(file);
  }

  #bank(scope, ownerId) {
    const bank = this.engine.constructor.bankId ? this.engine.constructor.bankId(scope, ownerId) : `${scope}-${ownerId}`;
    return bank;
  }

  async #ensureBank(scope, ownerId) {
    const bank = this.#bank(scope, ownerId);
    if (!this.ensured.has(bank)) {
      const work = Promise.resolve().then(() => this.engine.ensureBank?.(bank, { name: `${scope} ${ownerId}`, standing_query: STANDING_QUERY[scope] }));
      this.ensured.set(bank, work);
      work.catch(() => this.ensured.delete(bank));
    }
    return this.ensured.get(bank);
  }

  async flush() { await this.retention.flush(); }
  recover() { return this.retention.recover(); }

  remember({ scope, owner_id, writer_agent_id, tier = 'log', text, source = 'turn', ref = null, retain = true }) {
    if (!TIERS.includes(tier)) throw new HostError('bad_tier', `unknown tier ${tier}`);
    if (scope === 'agent' && owner_id !== writer_agent_id) {
      // An agent-scoped fact is private to its owner; nobody else may write it.
      throw new HostError('scope_violation', 'agent-scoped memory is written by its owner only');
    }
    if (!SCOPES.includes(scope)) throw new HostError('bad_scope', `unknown scope ${scope}`);
    // Every bot sees user and project memory, and profile facts are always in its
    // prompt. A bot that wrote one there would be handing instructions to all the
    // others. Only the person (the console's Correct form) sets standing shared
    // facts; a bot's is kept as a log fact, found when it is relevant.
    if (scope !== 'agent' && tier === 'profile' && writer_agent_id !== 'user') tier = 'log';
    const fact = {
      id: newId('mem'),
      owner_scope: scope,
      owner_id,
      writer_agent_id,
      tier,
      text: String(text),
      learned_at: this.clock.iso(),
      source,
      // What the fact was extracted from, so a caller can tell whether the prompt
      // already carries it. Optional: a fact stands on its own without one.
      ...(ref ? { ref } : {}),
    };
    this.retention.enqueue({ key: fact.id, scope, owner_id, writer_agent_id, fact, retain,
      item: { content: fact.text, context: `${scope} memory, ${tier} tier`, timestamp: fact.learned_at,
        metadata: { fact_id: fact.id, tier, writer_agent_id, source, owner_scope: scope, ...(ref?.run_id ? { run_id: ref.run_id } : {}) } },
    });
    this.audit.record('memory.remembered', { fact_id: fact.id, scope, owner_id, writer_agent_id, tier });
    return fact;
  }

  /**
   * Every turn ends by extracting and storing what mattered. The whole exchange
   * goes to the engine, which extracts what is worth keeping; the transcript
   * holds the visible record; the retention journal preserves the exact source
   * separately from extracted facts, including when no engine is configured.
   */
  retainExchange({ scope, owner_id, writer_agent_id, content, context, ref = null, document_id = null, timestamp = null }) {
    if (!SCOPES.includes(scope)) throw new HostError('bad_scope', `unknown scope ${scope}`);
    if (scope === 'agent' && owner_id !== writer_agent_id) {
      throw new HostError('scope_violation', 'agent-scoped memory is written by its owner only');
    }
    const learned_at = timestamp ?? this.clock.iso();
    const key = document_id ?? (ref?.run_id ? `run-${ref.run_id}` : newId('exchange'));
    // An engine makes a room's outcome recallable. Without one it is kept as a
    // local fact instead, with an id derived from the outcome so a replay matches.
    const fact = !this.engine && ref?.room_id ? {
      id: `mem_${createHash('sha256').update(JSON.stringify([scope, owner_id, writer_agent_id, key])).digest('hex').slice(0, 24)}`,
      owner_scope: scope, owner_id, writer_agent_id, tier: 'log', text: String(content), learned_at, source: 'room', ref,
    } : null;
    return this.retention.enqueue({ scope, owner_id, writer_agent_id, key, fact,
      item: { content, context, timestamp: learned_at,
        metadata: { tier: 'log', writer_agent_id, source: 'exchange', owner_scope: scope,
          ...(ref?.run_id ? { run_id: ref.run_id } : {}), ...(ref?.room_id ? { room_id: ref.room_id } : {}) },
      },
    });
  }

  /** Every fact in one scope, across all writer shards. Disk read, not prompt injection. */
  factsIn(scope, ownerId) {
    if (scope === 'agent') return this.#shard('agent', ownerId, ownerId).readAll();
    const dir = path.join(this.dir, 'memory', scope, ownerId);
    return listShards(dir).flatMap((file) => new JsonlLog(file, { validate: (r) => typeof r.id === 'string' && typeof r.text === 'string' && TIERS.includes(r.tier) && r.owner_scope === scope && r.owner_id === ownerId }).readAll());
  }

  /** The scopes a caller may read: its own agent scope plus whatever shared scopes were asked for. */
  #permitted(agent_id, scopes) {
    const permitted = [];
    for (const { scope, owner_id } of [{ scope: 'agent', owner_id: agent_id }, ...scopes]) {
      if (scope === 'agent' && owner_id !== agent_id) {
        // Agent-scoped memory does not enter another agent's prompt.
        this.audit.record('memory.scope_blocked', { agent_id, scope, owner_id });
        continue;
      }
      permitted.push({ scope, owner_id });
    }
    return permitted;
  }

  /**
   * Budgeted view, not a full dump.
   * Profile facts stay visible; the rest are ranked by relevance and recency and
   * cut off at the character budget. Anything dropped is reported, not hidden.
   * With an engine, the ranked remainder comes from it; otherwise from word overlap.
   */
  async recall({ agent_id, scopes = [], query = '', budget_chars = this.budgetChars, exclude_runs = null }) {
    const permitted = this.#permitted(agent_id, scopes);
    const seen = new Set();
    const local = [];
    let already_in_prompt = 0;

    for (const { scope, owner_id } of permitted) {
      for (const fact of this.factsIn(scope, owner_id)) {
        if (seen.has(fact.id)) continue;
        seen.add(fact.id);
        // Dropped before ranking, not after, so the budget it would have taken
        // is spent on something the prompt does not already say.
        if (exclude_runs?.has(fact.ref?.run_id)) {
          already_in_prompt += 1;
          continue;
        }
        local.push(fact);
      }
    }

    // Profile facts get first claim on the budget, and the ranked remainder
    // fills whatever is left. A keyword hit on a passing detail must not push
    // out an enduring fact about who this agent is.
    const awaitingRetention = new Set(Object.values(this.retention.doc.read().jobs).filter((j) => j.fact && j.retain && j.status !== 'succeeded').map((j) => j.fact.id));
    const profile = this.#rankLocal(local.filter((f) => f.tier === 'profile'), query);
    let remainder;
    let engine = 'local';
    let standing = [];
    if (this.engine && query.trim()) {
      try {
        const [ranked, known] = await Promise.all([
          this.#recallEngine(permitted, query, budget_chars, exclude_runs),
          this.#standing(permitted),
        ]);
        already_in_prompt += ranked.already_in_prompt;
        const pendingFacts = this.#rankLocal(local.filter((f) => f.tier === 'log' && awaitingRetention.has(f.id)), query);
        const pendingIds = new Set(pendingFacts.map((f) => f.id));
        remainder = [...pendingFacts, ...ranked.facts.filter((f) => f.tier !== 'profile' && !pendingIds.has(f.id))];
        standing = known;
        engine = this.engine.name ?? 'engine';
      } catch (err) {
        this.audit.record('memory.engine_fallback', { agent_id, error: err.message });
      }
    }
    // A verified summary replaces the engine's for its scope; scopes it has not
    // covered yet keep the engine's, so nothing goes blank while the first runs.
    const verified = this.#verifiedStanding(permitted);
    standing = [...verified, ...standing.filter((k) => !verified.some((v) => v.scope === k.scope && v.owner_id === k.owner_id))];
    if (!remainder) {
      // `note` never enters a prompt automatically; it stays on disk for search().
      remainder = this.#rankLocal(local.filter((f) => f.tier === 'log'), query);
    }

    const included = [];
    let used = 0;
    let dropped = 0;
    for (const fact of [...profile, ...remainder]) {
      if (used + fact.text.length > budget_chars) {
        dropped += 1;
        continue;
      }
      included.push(fact);
      used += fact.text.length;
    }

    return {
      facts: included,
      budget_chars,
      chars_used: used,
      dropped_for_budget: dropped,
      on_disk_only: local.length - included.filter((f) => seen.has(f.id)).length,
      already_in_prompt,
      engine,
      standing,
    };
  }

  #verifiedStanding(permitted) {
    if (!this.consolidation) return [];
    return permitted.map(({ scope, owner_id }) => {
      const known = this.consolidation.standing(scope, owner_id);
      if (!known) return null;
      const text = known.text.length > STANDING_DISPLAY_CHARS ? `${known.text.slice(0, STANDING_DISPLAY_CHARS - 1).trimEnd()}…` : known.text;
      return { scope, owner_id, text, refreshed_at: known.refreshed_at, verified: true };
    }).filter(Boolean);
  }

  /** Each permitted bank's standing knowledge, if the engine has written one yet. Outside the fact budget, clipped. */
  async #standing(permitted) {
    if (!this.engine.standingKnowledge) return [];
    const rows = await Promise.all(permitted.map(async ({ scope, owner_id }) => {
      void this.#ensureBank(scope, owner_id).catch(() => {});
      const known = await this.engine.standingKnowledge(this.#bank(scope, owner_id)).catch(() => null);
      if (!known) return null;
      const text = known.text.length > STANDING_DISPLAY_CHARS ? `${known.text.slice(0, STANDING_DISPLAY_CHARS - 1).trimEnd()}…` : known.text;
      return { scope, owner_id, text, refreshed_at: known.refreshed_at };
    }));
    return rows.filter(Boolean);
  }

  #rankLocal(facts, query) {
    const now = Date.parse(this.clock.iso());
    return facts
      .map((fact) => {
        const ageDays = Math.max(0, (now - Date.parse(fact.learned_at)) / 86_400_000);
        const recency = 1 / (1 + ageDays);
        return { fact, score: TIER_WEIGHT[fact.tier] + overlapScore(query, fact.text) * 2 + recency };
      })
      .sort((a, b) => b.score - a.score)
      .map((s) => s.fact);
  }

  /** One engine call per permitted bank, in parallel; results become facts the envelope understands. */
  async #recallEngine(permitted, query, budget_chars, exclude_runs, { include_notes = false } = {}) {
    const max_tokens = Math.max(64, Math.ceil(budget_chars / CHARS_PER_TOKEN));
    const perBank = await Promise.all(permitted.map(async ({ scope, owner_id }) => {
      void this.#ensureBank(scope, owner_id).catch(() => {});
      return this.engine.recall(this.#bank(scope, owner_id), { query, max_tokens, query_timestamp: this.clock.iso() })
        .then((results) => results.map((r) => this.#factFromEngine(r, scope, owner_id))); }));
    const facts = [];
    let already_in_prompt = 0;
    const seen = new Set();
    // Interleave banks by rank so one chatty scope does not starve the others.
    const longest = Math.max(0, ...perBank.map((b) => b.length));
    for (let i = 0; i < longest; i += 1) {
      for (const bank of perBank) {
        const fact = bank[i];
        if (!fact || seen.has(fact.id)) continue;
        seen.add(fact.id);
        if (exclude_runs?.has(fact.ref?.run_id)) { already_in_prompt += 1; continue; }
        if (fact.tier === 'note' && !include_notes) continue;
        facts.push(fact);
      }
    }
    return { facts, already_in_prompt };
  }

  #factFromEngine(r, scope, owner_id) {
    const m = r.metadata ?? {};
    return {
      id: m.fact_id ?? `eng_${r.id}`,
      engine_id: r.id,
      owner_scope: scope,
      owner_id,
      writer_agent_id: m.writer_agent_id ?? null,
      tier: TIERS.includes(m.tier) ? m.tier : 'log',
      text: r.text,
      learned_at: r.mentioned_at ?? this.clock.iso(),
      source: m.source ?? 'engine',
      ...(r.occurred_start ? { when: r.occurred_start } : {}),
      ...(m.run_id ? { ref: { run_id: m.run_id } } : {}),
    };
  }

  /**
   * Older material is searchable without ever entering a prompt.
   * Notes are included here: an explicit search is the one read they are kept for.
   */
  async search({ agent_id = null, scope, owner_id, scopes = null, query, limit = 20 }) {
    const requested = scopes ?? [{ scope, owner_id }];
    const permitted = agent_id ? this.#permitted(agent_id, requested.filter((s) => !(s.scope === 'agent' && s.owner_id === agent_id))) : requested;
    const awaitingRetention = new Set(Object.values(this.retention.doc.read().jobs).filter((j) => j.fact && j.retain && j.status !== 'succeeded').map((j) => j.fact.id));
    if (this.engine && query.trim()) {
      try {
        const ranked = await this.#recallEngine(permitted, query, limit * 200, null, { include_notes: true });
        const pendingFacts = this.#rankLocal(permitted.flatMap(({ scope: s, owner_id: o }) => this.factsIn(s, o)).filter((f) => awaitingRetention.has(f.id) && overlapScore(query, f.text) > 0), query);
        const pendingIds = new Set(pendingFacts.map((f) => f.id));
        return [...pendingFacts, ...ranked.facts.filter((f) => !pendingIds.has(f.id))].slice(0, limit);
      } catch (err) {
        this.audit.record('memory.engine_fallback', { agent_id, op: 'search', error: err.message });
      }
    }
    return permitted
      .flatMap(({ scope: s, owner_id: o }) => this.factsIn(s, o))
      .map((fact) => ({ fact, score: overlapScore(query, fact.text) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.fact);
  }
}

function listShards(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('shard-') && f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
}
