// Verified memory synthesis: the "what you know (settled)" block at the top of
// every prompt, written by a model and checked before it is allowed to change.
//
// Once per bank per day (or on demand), for a bank whose evidence has changed:
//   1. Evidence: the bank's saved facts and retained exchanges, newest first,
//      profile facts always included, each labelled E1..En.
//   2. Propose: a model writes at most eight short statements, each citing the
//      evidence labels it rests on.
//   3. Check citations: a statement without a citation, or citing a label that
//      was never shown, rejects the whole proposal. A model that invents its
//      sources is not trusted with the rest.
//   4. Verify: a second, separate model call sees each statement beside the text
//      of the evidence it cites and judges whether that evidence supports it.
//      Unsupported statements are dropped; if none survive, nothing changes.
//   5. Commit only if the evidence is unchanged since step 1. If memory moved
//      underneath the run, the result is discarded and the bank is retried later.
//
// The previous standing knowledge stays in force until a verified replacement
// is committed. Engine-agnostic: evidence comes from the local source records,
// so the same check runs whether recall is SQLite, Hindsight, or local-only.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { JsonDoc } from '../core/store.js';

export const CONSOLIDATE_EVERY_MS = 24 * 3_600_000;
export const RETRY_AFTER_MS = 10 * 60_000;   // first retry after a failed model call; doubles up to a day
const MAX_EVIDENCE = 60;
const MAX_EVIDENCE_CHARS = 16_000;
const EVIDENCE_ITEM_CHARS = 600;
const MAX_STATEMENTS = 8;
const STATEMENT_CHARS = 240;
const MIN_EVIDENCE = 2;

const SCOPE_QUESTION = {
  agent: 'What should this agent keep in mind at all times: its responsibilities, commitments it has made, how it works, and settled facts about its current work?',
  user: 'Who is the person these agents work for, and what do they prefer, dislike, and expect?',
  project: 'What is the current state of the shared project: decisions in force, owners, deadlines, and conventions?',
};

const PROPOSE_SYSTEM = `You maintain an assistant's long-term memory. You are shown numbered evidence (E1, E2, ...) taken from saved notes and past conversations.
Write the settled knowledge that answers the question, as at most ${MAX_STATEMENTS} short statements of under ${STATEMENT_CHARS} characters each.
Rules:
- Every statement must cite the evidence labels that directly support it. Cite only labels you were shown.
- Only settled knowledge: stated preferences, decisions, owners, commitments, conventions. No speculation, no one-off chatter.
- When evidence conflicts, the newer evidence wins and a correction outranks what it corrects.
- Never include secrets, keys, passwords or personal identifiers.
Answer with JSON only, no prose: {"statements":[{"text":"...","evidence":["E1","E4"]}]}`;

const VERIFY_SYSTEM = `You are a strict fact-checker for an assistant's long-term memory. For each numbered claim you are shown the exact evidence it cites.
A claim is supported only if the cited evidence states it or directly implies it. Unsupported, exaggerated, merged from unrelated evidence, or contradicted by newer cited evidence: not supported.
Answer with JSON only, no prose: {"verdicts":[{"claim":1,"supported":true,"reason":"short"}]}`;

/** The first JSON object in a model's answer, tolerating code fences and stray prose. */
export function parseJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

export function parseJsonArray(text) {
  const s = String(text ?? '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/** A short, single-line piece of a reply that could not be read, for the audit. */
const snippet = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || '(empty reply)';

/**
 * Collect a non-tool model answer as text. Effort is pinned low: this is
 * housekeeping, and `low` is a value every provider accepts (some providers
 * reject the usual `medium`).
 */
async function complete(adapter, { system, user, model, provider, signal }) {
  let text = '';
  for await (const event of adapter.stream([{ role: 'user', content: user }], [], { system, model, provider, signal, reasoning_effort: 'low' })) {
    if (event.type === 'text' && event.text) text += event.text;
  }
  return text;
}

export class MemoryConsolidation {
  constructor({ dir, clock, audit, memory, adapter, modelFor = () => ({}), every_ms = CONSOLIDATE_EVERY_MS }) {
    Object.assign(this, { clock, audit, memory, adapter, modelFor, every_ms });
    this.doc = new JsonDoc(path.join(dir, 'memory', 'standing.json'), { banks: {} });
    this.running = null;
  }

  static key(scope, owner_id) { return `${scope}-${owner_id}`; }

  /** The committed, verified standing knowledge for one scope, or null. */
  standing(scope, owner_id) {
    const bank = this.doc.read().banks[MemoryConsolidation.key(scope, owner_id)];
    if (!bank?.statements?.length) return null;
    return { text: bank.statements.map((s) => `- ${s.text}`).join('\n'), refreshed_at: bank.verified_at, verified: true };
  }

  /** What the bank's statements may cite: profile facts first, then everything else newest first. */
  evidence(scope, owner_id) {
    const facts = this.memory.factsIn(scope, owner_id).filter((f) => f.tier !== 'note')
      .map((f) => ({ id: f.id, text: f.text, at: f.learned_at, profile: f.tier === 'profile' }));
    const exchanges = Object.values(this.memory.retention.doc.read().jobs)
      .filter((j) => !j.fact && j.scope === scope && j.owner_id === owner_id && j.item?.content)
      .map((j) => ({ id: j.id, text: j.item.content, at: j.item.timestamp ?? j.created_at, profile: false }));
    const ordered = [...facts.filter((f) => f.profile), ...[...facts.filter((f) => !f.profile), ...exchanges].sort((a, b) => String(b.at).localeCompare(String(a.at)))];
    const out = [];
    let chars = 0;
    for (const item of ordered) {
      const text = item.text.length > EVIDENCE_ITEM_CHARS ? `${item.text.slice(0, EVIDENCE_ITEM_CHARS - 1)}…` : item.text;
      if (out.length >= MAX_EVIDENCE || chars + text.length > MAX_EVIDENCE_CHARS) break;
      out.push({ ...item, text });
      chars += text.length;
    }
    return out;
  }

  static version(evidence) {
    return createHash('sha256').update(JSON.stringify(evidence.map((e) => [e.id, e.text]))).digest('hex').slice(0, 16);
  }

  /** Banks with new evidence whose turn has come. */
  due(banks, { force = false } = {}) {
    const state = this.doc.read().banks;
    const now = this.clock.now();
    return banks.filter(({ scope, owner_id }) => {
      const bank = state[MemoryConsolidation.key(scope, owner_id)] ?? {};
      if (!force && bank.retry_at && Date.parse(bank.retry_at) > now) return false;
      if (!force && !bank.retry_at && bank.attempted_at && now - Date.parse(bank.attempted_at) < this.every_ms) return false;
      const evidence = this.evidence(scope, owner_id);
      return evidence.length >= MIN_EVIDENCE && MemoryConsolidation.version(evidence) !== bank.evidence_version;
    });
  }

  /** One bank at a time, never overlapping: a background pass must not flood the model. */
  run(banks, options = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const results = [];
      for (const bank of this.due(banks, options)) results.push(await this.consolidate(bank.scope, bank.owner_id));
      return results;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** A failed model call is retried after 10 min, then 20, 40, ... at most daily. */
  #failed(key) {
    const failures = (this.doc.read().banks[key]?.failures ?? 0) + 1;
    const wait = Math.min(CONSOLIDATE_EVERY_MS, RETRY_AFTER_MS * 2 ** (failures - 1));
    this.#note(key, { failures, retry_at: new Date(this.clock.now() + wait).toISOString(), last_outcome: 'model_failed' });
  }

  #note(key, patch) {
    this.doc.update((state) => { state.banks[key] = { ...(state.banks[key] ?? {}), ...patch }; return state; });
  }

  async consolidate(scope, owner_id) {
    const key = MemoryConsolidation.key(scope, owner_id);
    const now = this.clock.iso();
    const evidence = this.evidence(scope, owner_id);
    const version = MemoryConsolidation.version(evidence);
    const label = new Map(evidence.map((e, i) => [`E${i + 1}`, e]));
    const settings = this.modelFor(scope, owner_id) ?? {};
    const reject = (reason, detail = {}) => {
      this.#note(key, { attempted_at: now, retry_at: null, failures: 0, evidence_version: version, last_outcome: reason });
      this.audit.record('memory.synthesis_rejected', { scope, owner_id, reason, ...detail });
      return { scope, owner_id, outcome: 'rejected', reason, ...detail };
    };
    this.#note(key, { attempted_at: now });

    let proposal;
    let proposeReply = '';
    try {
      const user = `Question: ${SCOPE_QUESTION[scope]}\n\nEvidence:\n${evidence.map((e, i) => `E${i + 1} (${String(e.at).slice(0, 10)}): ${e.text}`).join('\n')}`;
      proposeReply = await complete(this.adapter, { system: PROPOSE_SYSTEM, user, ...settings });
      proposal = parseJsonObject(proposeReply);
    } catch (err) {
      this.#failed(key);
      this.audit.record('memory.synthesis_failed', { scope, owner_id, stage: 'propose', error: err.message });
      return { scope, owner_id, outcome: 'failed', stage: 'propose', error: err.message };
    }
    const statements = Array.isArray(proposal?.statements) ? proposal.statements.slice(0, MAX_STATEMENTS) : null;
    if (!statements?.length) return reject('proposal_unreadable', { reply: snippet(proposeReply) });
    for (const s of statements) {
      const cites = Array.isArray(s?.evidence) ? s.evidence.map(String) : [];
      if (typeof s?.text !== 'string' || !s.text.trim()) return reject('empty_statement');
      if (!cites.length) return reject('uncited_statement', { statement: s.text.slice(0, 120) });
      const unknown = cites.filter((c) => !label.has(c));
      if (unknown.length) return reject('unknown_evidence_citation', { cited: unknown.slice(0, 5) });
    }
    const claims = statements.map((s) => ({ text: s.text.trim().slice(0, STATEMENT_CHARS), cites: [...new Set(s.evidence.map(String))] }));

    let verdicts;
    let verifyReply = '';
    try {
      const user = claims.map((c, i) => `Claim ${i + 1}: ${c.text}\nCited evidence:\n${c.cites.map((l) => `  ${l}: ${label.get(l).text}`).join('\n')}`).join('\n\n');
      verifyReply = await complete(this.adapter, { system: VERIFY_SYSTEM, user, ...settings });
      const arrayFirst = verifyReply.indexOf('[') >= 0 && (verifyReply.indexOf('{') < 0 || verifyReply.indexOf('[') < verifyReply.indexOf('{'));
      const parsed = arrayFirst ? parseJsonArray(verifyReply) ?? parseJsonObject(verifyReply) : parseJsonObject(verifyReply) ?? parseJsonArray(verifyReply);
      verdicts = Array.isArray(parsed) ? parsed : parsed?.verdicts;
    } catch (err) {
      this.#failed(key);
      this.audit.record('memory.synthesis_failed', { scope, owner_id, stage: 'verify', error: err.message });
      return { scope, owner_id, outcome: 'failed', stage: 'verify', error: err.message };
    }
    if (!Array.isArray(verdicts)) return reject('verification_unreadable', { reply: snippet(verifyReply) });
    const supported = new Set(verdicts.filter((v) => v?.supported === true).map((v) => Number(v.claim)));
    const approved = claims.filter((_, i) => supported.has(i + 1));
    const dropped = claims.filter((_, i) => !supported.has(i + 1)).map((c) => c.text.slice(0, 120));
    if (!approved.length) return reject('verification_did_not_approve', { dropped });

    // Memory may have changed while two model calls ran. A summary of evidence
    // that no longer stands is not committed; the bank is tried again soon.
    if (MemoryConsolidation.version(this.evidence(scope, owner_id)) !== version) {
      this.#note(key, { retry_at: new Date(this.clock.now() + RETRY_AFTER_MS).toISOString(), last_outcome: 'evidence_changed' });
      this.audit.record('memory.synthesis_requeued', { scope, owner_id, reason: 'evidence_changed' });
      return { scope, owner_id, outcome: 'requeued' };
    }

    this.#note(key, {
      statements: approved.map((c) => ({ text: c.text, evidence: c.cites.map((l) => label.get(l).id) })),
      evidence_version: version, verified_at: this.clock.iso(), retry_at: null, failures: 0, last_outcome: 'committed',
    });
    this.audit.record('memory.synthesis_committed', { scope, owner_id, statements: approved.length, dropped: dropped.length });
    return { scope, owner_id, outcome: 'committed', statements: approved.length, dropped };
  }
}
