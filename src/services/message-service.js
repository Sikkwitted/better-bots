import path from 'node:path';
import { JsonlLog, JsonDoc } from '../core/store.js';
import { newId, clampText, HostError } from '../core/util.js';

// The mailroom.
//
// The single decision that shapes the whole architecture: the reply is NOT the
// return value of send(). send() returns a delivery acknowledgement; the answer,
// if any, arrives later as a new message.

export const MAX_TEXT_CHARS = 8000;
export const MAX_ATTACHMENTS = 4;
export const MAX_CHAIN_DEPTH = 6;
export const PRIORITY_REASONS = ['stop', 'supersede', 'safety', 'time_critical'];
export const PRIORITY_RATE_LIMIT = { max: 3, window_ms: 60_000 };

export class MessageService {
  constructor({ dir, clock, audit, registry, transcripts, rooms = null }) {
    this.dir = dir;
    this.clock = clock;
    this.audit = audit;
    this.registry = registry;
    this.transcripts = transcripts;
    this.rooms = rooms; // set later by the host; rooms are addressable targets
    this.outbox = new JsonlLog(path.join(dir, 'messages', 'outbox.jsonl'));
    this.index = new JsonDoc(path.join(dir, 'messages', 'index.json'), {
      envelopes: {},        // message_id -> envelope (durable, survives restart)
      inbox: {},            // agent_id -> [message_id] in delivery order
      seen: {},             // message_id -> true, for deduplication
      priority_sends: {},   // sender_id -> [timestamps]
    });
  }

  attachRooms(rooms) {
    this.rooms = rooms;
  }

  #isRoom(targetId) {
    return Boolean(this.rooms?.has?.(targetId));
  }

  /**
   * Fire-and-forget peer send.
   * Returns an acknowledgement that does not pretend to be a reply.
   */
  send({
    sender_id,
    target_id,
    text,
    attachments = [],
    priority = false,
    priority_reason = null,
    chain_depth = 0,
    is_acknowledgement = false,
    message_id = null,
    automation_id = null,
    parent_run_id = null,
    coordination_id = null,
    wake_room = false,
  }) {
    if (this.isParentCancelled?.(parent_run_id)) throw new HostError('run_cancelled', 'sending run has been cancelled');
    if (target_id === sender_id) {
      throw new HostError('self_send', 'an agent may not message itself');
    }
    // A room sends only one thing: its outcome, back to the agent that asked.
    const fromRoom = this.#isRoom(sender_id);
    if (!fromRoom && !this.registry.has(sender_id)) {
      throw new HostError('unknown_sender', `no agent with id ${sender_id}`);
    }
    const toRoom = this.#isRoom(target_id);
    if (fromRoom && toRoom) throw new HostError('unknown_target', 'a room replies to an agent, not to another room');
    if (!toRoom && !this.registry.has(target_id)) {
      throw new HostError('unknown_target', `no agent or room with id ${target_id}`);
    }

    // Automatic acknowledgement loops are prevented.
    if (is_acknowledgement) {
      this.audit.record('message.ack_loop_blocked', { sender_id, target_id });
      throw new HostError('ack_loop_blocked', 'bare acknowledgement messages are not delivered');
    }
    if (chain_depth > MAX_CHAIN_DEPTH) {
      this.audit.record('message.chain_depth_exceeded', { sender_id, target_id, chain_depth });
      throw new HostError('chain_depth_exceeded', `peer chain exceeded depth ${MAX_CHAIN_DEPTH}`);
    }

    // Bounded message size. The host resolves image IDs before delivery.
    const clamped = clampText(text, MAX_TEXT_CHARS);
    const images = attachments.slice(0, MAX_ATTACHMENTS);
    let capability_notes = [];
    if (clamped.truncated) capability_notes.push(`text truncated to ${MAX_TEXT_CHARS} characters`);
    if (attachments.length > MAX_ATTACHMENTS) {
      capability_notes.push(`attachments truncated to ${MAX_ATTACHMENTS}`);
    }

    // Priority is one-to-one only, needs a declared reason, and is rate limited.
    let effectivePriority = Boolean(priority);
    if (effectivePriority && toRoom) {
      effectivePriority = false;
      capability_notes.push('priority is one-to-one only and was ignored for a group post');
      this.audit.record('message.priority_ignored_for_group', { sender_id, target_id });
    }
    if (effectivePriority) {
      if (!PRIORITY_REASONS.includes(priority_reason)) {
        throw new HostError(
          'priority_reason_required',
          `priority requires one of: ${PRIORITY_REASONS.join(', ')}`,
        );
      }
      if (!this.#allowPriority(sender_id)) {
        effectivePriority = false;
        capability_notes.push('priority rate limit reached; delivered as a normal message');
        this.audit.record('message.priority_rate_limited', { sender_id, target_id });
      }
    }

    const envelope = {
      id: message_id ?? newId('msg'),
      sender_id,
      ...(fromRoom ? { sender_kind: 'room' } : {}),
      target_id,
      target_kind: toRoom ? 'room' : 'agent',
      text: clamped.text,
      attachments: images,
      priority: effectivePriority,
      priority_reason: effectivePriority ? priority_reason : null,
      chain_depth,
      automation_id, parent_run_id, coordination_id,
      created_at: this.clock.iso(),
      status: 'queued',
      ...(toRoom ? { room_wake_pending: Boolean(wake_room) } : {}),
      capability_notes,
    };

    let duplicate = false;
    this.index.update((state) => {
      if (state.seen[envelope.id]) {   // message IDs deduplicate
        duplicate = true;
        return state;
      }
      state.seen[envelope.id] = true;
      state.envelopes[envelope.id] = envelope;
      if (!toRoom) {
        const queue = (state.inbox[target_id] ??= []);
        if (envelope.priority) queue.unshift(envelope.id);
        else queue.push(envelope.id);
      }
      return state;
    });

    if (duplicate) {
      this.audit.record('message.duplicate_suppressed', { message_id: envelope.id });
      const stored = this.get(envelope.id);
      this.repairOutbound(stored);
      return this.#ack(stored, { duplicate: true });
    }

    this.repairOutbound(envelope);

    return this.#ack(envelope, { duplicate: false });
  }

  /** Repair from authoritative envelopes, never by re-sending or waking. */
  repairOutbound(envelope, recovered = null) {
    if (!(recovered ? recovered.outbox.has(envelope.id) : this.outbox.readAll().some((e) => e.id === envelope.id))) { this.outbox.append(envelope); recovered?.outbox.add(envelope.id); }
    // A room's reply has no sender desk chat to record it in; its discussion is already in the room.
    if (envelope.sender_kind !== 'room' && !(recovered ? recovered.entries('agent', envelope.sender_id).has(envelope.id) : this.transcripts.all('agent', envelope.sender_id).some((e) => e.kind === 'peer_message_out' && e.message_id === envelope.id))) {
      this.transcripts.append('agent', envelope.sender_id, {
        kind: 'peer_message_out', message_id: envelope.id, target_id: envelope.target_id,
        target_kind: envelope.target_kind, text: envelope.text, attachments: envelope.attachments,
        priority: envelope.priority, priority_reason: envelope.priority_reason,
      });
    }
    if (envelope.target_kind === 'room' && !(recovered ? recovered.entries('room', envelope.target_id).has(envelope.id) : this.transcripts.all('room', envelope.target_id).some((e) => e.message_id === envelope.id))) {
      this.transcripts.append('room', envelope.target_id, {
        kind: 'room_message', message_id: envelope.id, sender_id: envelope.sender_id,
        text: envelope.text, attachments: envelope.attachments,
      });
    }
    if (!(recovered ? recovered.audit.has(envelope.id) : this.audit.where((e) => e.type === 'message.sent' && e.message_id === envelope.id).length)) {
      this.audit.record('message.sent', { message_id: envelope.id, sender_id: envelope.sender_id,
        target_id: envelope.target_id, target_kind: envelope.target_kind,
        priority: envelope.priority, priority_reason: envelope.priority_reason });
    }
  }

  recoverOutbound() {
    const transcripts = new Map();
    const recovered = {
      outbox: new Set(this.outbox.readAll().map(e => e.id)),
      audit: new Set(this.audit.where(e => e.type === 'message.sent').map(e => e.message_id)),
      entries: (scope, id) => {
        const key = `${scope}:${id}`;
        if (!transcripts.has(key)) transcripts.set(key, new Set(this.transcripts.all(scope, id)
          .filter(e => scope === 'room' || e.kind === 'peer_message_out').map(e => e.message_id)));
        return transcripts.get(key);
      },
    };
    for (const envelope of this.allEnvelopes()) {
      this.repairOutbound(envelope, recovered);
      recovered.entries('agent', envelope.sender_id).add(envelope.id);
      if (envelope.target_kind === 'room') recovered.entries('room', envelope.target_id).add(envelope.id);
      recovered.audit.add(envelope.id);
    }
  }

  #ack(envelope, { duplicate }) {
    return {
      acknowledged: true,
      duplicate,
      message_id: envelope.id,
      target_id: envelope.target_id,
      priority: envelope.priority,
      capability_notes: envelope.capability_notes,
      note: 'Delivery acknowledgement, not a reply. Any answer arrives later as a new message. Do not wait or poll for it in this turn.',
    };
  }

  #allowPriority(senderId) {
    let allowed = true;
    const now = this.clock.now();
    this.index.update((state) => {
      const stamps = (state.priority_sends[senderId] ??= []).filter(
        (t) => now - t < PRIORITY_RATE_LIMIT.window_ms,
      );
      if (stamps.length >= PRIORITY_RATE_LIMIT.max) {
        allowed = false;
      } else {
        stamps.push(now);
      }
      state.priority_sends[senderId] = stamps;
      return state;
    });
    return allowed;
  }

  /** Message IDs still queued for an agent. Survives restart: it is read from disk. */
  pending(agentId) {
    const state = this.index.read();
    return (state.inbox[agentId] ?? []).map((id) => state.envelopes[id]).filter((m) => this.isLive(m));
  }

  agentsWithPending() {
    const state = this.index.read();
    return Object.entries(state.inbox)
      .filter(([, ids]) => ids.length > 0)
      .map(([agentId]) => agentId);
  }

  pendingRooms() {
    return this.allEnvelopes().filter(m => m.target_kind === 'room' && m.room_wake_pending && this.isLive(m));
  }

  requestRoomWake(messageId) {
    this.index.update(state => {
      const message = state.envelopes[messageId];
      if (!message || message.target_kind !== 'room' || !this.isLive(message)) throw new HostError('message_not_available', 'This room message is no longer available.');
      if (!message.room_epoch) message.room_wake_pending = true;
      return state;
    });
  }

  bindRoom(messageId, epoch) {
    this.index.update(state => {
      const message = state.envelopes[messageId];
      if (message) Object.assign(message, { room_wake_pending: false, room_epoch: epoch, status: 'delivered', delivered_at: this.clock.iso() });
      return state;
    });
  }

  cancelRoom(roomId) {
    this.index.update(state => {
      for (const message of Object.values(state.envelopes)) {
        if (message.target_kind === 'room' && message.target_id === roomId && message.room_wake_pending) {
          Object.assign(message, { room_wake_pending: false, status: 'cancelled', cancelled_at: this.clock.iso() });
        }
      }
      return state;
    });
  }

  /** The host first binds these IDs to a durable run, then commits transcripts,
   * then acknowledges delivery. Repeating this commit repairs a partial write. */
  drainInbox(agentId, runId, messageIds) {
    if (!runId || !Array.isArray(messageIds)) throw new HostError('processing_state_required', 'delivery requires a durable run binding');
    const state = this.index.read();
    const delivered = messageIds.map((id) => state.envelopes[id]).filter((m) => this.isLive(m));
    const existing = new Set(this.transcripts.all('agent', agentId).filter((e) => e.kind === 'peer_message_in').map((e) => e.message_id));
    for (const envelope of delivered) {
      if (envelope.target_id !== agentId || (envelope.processing_run_id && envelope.processing_run_id !== runId)) {
        throw new HostError('message_owner_mismatch', 'message is bound to another recipient or run');
      }
      if (!existing.has(envelope.id)) this.transcripts.append('agent', agentId, {
        kind: 'peer_message_in', message_id: envelope.id, run_id: runId,
        sender_id: envelope.sender_id, text: envelope.text, attachments: envelope.attachments,
        priority: envelope.priority, priority_reason: envelope.priority_reason,
      });
    }
    this.index.update((current) => {
      for (const envelope of delivered) {
        Object.assign(current.envelopes[envelope.id], {
          status: 'delivered', processing_run_id: runId,
          delivered_at: current.envelopes[envelope.id].delivered_at ?? this.clock.iso(),
        });
      }
      const ids = new Set(messageIds);
      current.inbox[agentId] = (current.inbox[agentId] ?? []).filter((id) => !ids.has(id));
      return current;
    });
    for (const envelope of delivered) {
      if (envelope.status !== 'delivered') this.audit.record('message.delivered', {
        message_id: envelope.id, sender_id: envelope.sender_id, target_id: agentId, run_id: runId,
      });
    }
    return delivered;
  }

  #senderExists(message) {
    return message.sender_kind === 'room' ? Boolean(this.rooms?.has(message.sender_id)) : this.registry.has(message.sender_id);
  }

  isLive(message) {
    return Boolean(message && message.status !== 'cancelled'
      && this.#senderExists(message)
      && (message.target_kind === 'room' ? this.rooms?.has(message.target_id) : this.registry.has(message.target_id))
      && !this.isAutomationCancelled?.(message.automation_id)
      && !this.isParentCancelled?.(message.parent_run_id));
  }

  requeueOwned(runId, messageIds) {
    this.index.update(state => {
      for (const id of messageIds) {
        const message = state.envelopes[id];
        if (!this.isLive(message) || (message.processing_run_id && message.processing_run_id !== runId)) continue;
        message.status = 'queued';
        delete message.processing_run_id;
        const inbox = (state.inbox[message.target_id] ??= []);
        if (!inbox.includes(id)) {
          if (message.priority) inbox.unshift(id);
          else inbox.push(id);
        }
      }
      return state;
    });
  }

  retireCancelled() {
    this.index.update((state) => {
      for (const m of Object.values(state.envelopes)) {
        if (m.status !== 'queued') continue;
        if (!this.#senderExists(m) || (m.target_kind === 'agent' && !this.registry.has(m.target_id))
            || this.isParentCancelled?.(m.parent_run_id) || this.isAutomationCancelled?.(m.automation_id)) {
          m.status = 'cancelled';
          m.cancelled_at = this.clock.iso();
          state.inbox[m.target_id] = (state.inbox[m.target_id] ?? []).filter((id) => id !== m.id);
        }
      }
      return state;
    });
  }

  cancelAutomation(id) {
    this.index.update((state) => {
      for (const m of Object.values(state.envelopes)) {
        if (m.automation_id === id && m.status === 'queued') {
          m.status = 'cancelled';
          m.cancelled_at = this.clock.iso();
          state.inbox[m.target_id] = (state.inbox[m.target_id] ?? []).filter((mid) => mid !== m.id);
        }
      }
      return state;
    });
  }

  get(messageId) {
    return this.index.read().envelopes[messageId] ?? null;
  }

  allEnvelopes() {
    return Object.values(this.index.read().envelopes);
  }
}
