import path from 'node:path';
import { JsonDoc, JsonlLog } from '../core/store.js';
import { newId, HostError } from '../core/util.js';

// Run lanes, priority and interruption.
//
// A user's active turn outranks all internal work.
// Any run can be cancelled without leaving hidden work that later
//              resumes blindly, so an interrupt records a resume policy.

export const LANES = ['user', 'agent', 'automation', 'background'];
export const LANE_RANK = { user: 0, agent: 1, automation: 2, background: 3 };

// Follow continuation ownership in the durable ledger, never the model prompt.
function cancellationFor(state, run) {
  const seen = new Set();
  while (run && !seen.has(run.id)) {
    seen.add(run.id);
    if (state.cancelled_runs?.[run.id]) return state.cancelled_runs[run.id];
    run = state.runs?.[run.payload?.parent_run_id];
  }
  return null;
}

// Only a host checkpoint before model execution proves the payload has no effects.
function interruptionPolicy(run, reason) {
  if (run.uncertain_effect || run.checkpoint?.phase === 'tool_pending') return 'reconcile';
  if (run.payload.kind !== 'room_turn' && reason === 'time_critical'
      && ['prepared', 'inbox_bound'].includes(run.checkpoint?.phase)
      && !(run.checkpoints ?? []).some((c) => !['prepared', 'inbox_bound'].includes(c.phase))) return 'restart';
  return 'abandon';
}

class AbortSignalish {
  constructor() {
    this.controller = new AbortController();
  }
  abort(reason) {
    this.controller.abort(reason);
  }
  get native() { return this.controller.signal; }
  get aborted() { return this.native.aborted; }
  get reason() { return this.native.reason; }
  throwIfAborted() {
    if (this.aborted) throw new HostError('run_interrupted', `run interrupted: ${this.reason}`);
  }
}

export class RunScheduler {
  constructor({ dir, clock, audit, runner, canStart = () => true }) {
    this.canStart = canStart;
    this.clock = clock;
    this.audit = audit;
    this.runner = runner; // async (run, signal) => result
    this.queues = new JsonDoc(path.join(dir, 'runs', 'queues.json'), { pending: {}, runs: {} });
    this.history = new JsonlLog(path.join(dir, 'runs', 'runs.jsonl'), { validate: (r) => typeof r.id === 'string' && typeof r.agent_id === 'string' && r.payload && typeof r.payload === 'object' && typeof r.status === 'string' });
    this.waiters = new Map();
    this.dispatchWaiters = new Set();
    this.thoughtListeners = new Set();
    this.active = new Map();   // agent_id -> { run, signal }
    this.inFlight = new Map(); // agent_id -> Promise
  }

  /** Queued runs live on disk, so a restart does not lose scheduled work. */
  #pendingFor(agentId) {
    return this.queues.read().pending[agentId] ?? [];
  }

  enqueue({ agent_id, lane, payload = {}, front = false, dedupe_key = null, run_id = null }) {
    if (this.isAutomationCancelled(payload.automation_id)) throw new HostError('automation_cancelled', 'automation has been cancelled');
    if (!LANES.includes(lane)) throw new HostError('bad_lane', `unknown lane ${lane}`);
    const run = {
      id: run_id ?? newId('run'),
      agent_id,
      lane,
      status: 'queued',
      payload,
      dedupe_key,
      priority: Boolean(front),
      ...(run_id ? { admission_payload: JSON.stringify(payload) } : {}),
      created_at: this.clock.iso(),
      started_at: null,
      finished_at: null,
      interrupt_reason: null,
      resume_policy: null,
    };

    let skipped = false;
    let existing = null;
    this.queues.update((state) => {
      if (cancellationFor(state, run)) throw new HostError('run_cancelled', 'this run or its continuation chain has been cancelled');
      if (state.runs?.[run.id]) {
        existing = state.runs[run.id];
        if (existing.agent_id !== agent_id || existing.lane !== lane || (existing.admission_payload ?? JSON.stringify(existing.payload)) !== JSON.stringify(payload)) throw new HostError('run_id_conflict', 'durable run ID already belongs to different work');
        return state;
      }
      const queue = (state.pending[agent_id] ??= []);
      const coalesced = dedupe_key && queue.find((r) => r.dedupe_key === dedupe_key && !r.payload.message_ids);
      if (coalesced) {
        if (front) {
          coalesced.priority = true;
          state.runs[coalesced.id].priority = true;
        }
        // An unbound wake will drain the inbox. A recovered, bound wake
        // owns only its original batch and cannot absorb newly arrived mail.
        skipped = true;
        return state;
      }
      (state.runs ??= {})[run.id] = run;
      if (front) queue.unshift(run);
      else queue.push(run);
      return state;
    });

    if (existing) return existing;
    if (skipped) {
      this.audit.record('run.wake_coalesced', { agent_id, lane, dedupe_key });
      return null;
    }
    this.history.append({ ...run, event: 'queued' });
    this.audit.record('run.queued', { run_id: run.id, agent_id, lane });
    for (const wake of this.dispatchWaiters) wake();
    return run;
  }

  /**
   * Priority peers may supersede non-user work. The active lane is checked
   * first; a run in the `user` lane is never interrupted.
   */
  interrupt(agentId, { reason, source = 'peer', message_id = null }) {
    const entry = this.active.get(agentId);
    if (!entry) {
      this.audit.record('run.interrupt_noop', { agent_id: agentId, reason, note: 'no active run' });
      return { interrupted: false, why: 'no_active_run' };
    }
    if (entry.run.lane === 'user') {
      // The safe rule: internal work must not silently outrank the person speaking.
      this.audit.record('run.interrupt_declined_user_lane', {
        agent_id: agentId, run_id: entry.run.id, reason, source, message_id,
      });
      return { interrupted: false, why: 'user_lane_protected' };
    }

    const resume_policy = interruptionPolicy(entry.run, reason);
    entry.run.status = 'interrupted';
    entry.run.interrupt_reason = reason;
    entry.run.interrupt_source = source;
    entry.run.resume_policy = resume_policy;
    entry.run.partial_output_safe = resume_policy === 'restart';
    entry.signal.abort(reason);

    this.save(entry.run);
    this.history.append({ ...entry.run, event: 'interrupted' });
    this.audit.record('run.interrupted', {
      run_id: entry.run.id, agent_id: agentId, lane: entry.run.lane,
      reason, source, message_id, resume_policy,
    });
    return { interrupted: true, run_id: entry.run.id, resume_policy };
  }

  isAutomationCancelled(id) {
    return Boolean(id && this.queues.read().cancelled_automations?.[id]);
  }

  isRunCancelled(run) {
    const state = this.queues.read();
    if (cancellationFor(state, run)) return true;
    // A retired origin fences its descendants directly: pending mail and
    // queued runs stay fenced even if the ancestry ledger has shed the
    // intermediate runs.
    return Boolean(run.payload?.parent_run_id && state.cancelled_runs?.[run.payload.parent_run_id]);
  }

  /** The person may stop a user run. Peer interruption remains a separate gate. */
  cancelRun(runId, { actor = 'user' } = {}) {
    if (actor !== 'user') throw new HostError('user_only_decision', 'only the user may cancel a run');
    let rootId;
    this.queues.update((state) => {
      let run = state.runs?.[runId];
      if (!run) throw new HostError('run_not_found', `unknown run ${runId}`);
      const seen = new Set();
      while (run.payload.kind === 'continue' && state.runs[run.payload.parent_run_id] && !seen.has(run.id)) {
        seen.add(run.id); run = state.runs[run.payload.parent_run_id];
      }
      rootId = run.id;
      (state.cancelled_runs ??= {})[rootId] ??= { root_run_id: rootId, requested_run_id: runId, actor, at: this.clock.iso() };
      return state;
    });
    // The durable fence exists even if signalling or audit publication fails.
    const cancellationState = this.queues.read();
    // Abort live providers/tools before rewriting historical run records.
    // The fence above already prevents descendants from starting after a crash.
    for (const entry of this.active.values()) {
      if (cancellationFor(cancellationState, entry.run)?.root_run_id === rootId) entry.signal.abort('user_cancelled');
    }
    for (const stored of Object.values(cancellationState.runs ?? {})) {
      if (['completed', 'failed', 'cancelled'].includes(stored.status)
          || cancellationFor(cancellationState, stored)?.root_run_id !== rootId) continue;
      this.#cancelStoredRun(stored);
    }
    this.audit.record('run.cancellation_requested', { run_id: runId, root_run_id: rootId, actor });
    this.onCancellation?.();
    return this.runCancellation(runId);
  }

  cancelAgent(agentId, { actor = 'user' } = {}) {
    if (actor !== 'user') throw new HostError('user_only_decision', 'only the user may cancel an agent');
    const runs = this.durableRuns().filter(run => run.agent_id === agentId
      && !['completed', 'failed', 'cancelled'].includes(run.status));
    const activeId = this.active.get(agentId)?.run.id;
    runs.sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
    return { agent_id: agentId, cancellations: runs.map(run => this.cancelRun(run.id, { actor })) };
  }

  #cancelStoredRun(stored, reason = 'user_cancelled') {
    const entry = this.active.get(stored.agent_id);
    const run = entry?.run.id === stored.id ? entry.run : stored;
    run.cancellation_requested_at ??= this.clock.iso();
    run.interrupt_reason = reason;
    run.interrupt_source = 'user';
    run.resume_policy = 'abandon';
    run.status = entry?.run.id === run.id ? 'cancelling'
      : (run.checkpoint?.phase === 'tool_pending' || run.uncertain_effect || run.status === 'recovery_required' ? 'recovery_required' : 'cancelled');
    if (run.status !== 'cancelling') run.finished_at ??= this.clock.iso();
    this.save(run);
    if (entry?.run.id === run.id) entry.signal.abort(reason);
    else this.#settle(run);
    this.history.append({ ...run, event: 'cancellation_requested' });
  }

  /**
   * Deleting an agent fences even its completed origins: delegated work keeps
   * a live ancestry to a finished run, so a finished run must fence too. The
   * durable fence also blocks later mail admission; queued or running
   * descendants are cancelled. The origin's own completed record is preserved
   * as history, never rewritten.
   */
  fenceOrigin(originRunId, { actor = 'deletion' } = {}) {
    this.queues.update((state) => {
      (state.cancelled_runs ??= {})[originRunId] ??= {
        root_run_id: originRunId, requested_run_id: originRunId, actor, at: this.clock.iso(),
      };
      return state;
    });
    const children = new Map();
    for (const stored of this.durableRuns()) {
      const parent = stored.payload?.parent_run_id;
      if (!parent) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(stored);
    }
    let cancelled = 0;
    const walk = (id) => {
      for (const child of children.get(id) ?? []) {
        this.queues.update((state) => {
          (state.cancelled_runs ??= {})[child.id] ??= { root_run_id: originRunId, requested_run_id: child.id, actor, at: this.clock.iso() };
          return state;
        });
        if (!['completed', 'failed', 'cancelled'].includes(child.status)) {
          this.#cancelStoredRun(child);
          cancelled += 1;
        }
        walk(child.id);
      }
    };
    walk(originRunId);
    this.audit.record('run.cancellation_requested', {
      run_id: originRunId, root_run_id: originRunId, actor, origin_fence: true, descendants_cancelled: cancelled,
    });
    this.onCancellation?.();
    return cancelled;
  }

  runCancellation(runId) {
    const state = this.queues.read();
    const request = cancellationFor(state, state.runs?.[runId]);
    const runs = Object.values(state.runs ?? {}).filter((r) => request && cancellationFor(state, r)?.root_run_id === request.root_run_id);
    return { requested: Boolean(request), run_id: runId, root_run_id: request?.root_run_id,
      runs: runs.map((r) => ({ id: r.id, status: r.status })) };
  }

  /** Commit the tombstone before signalling anything. It is also the restart fence. */
  cancelAutomation(id) {
    this.queues.update((state) => {
      (state.cancelled_automations ??= {})[id] ??= { at: this.clock.iso() };
      return state;
    });
    for (const stored of this.durableRuns()) {
      if (stored.payload.automation_id !== id || ['completed', 'failed', 'cancelled'].includes(stored.status)) continue;
      const entry = this.active.get(stored.agent_id);
      const run = entry?.run.id === stored.id ? entry.run : stored;
      run.cancellation_requested_at ??= this.clock.iso();
      run.interrupt_reason = 'automation_cancelled';
      run.resume_policy = 'abandon';
      run.status = entry?.run.id === run.id ? 'cancelling' : (run.checkpoint?.phase === 'tool_pending' || run.status === 'recovery_required' ? 'recovery_required' : 'cancelled');
      if (run.status !== 'cancelling') run.finished_at ??= this.clock.iso();
      this.save(run);
      this.history.append({ ...run, event: 'cancellation_requested' });
      if (entry?.run.id === run.id) entry.signal.abort('automation_cancelled');
      else this.#settle(run);
    }
    this.onCancellation?.();
    return this.automationCancellation(id);
  }

  automationCancellation(id) {
    const runs = this.durableRuns().filter((r) => r.payload.automation_id === id);
    return {
      automation_id: id,
      requested: this.isAutomationCancelled(id),
      cancelled_runs: runs.filter((r) => r.status === 'cancelled').map((r) => r.id),
      stopping_runs: runs.filter((r) => r.status === 'cancelling').map((r) => r.id),
      reconciliation_required: runs.filter((r) => r.status === 'recovery_required' || (r.status === 'cancelling' && r.checkpoint?.phase === 'tool_pending')).map((r) => ({ run_id: r.id, checkpoint: r.checkpoint })),
    };
  }

  waitForRun(runId) {
    const run = this.durableRuns().find((r) => r.id === runId);
    if (!run) throw new HostError('run_not_found', `unknown run ${runId}`);
    if (!['queued', 'running', 'cancelling'].includes(run.status)) return Promise.resolve(run);
    return new Promise((resolve) => {
      const waiting = this.waiters.get(runId) ?? [];
      waiting.push(resolve);
      this.waiters.set(runId, waiting);
    });
  }

  #settle(run) {
    for (const resolve of this.waiters.get(run.id) ?? []) resolve(structuredClone(run));
    this.waiters.delete(run.id);
  }

  /** Invalidate only this discussion; never cancel another agent's user turn. */
  cancelRoom(roomId, epoch, reason = 'supersede') {
    for (const run of this.durableRuns()) {
      if (run.payload.kind !== 'room_turn' || run.payload.room_id !== roomId || run.payload.epoch !== epoch) continue;
      if (run.status === 'queued') {
        Object.assign(run, { status: 'interrupted', interrupt_reason: reason, resume_policy: 'abandon', finished_at: this.clock.iso() });
        this.save(run);
        this.history.append({ ...run, event: 'interrupted' });
        this.#settle(run);
      } else if (run.status === 'running' && this.active.get(run.agent_id)?.run.id === run.id) {
        this.interrupt(run.agent_id, { reason: 'supersede', source: `room:${reason}` });
      }
    }
  }

  /** The run ledger is authoritative; pending is only an index of queued work. */
  save(run) {
    this.queues.update((state) => {
      if (cancellationFor(state, run) && !['completed', 'failed', 'cancelled', 'recovery_required'].includes(run.status)) {
        run.status = this.active.get(run.agent_id)?.run.id === run.id ? 'cancelling' : 'cancelled';
        run.resume_policy = 'abandon'; run.interrupt_reason = 'user_cancelled';
      }
      if (state.cancelled_automations?.[run.payload.automation_id] && !['completed', 'failed', 'cancelled', 'recovery_required'].includes(run.status)) {
        run.status = this.active.get(run.agent_id)?.run.id === run.id ? 'cancelling' : 'cancelled';
        run.resume_policy = 'abandon';
        run.interrupt_reason = 'automation_cancelled';
      }
      run.priority = Boolean(run.priority || state.runs?.[run.id]?.priority);
      (state.runs ??= {})[run.id] = structuredClone(run);
      state.pending[run.agent_id] = (state.pending[run.agent_id] ?? []).filter((r) => r.id !== run.id);
      if (run.status === 'queued') state.pending[run.agent_id].push(structuredClone(run));
      return state;
    });
  }

  checkpoint(run, phase, detail = {}) {
    run.checkpoint = { phase, ...detail, at: this.clock.iso() };
    (run.checkpoints ??= []).push(structuredClone(run.checkpoint));
    this.save(run);
  }

  durableRuns() { return Object.values(this.queues.read().runs ?? {}); }

  #nextRun(agentId) {
    let next = null;
    this.queues.update((state) => {
      const queue = (state.pending[agentId] ?? []).filter((r) => !state.cancelled_automations?.[r.payload.automation_id] && !cancellationFor(state, r));
      state.pending[agentId] = queue;
      queue.sort((a, b) => LANE_RANK[a.lane] - LANE_RANK[b.lane] || Number(Boolean(b.priority)) - Number(Boolean(a.priority)));
      const index = queue.findIndex(run => this.canStart(run));
      if (index < 0) return state;
      next = queue[index];
      next.status = 'running';
      next.started_at = this.clock.iso();
      next.checkpoint ??= { phase: 'prepared', at: this.clock.iso() };
      // Commit ownership before removing the pending index. The run itself stays.
      (state.runs ??= {})[next.id] = structuredClone(next);
      state.pending[agentId] = queue.filter((_, i) => i !== index);
      return state;
    });
    return next;
  }

  /** Start the next run for an agent if none is active. One active run per agent. */
  pump(agentId) {
    if (this.active.has(agentId)) return this.inFlight.get(agentId);
    const run = this.#nextRun(agentId);
    if (!run) return Promise.resolve(null);

    const signal = new AbortSignalish();
    run.status = 'running';
    run.started_at = this.clock.iso();
    this.active.set(agentId, { run, signal });
    this.history.append({ ...run, event: 'started' });
    this.audit.record('run.started', { run_id: run.id, agent_id: agentId, lane: run.lane });

    const promise = (async () => {
      let result = null;
      let error = null;
      try {
        result = await this.runner(run, signal);
      } catch (err) {
        error = err;
      } finally {
        run.finished_at = this.clock.iso();
        if (this.isRunCancelled(run) || this.isAutomationCancelled(run.payload.automation_id)) {
          run.status = run.checkpoint?.phase === 'tool_pending' || run.uncertain_effect ? 'recovery_required' : 'cancelled';
          run.resume_policy = 'abandon';
        } else if (run.status === 'interrupted') {
          // Re-evaluate after cancellation: the in-flight tool may have returned a receipt.
          run.resume_policy = interruptionPolicy(run, run.interrupt_reason);
          if (run.resume_policy === 'reconcile') run.status = 'recovery_required';
          else if (run.resume_policy === 'restart') {
            run.status = 'queued'; run.finished_at = null;
          }
        } else {
          run.status = error ? 'failed' : 'completed';
        }
        if (error && run.status === 'failed') run.error = error.message;
        // A failing disk write must not leave the agent permanently "active": release
        // the agent and settle waiters whatever happens to persistence.
        try {
          this.save(run);
        } finally {
          this.active.delete(agentId);
          this.inFlight.delete(agentId);
          this.#settle(run);
        }
        try {
          this.history.append({ ...run, event: 'finished' });
          this.audit.record('run.finished', {
            run_id: run.id, agent_id: agentId, lane: run.lane, status: run.status,
            interrupt_reason: run.interrupt_reason, resume_policy: run.resume_policy,
          });
        } catch (err) {
          console.error(`run ${run.id}: could not record completion: ${err.message}`);
        }
      }
      await this.pump(agentId);
      return { run, result, error };
    })();

    this.inFlight.set(agentId, promise);
    return promise;
  }

  /** Start every agent that has queued work, then wait for the system to go quiet. */
  async drain() {
    for (let guard = 0; guard < 10_000; guard += 1) {
      // Register before inspecting queues so a handoff arriving while a model
      // streams wakes dispatch immediately. Waiting for all active runs starves
      // new workers behind an unrelated long run or an approval dialog.
      let wake;
      const queued = new Promise(resolve => { wake = resolve; });
      this.dispatchWaiters.add(wake);
      try {
        const state = this.queues.read().pending;
        const waiting = Object.entries(state).filter(([, q]) => q.some(run => this.canStart(run))).map(([id]) => id);
        for (const agentId of waiting) this.pump(agentId);
        if (this.inFlight.size === 0) {
          const still = Object.values(this.queues.read().pending).some(q => q.some(run => this.canStart(run)));
          if (!still) return;
          continue;
        }
        await Promise.race([...this.inFlight.values(), queued]);
      } finally { this.dispatchWaiters.delete(wake); }
    }
    throw new HostError('drain_guard', 'scheduler drain exceeded its guard limit');
  }

  activeRun(agentId) {
    const entry = this.active.get(agentId);
    return entry ? { ...entry.run, phase: entry.phase ?? 'thinking', thought: entry.thought ?? '', thought_key: entry.thought_key ?? null } : null;
  }

  /** Pending reasoning is flushed to the transcript by the host in chunks. */
  subscribeThought(listener) { this.thoughtListeners.add(listener); return () => this.thoughtListeners.delete(listener); }

  markThought(agentId, text, key = null) {
    const entry = this.active.get(agentId);
    if (!entry) return;
    const start = entry.thought_key === key ? (entry.thought_length ?? 0) : 0;
    entry.thought_length = start + text.length;
    entry.thought = (entry.thought ?? '') + text;
    entry.thought_key = key;
    entry.phase = 'thinking';
    for (const listener of this.thoughtListeners) {
      try { listener({type:'reasoning.delta', agent_id:agentId, run_id:entry.run.id, stream_id:key, start, text}); } catch { /* A disconnected viewer cannot stop a run. */ }
    }
  }

  clearThought(agentId) {
    const entry = this.active.get(agentId);
    if (entry) entry.thought = '';
  }

  /** Reporting only — the interface shows a different face while text streams. */
  markPhase(agentId, phase) {
    const entry = this.active.get(agentId);
    if (entry) entry.phase = phase;
  }

  pendingRuns(agentId) {
    return this.#pendingFor(agentId);
  }

  runHistory() {
    return this.history.readAll();
  }

  /** Only pre-execution work is replayable. Unknown external outcomes need review. */
  recover() {
    const reconciled = [];
    const history = this.history.readWithDiagnostics();
    this.queues.update((state) => {
      state.runs ??= {};
      const authoritative = new Set(Object.keys(state.runs));
      for (const queue of Object.values(state.pending)) {
        for (const run of queue) state.runs[run.id] ??= run;
      }
      // Import older started-but-unfinished runs without assuming they are safe.
      const latest = new Map(history.records.map((run) => [run.id, run]));
      for (const run of latest.values()) {
        if (!state.runs[run.id] && ['running', 'interrupted'].includes(run.status)) state.runs[run.id] = run;
      }
      for (const run of Object.values(state.runs)) {
        if (this.active.has(run.agent_id)) continue;
        if (cancellationFor(state, run) && !['completed', 'failed', 'cancelled'].includes(run.status)) {
          run.status = run.checkpoint?.phase === 'tool_pending' || run.uncertain_effect || run.status === 'recovery_required' ? 'recovery_required' : 'cancelled';
          run.resume_policy = 'abandon'; run.interrupt_reason = 'user_cancelled';
          run.finished_at ??= this.clock.iso();
          reconciled.push(structuredClone(run));
          continue;
        }
        if (history.corruption.length && !authoritative.has(run.id)) {
          run.status = 'recovery_required'; run.resume_policy = 'abandon';
          run.recovery = { reason: 'incomplete_legacy_history', replay_safe: false, at: this.clock.iso() };
          reconciled.push(structuredClone(run));
          continue;
        }
        if (state.cancelled_automations?.[run.payload.automation_id] && !['completed', 'failed', 'cancelled'].includes(run.status)) {
          run.status = run.checkpoint?.phase === 'tool_pending' || run.uncertain_effect || run.status === 'recovery_required' ? 'recovery_required' : 'cancelled';
          run.resume_policy = 'abandon';
          run.interrupt_reason = 'automation_cancelled';
          run.finished_at ??= this.clock.iso();
          reconciled.push(structuredClone(run));
          continue;
        }
        if (!['running', 'interrupted'].includes(run.status) || run.finished_at) continue;
        const safe = (run.status === 'running' && ['prepared', 'inbox_bound'].includes(run.checkpoint?.phase))
          || (run.status === 'interrupted' && interruptionPolicy(run, run.interrupt_reason) === 'restart');
        run.status = safe ? 'queued' : 'recovery_required';
        run.recovery = { reason: 'process_stopped', replay_safe: safe, at: this.clock.iso() };
        reconciled.push(structuredClone(run));
      }
      // Preserve queued order, adding only recovered runs absent from the index.
      for (const [agentId, queue] of Object.entries(state.pending)) {
        state.pending[agentId] = queue.filter((r) => state.runs[r.id]?.status === 'queued').map((r) => state.runs[r.id]);
      }
      for (const run of Object.values(state.runs)) {
        if (run.status !== 'queued') continue;
        const queue = (state.pending[run.agent_id] ??= []);
        if (!queue.some((r) => r.id === run.id)) queue.push(run);
      }
      return state;
    });
    for (const run of reconciled) this.history.append({ ...run, event: 'recovered' });
    const recovered = Object.values(this.queues.read().pending).flat().map((r) => ({ agent_id: r.agent_id, run_id: r.id, lane: r.lane }));
    if (reconciled.length || recovered.length) this.audit.record('scheduler.recovered', {
      count: recovered.length, recovery_required: this.durableRuns().filter((r) => r.status === 'recovery_required').map((r) => r.id),
    });
    return recovered;
  }
}
