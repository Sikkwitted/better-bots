import path from 'node:path';
import { JsonDoc } from '../core/store.js';
import { newId, HostError } from '../core/util.js';

// Rooms are bounded meetings between bots.
// Every bound below is a hard stop, not a suggestion. Limits are not only cost
// control: they force the room to decide whether it has anything new to add.

export const ROOM_MEMORY = ['project', 'members', 'room', 'none'];

export const ROOM_LIMITS = {
  // Twelve holds a whole desk. The meeting itself stays bounded by rounds and
  // messages below, so a big room costs no more per run than a small one — it
  // decides who speaks, not how much is said.
  MAX_MEMBERS: 12,
  MAX_ROUNDS: 3,
  MAX_MESSAGES: 10,        // member messages in one orchestration run
  MAX_PER_MEMBER_TURN: 2,
  HISTORY_MESSAGES: 24,    // recent room messages supplied as history
};

const PASS_TOKEN = '(pass)';

export class RoomOrchestrator {
  constructor({ dir, clock, audit, registry, transcripts, limits = ROOM_LIMITS }) {
    this.clock = clock;
    this.audit = audit;
    this.registry = registry;
    this.transcripts = transcripts;
    this.limits = limits;
    this.onInvalidate = () => {};
    this.doc = new JsonDoc(path.join(dir, 'rooms', 'rooms.json'), { rooms: {} });
  }

  /**
   * `memory` says where the meeting's outcome is remembered: `project` (shared,
   * every agent may recall it), `members` (each member's own memory only — a
   * later verifier never sees the deliberation), `room` (the room keeps its own
   * history; no member's desk memory gets it), or `none`.
   */
  create({ member_ids, purpose, id = null, memory = 'members' }) {
    if (!ROOM_MEMORY.includes(memory)) throw new HostError('bad_room_memory', `memory must be one of ${ROOM_MEMORY.join(', ')}`);
    if (member_ids.length > this.limits.MAX_MEMBERS) {
      throw new HostError(
        'room_too_large',
        `a room holds at most ${this.limits.MAX_MEMBERS} members; got ${member_ids.length}`,
      );
    }
    for (const memberId of member_ids) this.registry.get(memberId);
    const room = {
      id: id ?? newId('room'),
      member_ids: [...member_ids],
      purpose,
      memory,
      epoch: 1,
      created_at: this.clock.iso(),
    };
    this.doc.update((state) => {
      state.rooms[room.id] = room;
      return state;
    });
    this.audit.record('room.created', { room_id: room.id, member_ids, purpose });
    return room;
  }

  // Own properties only: an id like "constructor" must not find Object itself.
  has(roomId) {
    const { rooms } = this.doc.read();
    return Object.hasOwn(rooms, roomId) && Boolean(rooms[roomId]);
  }

  get(roomId) {
    const { rooms } = this.doc.read();
    const room = Object.hasOwn(rooms, roomId) ? rooms[roomId] : null;
    if (!room) throw new HostError('room_not_found', `unknown room ${roomId}`);
    return room;
  }

  list() {
    return Object.values(this.doc.read().rooms);
  }

  reconcileMembers() {
    const changed = [];
    this.doc.update((state) => {
      for (const room of Object.values(state.rooms)) {
        const members = room.member_ids.filter(id => this.registry.has(id));
        if (members.length === room.member_ids.length) continue;
        changed.push({ id: room.id, epoch: room.epoch });
        room.member_ids = members;
        room.epoch += 1;
        if (room.discussion) room.discussion.status = 'membership_changed';
      }
      return state;
    });
    for (const room of changed) {
      this.onInvalidate(room.id, room.epoch, 'membership_changed');
      this.audit.record('room.members_reconciled', { room_id: room.id });
    }
    return changed;
  }

  /** Rename, pin, or change where future room exchanges are remembered. */
  update(roomId, patch) {
    let updated;
    this.doc.update((state) => {
      const room = Object.hasOwn(state.rooms, roomId) ? state.rooms[roomId] : null;
      if (!room) throw new HostError('room_not_found', `unknown room ${roomId}`);
      if (patch.memory !== undefined) {
        if (!ROOM_MEMORY.includes(patch.memory)) throw new HostError('bad_room_memory', `memory must be one of ${ROOM_MEMORY.join(', ')}`);
        if (patch.memory !== (room.memory ?? 'project') && room.discussion?.status === 'active') {
          throw new HostError('room_active', 'wait for the current room discussion to finish before changing memory');
        }
        if (patch.memory !== (room.memory ?? 'project')) room.context_from_epoch = room.epoch + 1;
        room.memory = patch.memory;
      }
      if (patch.purpose !== undefined) {
        const purpose = String(patch.purpose).trim();
        if (!purpose) throw new HostError('invalid_name', 'a room needs a name');
        room.purpose = purpose;
      }
      if (patch.pinned_at !== undefined) room.pinned_at = patch.pinned_at;
      updated = room;
      return state;
    });
    this.audit.record('room.updated', { room_id: roomId, fields: Object.keys(patch) });
    return updated;
  }

  /** Explicit deletion by the person; never silent. The transcript file stays on disk as a record. */
  delete(roomId, { confirm = false, actor = 'user' } = {}) {
    if (!confirm) throw new HostError('confirm_required', 'deleting a group needs explicit confirmation');
    let removed = null;
    this.doc.update((state) => {
      removed = Object.hasOwn(state.rooms, roomId) ? state.rooms[roomId] : null;
      if (!removed) throw new HostError('room_not_found', `unknown room ${roomId}`);
      delete state.rooms[roomId];
      return state;
    });
    this.onInvalidate(roomId, removed.epoch, 'deleted');
    this.audit.record('room.deleted', { room_id: roomId, purpose: removed.purpose, members: removed.member_ids.length, actor });
    return removed;
  }

  /** Bump the epoch so in-flight work for the old request is recognised as stale. */
  supersede(roomId, reason = 'superseded') {
    let epoch;
    this.doc.update((state) => {
      const room = Object.hasOwn(state.rooms, roomId) ? state.rooms[roomId] : null;
      if (!room) throw new HostError('room_not_found', `unknown room ${roomId}`);
      room.epoch += 1;
      if (room.discussion) room.discussion.status = 'superseded';
      epoch = room.epoch;
      return state;
    });
    this.onInvalidate(roomId, epoch - 1, reason);
    this.audit.record('room.superseded', { room_id: roomId, epoch, reason });
    return epoch;
  }

  history(roomId, n = this.limits.HISTORY_MESSAGES) {
    return this.transcripts
      .tail('room', roomId, n)
      .filter((entry) => entry.kind === 'room_message');
  }

  /** A mode change starts a new context boundary. No-memory rooms reset on every request. */
  contextHistory(room, epoch) {
    if (room.memory !== 'none' && room.context_from_epoch == null) return this.history(room.id);
    return this.history(room.id, null)
      .filter((entry) => entry.epoch >= (room.memory === 'none' ? epoch : room.context_from_epoch)
        || (room.discussion?.peer_message_id && entry.message_id === room.discussion.peer_message_id))
      .slice(-this.limits.HISTORY_MESSAGES);
  }

  isCurrent(roomId, epoch) {
    const room = this.doc.read().rooms[roomId];
    return Boolean(room && room.epoch === epoch && room.discussion?.status === 'active');
  }

  #begin(roomId, request, peer_message_id = null) {
    const previous = this.get(roomId);
    this.doc.update((state) => {
      const room = state.rooms[roomId];
      room.epoch += 1;
      room.discussion = { epoch: room.epoch, request, peer_message_id, status: 'active', rounds: {}, turns: {}, total_messages: 0 };
      return state;
    });
    this.onInvalidate(roomId, previous.epoch, 'new_request');
    return this.get(roomId);
  }

  // Turn receipts reserve the message budget before transcript publication. A
  // restart repairs missing entries by stable IDs, never regenerates a reply.
  #publish(roomId, epoch, key, turn) {
    const existing = new Set(this.transcripts.all('room', roomId).map((e) => e.id));
    for (const [index, text] of turn.replies.entries()) {
      if (!this.isCurrent(roomId, epoch)) return;
      const id = `room_${roomId}_${epoch}_${key}_${index}`;
      if (!existing.has(id)) this.transcripts.append('room', roomId, {
        id, kind: 'room_message', sender_id: turn.agent_id, text, round: turn.round,
        epoch, run_id: turn.run_id,
      });
    }
    if (turn.posted && !this.transcripts.all('agent', turn.agent_id).some((e) => e.room_turn_id === `${roomId}:${epoch}:${key}`)) {
      this.transcripts.append('agent', turn.agent_id, {
        kind: 'system_note', text: `Spoke in room ${roomId} (round ${turn.round}).`,
        room_id: roomId, run_id: turn.run_id, room_turn_id: `${roomId}:${epoch}:${key}`,
      });
    }
  }

  /** Resume uses saved round plans and receipts, so bounds survive a restart. */
  async runBounded(roomId, { request, memberTurn, isSuperseded = () => false, resume = false, peer_message_id = null }) {
    this.reconcileMembers();
    const room = resume ? this.get(roomId) : this.#begin(roomId, request, peer_message_id);
    const startEpoch = room.epoch;
    request = room.discussion.request;
    const current = () => this.isCurrent(roomId, startEpoch);
    const invalid = () => !current() ? 'stale_epoch' : isSuperseded() ? 'superseded' : null;
    const headerId = `room_${roomId}_${startEpoch}_request`;
    if (current() && !this.transcripts.all('room', roomId).some((e) => e.id === headerId)) {
      this.transcripts.append('room', roomId, {
        id: headerId, kind: 'room_message', sender_id: 'host',
        text: `Room purpose: ${room.purpose}\nRequest: ${request}`, system: true, epoch: startEpoch,
      });
    }

    let stop_reason = room.member_ids.length ? 'rounds_complete' : 'no_members';
    const rounds = [];
    let totalMessages = 0;
    // A lone member (the fresh-context verifier) has nobody to answer: one round.
    const maxRounds = room.member_ids.length === 1 ? 1 : this.limits.MAX_ROUNDS;
    outer: for (let round = 0; round < maxRounds && room.member_ids.length; round += 1) {
      const beforeRound = invalid();
      if (beforeRound) { stop_reason = beforeRound; break; }
      let speakers = this.get(roomId).discussion.rounds[round];
      if (!speakers) {
        speakers = rotateStart(this.#resolveResponders(room, this.contextHistory(room, startEpoch)), round);
        this.doc.update((state) => { state.rooms[roomId].discussion.rounds[round] = speakers; return state; });
      }
      let messagesThisRound = 0;
      const turns = [];
      for (const agentId of speakers) {
        const invalidReason = invalid();
        if (invalidReason) { stop_reason = invalidReason; break outer; }
        const key = `${round}:${agentId}`;
        let turn = this.get(roomId).discussion.turns[key];
        if (!turn) {
          if (this.get(roomId).discussion.total_messages >= this.limits.MAX_MESSAGES) { stop_reason = 'message_cap'; break outer; }
          const run = await memberTurn(agentId, {
            room, round, request, epoch: startEpoch, key,
            recent_history: this.contextHistory(room, startEpoch),
            participants: room.member_ids.filter((m) => m !== agentId).map((m) => ({ id: m, name: this.registry.get(m).profile.name })),
          });
          // Mandatory post-await check: neither stale candidates nor failed runs publish.
          const after = invalid();
          if (after) { stop_reason = after; break outer; }
          if (run.blocked_reason === 'desk_disabled') {
            stop_reason = 'member_paused';
            this.transcripts.append('room', roomId, { kind: 'room_message', sender_id: 'host', system: true, epoch: startEpoch,
              text: `${this.registry.get(agentId).profile.name} cannot join because their desk is paused. Enable the desk in Workflows, then send the room a new message to continue.` });
            break outer;
          }
          if (run.status !== 'completed') { stop_reason = run.status === 'recovery_required' ? 'recovery_required' : 'member_interrupted'; break outer; }
          const useful = (run.room_replies ?? []).map((r) => String(r ?? '').trim()).filter((r) => r && r.toLowerCase() !== PASS_TOKEN);
          this.doc.update((state) => {
            const discussion = state.rooms[roomId].discussion;
            const replies = useful.slice(0, Math.min(this.limits.MAX_PER_MEMBER_TURN, this.limits.MAX_MESSAGES - discussion.total_messages));
            turn = { agent_id: agentId, run_id: run.id, round, replies, posted: replies.length, passed: replies.length === 0 };
            discussion.turns[key] = turn;
            discussion.total_messages += replies.length;
            return state;
          });
          if (turn.passed) this.audit.record('room.member_passed', { room_id: roomId, agent_id: agentId, round });
        }
        if (!current()) { stop_reason = 'stale_epoch'; break outer; }
        this.#publish(roomId, startEpoch, key, turn);
        totalMessages += turn.posted;
        messagesThisRound += turn.posted;
        turns.push({ agent_id: agentId, passed: turn.passed, posted: turn.posted });
      }
      rounds.push({ round, speakers, messages: messagesThisRound, turns });
      if (messagesThisRound === 0) { stop_reason = 'no_new_messages'; break; }
    }
    if (current()) {
      if (['rounds_complete', 'no_new_messages', 'message_cap', 'no_members'].includes(stop_reason)) {
        this.onBeforeComplete?.(roomId, { epoch: startEpoch, stop_reason, total_messages: totalMessages,
          transcript: this.history(roomId, this.limits.HISTORY_MESSAGES) });
      }
      this.doc.update((state) => {
        const discussion = state.rooms[roomId].discussion;
        discussion.status = ['rounds_complete', 'no_new_messages', 'message_cap', 'no_members'].includes(stop_reason) ? 'completed' : stop_reason;
        discussion.stop_reason = stop_reason;
        return state;
      });
      this.onInvalidate(roomId, startEpoch, stop_reason);
    }
    const result = {
      room_id: roomId, epoch: startEpoch, stop_reason, total_messages: totalMessages, rounds,
      transcript: this.history(roomId, this.limits.HISTORY_MESSAGES), limits: this.limits,
    };
    this.audit.record('room.finished', { room_id: roomId, epoch: startEpoch, stop_reason, total_messages: totalMessages, rounds: rounds.length });
    return result;
  }

  /** Mentions narrow the responders; otherwise everyone may speak. */
  #resolveResponders(room, recent) {
    const lastNonSystem = [...recent].reverse().find((m) => !m.system);
    const text = lastNonSystem?.text ?? recent.map((m) => m.text).join(' ');
    const mentioned = new Set();
    for (const memberId of room.member_ids) {
      const name = this.registry.get(memberId).profile.name;
      const byName = name && new RegExp(`@${escapeRegExp(name)}\\b`, 'i').test(text);
      const byId = text.includes(`@${memberId}`);
      if (byName || byId) mentioned.add(memberId);
    }
    if (mentioned.size === 0) return [...room.member_ids];
    this.audit.record('room.mentions_resolved', {
      room_id: room.id, responders: [...mentioned],
    });
    return room.member_ids.filter((m) => mentioned.has(m));
  }
}

/** Rotates the starting speaker each round so no member always goes first. */
export function rotateStart(responders, round) {
  if (responders.length === 0) return [];
  const offset = round % responders.length;
  return [...responders.slice(offset), ...responders.slice(0, offset)];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
