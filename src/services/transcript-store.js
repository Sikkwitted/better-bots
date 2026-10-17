import path from 'node:path';
import { JsonlLog } from '../core/store.js';
import { newId, HostError } from '../core/util.js';

// One append-only conversation record per agent and per room. Each agent has an
// isolated transcript store, and group rooms have their own transcript.

const OWNERS = new Set(['agent', 'room']);

export class TranscriptStore {
  constructor({ dir, clock }) {
    this.dir = dir;
    this.clock = clock;
    this.logs = new Map();
    this.cache = new Map();
  }

  #log(ownerKind, ownerId) {
    if (!OWNERS.has(ownerKind)) throw new HostError('bad_owner', `unknown owner kind ${ownerKind}`);
    const key = `${ownerKind}:${ownerId}`;
    if (!this.logs.has(key)) {
      const file =
        ownerKind === 'agent'
          ? path.join(this.dir, 'agents', ownerId, 'transcript.jsonl')
          : path.join(this.dir, 'rooms', ownerId, 'transcript.jsonl');
      this.logs.set(key, new JsonlLog(file, { validate: (r) => typeof r.id === 'string' && typeof r.kind === 'string' }));
    }
    return this.logs.get(key);
  }

  /**
   * @param entry {{ kind: string, role?: string, text?: string, [k:string]: unknown }}
   *   kind is one of: user_message, agent_text, tool_call, tool_result,
   *   peer_message_out, peer_message_in, room_message, system_note, result_text_update.
   */
  append(ownerKind, ownerId, entry) {
    const record = {
      id: newId('tx'),
      owner_kind: ownerKind,
      owner_id: ownerId,
      at: this.clock.iso(),
      ...entry,
    };
    this.#log(ownerKind, ownerId).append(record);
    return record;
  }

  tail(ownerKind, ownerId, n = 20) {
    const all = this.all(ownerKind, ownerId);
    return n == null ? all : all.slice(-n);
  }

  all(ownerKind, ownerId) {
    return structuredClone(this.#entries(ownerKind, ownerId));
  }

  page(ownerKind, ownerId, { limit = 150, before = null } = {}) {
    const entries = this.#entries(ownerKind, ownerId);
    let end = before == null ? entries.length : entries.findIndex(entry => entry.id === before);
    if (end < 0) throw new HostError('invalid_cursor', 'Conversation cursor is no longer available; reload the conversation.');
    const start = Math.max(0, end - limit);
    return { entries: structuredClone(entries.slice(start, end)), has_more: start > 0,
      before: entries[start]?.id ?? null };
  }

  #entries(ownerKind, ownerId) {
    const key = `${ownerKind}:${ownerId}`;
    const previous = this.cache.get(key);
    const update = this.#log(ownerKind, ownerId).readIncremental(previous?.cursor);
    if (!update.reset && !update.records.length) return previous.entries;
    const records = update.reset ? update.records : [...previous.records, ...update.records];
    // Correct published text without rewriting its original record or moving
    // its bubble. Updates can only target the same committed result.
    const updates = new Map(records.filter((entry) => entry.kind === 'result_text_update').map((entry) => [entry.target_id, entry]));
    const entries = records.filter((entry) => entry.kind !== 'result_text_update').map((entry) => {
      const update = updates.get(entry.id);
      return entry.kind === 'agent_text' && entry.result_id && update?.result_id === entry.result_id && typeof update.text === 'string'
        ? { ...entry, text: update.text } : entry;
    });
    // Recovered publications are appended durably, then shown next to their
    // original receipt. Other entries retain their exact conversation order.
    const ids = new Set(entries.map((entry) => entry.id));
    const after = new Map();
    for (const entry of entries) {
      if (entry.kind === 'agent_text' && entry.result_id && entry.after_id && ids.has(entry.after_id)) {
        if (!after.has(entry.after_id)) after.set(entry.after_id, []);
        after.get(entry.after_id).push(entry);
      }
    }
    const moved = new Set([...after.values()].flat().map((entry) => entry.id));
    const ordered = entries.filter((entry) => !moved.has(entry.id)).flatMap((entry) => [entry, ...(after.get(entry.id) ?? [])]);
    if (this.cache.size >= 16 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { records, entries: ordered, cursor: update.cursor });
    return ordered;
  }
}
