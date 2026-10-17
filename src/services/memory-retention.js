import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JsonDoc } from '../core/store.js';
import { HostError } from '../core/util.js';

// A just-sent operation can briefly read as not_found before the provider registers it.
export const NOT_FOUND_GRACE_MS = 10 * 60 * 1000;
// An async engine (Hindsight) acknowledges a save at once and extracts later
// with a model call. Dispatching a whole backlog at once queues that many model
// calls on the engine's model; this caps how many may be outstanding.
export const MAX_IN_FLIGHT = 2;
// Finished jobs older than this are dropped from the journal at startup. The
// facts and transcripts stay on disk; only the delivery record goes.
export const RETENTION_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const FINISHED = ['succeeded', 'local_saved', 'abandoned'];
// At least memory-consolidation's MAX_EVIDENCE.
const KEEP_EXCHANGES = 60;

/** Host-owned write-ahead journal. Raw exchanges are jobs, never recalled facts. */
export class MemoryRetention {
  constructor({ dir, clock, audit, engine, writeFact, ensureBank, bank }) {
    Object.assign(this, { clock, audit, engine, writeFact, ensureBank, bank });
    this.doc = new JsonDoc(path.join(dir, 'memory', 'retention.json'), { jobs: {} });
    this.running = null;
  }

  /** The engine a job is written for; `local` when none is configured. */
  get engineName() { return this.engine ? (this.engine.name ?? 'engine') : 'local'; }

  /** Work queued for another engine waits for the operator (`better-bots memory release-held`). */
  #foreign(job) { return Boolean(job.engine) && job.engine !== this.engineName; }

  enqueue({ key, scope, owner_id, writer_agent_id, item, fact = null, retain = true }) {
    const id = createHash('sha256').update(JSON.stringify([scope, owner_id, writer_agent_id, key])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([item.content, item.context, item.metadata, fact, retain])).digest('hex');
    let job;
    this.doc.update((state) => {
      job = state.jobs[id];
      if (job && job.fingerprint !== fingerprint) throw new HostError('memory_retention_conflict', 'retention identity already belongs to different content');
      job ??= state.jobs[id] = { id, fingerprint, scope, owner_id, writer_agent_id, item: { ...item, document_id: `memory-${id}` }, fact, retain, engine: this.engineName, status: 'prepared', attempts: 0, created_at: this.clock.iso() };
      return state;
    });
    this.commitLocal(job);
    this.kick();
    return id;
  }

  save(job) { this.doc.update((state) => { state.jobs[job.id] = job; return state; }); }

  commitLocal(job) {
    if (job.status !== 'prepared') return;
    if (job.fact) this.writeFact(job.fact);
    // With no engine there is nothing to send it to: the local copy is the whole write.
    job.status = job.retain && this.engine ? 'pending' : 'local_saved';
    this.save(job);
  }

  recover() {
    if (this.running) return { held: 0 };
    this.#prune();
    let held = 0;
    const confirmed = new Set(this.audit.where(e => e.retention_id
      && ['memory.engine_retained', 'memory.exchange_retained'].includes(e.type))
      .map(e => `${e.type}:${e.retention_id}`));
    for (const job of Object.values(this.doc.read().jobs)) {
      this.commitLocal(job);
      if (job.status === 'processing') {
        job.status = job.phase === 'dispatch' ? (job.operation_id ? 'awaiting_confirmation' : 'reconciliation_required') : 'retryable';
        job.error = 'Host stopped before the retention outcome was committed';
        job.next_attempt_at = this.clock.iso();
        this.save(job);
      }
      if (job.status === 'succeeded') this.auditSuccess(job, confirmed);
      // Older journals did not record an engine; with none now, nothing will send them.
      if (!this.engine && !job.engine && job.status === 'pending') { job.status = 'local_saved'; this.save(job); }
      if (['pending', 'retryable'].includes(job.status) && this.#foreign(job)) {
        job.held_from = job.status; job.status = 'held'; this.save(job);
        this.audit.record('memory.retention_held', { retention_id: job.id, job_engine: job.engine, engine: this.engineName });
      }
      if (job.status === 'held') held += 1;
    }
    this.kick();
    return { held };
  }

  #prune() {
    const cutoff = this.clock.now() - RETENTION_KEEP_MS;
    // A raw exchange lives only here, and consolidation cites the newest ones as
    // evidence, so each scope keeps its latest KEEP_EXCHANGES whatever their age.
    const jobs = Object.values(this.doc.read().jobs).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const seen = new Map();
    const kept = (j) => {
      if (j.fact) return false;
      const key = `${j.scope}:${j.owner_id}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return seen.get(key) <= KEEP_EXCHANGES;
    };
    const old = new Set(jobs.filter((j) => !kept(j) && FINISHED.includes(j.status) && Date.parse(j.completed_at ?? j.created_at) < cutoff).map((j) => j.id));
    if (!old.size) return;
    this.doc.update((state) => { for (const id of old) delete state.jobs[id]; return state; });
  }

  /** The operator's consent to send held work to the engine configured now. */
  releaseHeld() {
    if (!this.engine) throw new HostError('memory_no_engine', 'No memory engine is configured; held work stays in the local journal');
    const released = [];
    for (const job of Object.values(this.doc.read().jobs)) {
      if (job.status !== 'held') continue;
      job.status = 'pending'; job.engine = this.engineName;
      delete job.held_from; delete job.next_attempt_at;
      this.save(job); released.push(job.id);
    }
    if (released.length) this.audit.record('memory.retention_released', { count: released.length, engine: this.engineName });
    this.kick();
    return released;
  }

  auditSuccess(job, confirmed = null) {
    const event = job.fact ? 'memory.engine_retained' : 'memory.exchange_retained';
    if (!(confirmed ? confirmed.has(`${event}:${job.id}`) : this.audit.where((e) => e.type === event && e.retention_id === job.id).length)) {
      this.audit.record(event, { retention_id: job.id, confirmation: job.receipt?.operator_confirmed ? 'operator' : 'provider', scope: job.scope, owner_id: job.owner_id, writer_agent_id: job.writer_agent_id, fact_id: job.fact?.id ?? null, run_id: job.item.metadata?.run_id ?? null });
      confirmed?.add(`${event}:${job.id}`);
    }
  }

  /** One bounded batch, one worker. Provider latency never blocks a model turn. */
  kick() {
    if (!this.engine || this.running) return this.running ?? Promise.resolve();
    this.running = Promise.resolve().then(async () => {
      const eligible = Object.values(this.doc.read().jobs).filter((j) => (['pending', 'retryable'].includes(j.status) ? !this.#foreign(j) : j.status === 'awaiting_confirmation') && (!j.next_attempt_at || Date.parse(j.next_attempt_at) <= this.clock.now())).slice(0, 16);
      let inFlight = Object.values(this.doc.read().jobs).filter((j) => j.status === 'awaiting_confirmation').length;
      for (const job of eligible) {
        if (job.status === 'awaiting_confirmation') {
          await this.confirm(job);
          if (this.doc.read().jobs[job.id]?.status !== 'awaiting_confirmation') inFlight -= 1;
          continue;
        }
        if (this.engine.supportsAsyncRetention && inFlight >= MAX_IN_FLIGHT) continue;
        job.status = 'processing'; job.phase = 'ensure_bank'; job.attempts++; this.save(job);
        let receipt;
        try {
          await this.ensureBank(job.scope, job.owner_id);
          if (this.engine.supportsAsyncRetention) job.operation_id ??= randomUUID();
          job.phase = 'dispatch'; job.dispatched_at = this.clock.iso(); this.save(job);
          receipt = await this.engine.retain(this.bank(job.scope, job.owner_id), {...job.item, ...(job.operation_id ? {operation_id:job.operation_id} : {})});
          if (receipt?.success === true && receipt.async === true && receipt.operation_id && this.engine.retentionStatus) {
            job.operation_id = receipt.operation_id; job.receipt = receipt;
            job.status = 'awaiting_confirmation'; job.next_attempt_at = this.clock.iso();
            this.save(job); inFlight += 1; continue;
          }
          if (receipt?.success !== true || receipt.async === true) throw new HostError('memory_unconfirmed', 'Provider did not confirm completed retention');
        } catch (err) {
          const status = err.status ?? err.details?.status;
          job.status = [401, 403].includes(status) ? 'blocked'
            : job.phase === 'ensure_bank' || status === 429 || err.definitely_not_accepted === true ? 'retryable'
            : status >= 400 && status < 500 && status !== 408 ? 'blocked' : 'reconciliation_required';
          if (job.status === 'reconciliation_required' && job.operation_id && this.engine.retentionStatus) job.status = 'awaiting_confirmation';
          job.error = String(err.message); job.http_status = status ?? null;
          job.next_attempt_at = new Date(this.clock.now() + Math.max(err.retry_after_ms ?? 0, Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12)))).toISOString();
          this.save(job);
          this.audit.record('memory.engine_failed', { op: job.fact ? 'retain' : 'retain_exchange', retention_id: job.id, scope: job.scope, owner_id: job.owner_id, status: job.status, error: job.error });
          continue;
        }
        job.status = 'succeeded'; job.receipt = receipt; job.completed_at = this.clock.iso(); delete job.error;
        this.save(job); this.auditSuccess(job);
      }
    }).finally(() => { this.running = null; });
    // Surface local persistence failures to flush(), without an unhandled rejection.
    this.running.catch(() => {});
    return this.running;
  }

  /** Poll the original operation. A lost response never causes another write. */
  async confirm(job) {
    const fingerprint = job.fingerprint;
    let result, error;
    try { result = await this.engine.retentionStatus(this.bank(job.scope, job.owner_id), job.operation_id); }
    catch (err) { error = err; }
    // An operator can dismiss a task while a network read is in flight.
    const current = this.doc.read().jobs[job.id];
    if (current?.status !== 'awaiting_confirmation' || current.fingerprint !== fingerprint || current.operation_id !== job.operation_id) return;
    job = current;
    job.confirmation_checks = (job.confirmation_checks ?? 0) + 1;
    if (!error && result?.status === 'completed' && (!result.operation_id || result.operation_id === job.operation_id)) {
      job.status = 'succeeded'; job.receipt = {success:true, async:false, operation_id:job.operation_id, provider_status:'completed'};
      job.completed_at = this.clock.iso(); delete job.error; delete job.next_attempt_at;
      this.save(job); this.auditSuccess(job); return;
    }
    if (!error && ['failed', 'cancelled'].includes(result?.status)) {
      job.status = 'reconciliation_required';
      job.error = result.error_message ?? result.error ?? `Memory operation ${result.status}`;
    } else if (!error && result?.status === 'not_found'
        && this.clock.now() - Date.parse(job.dispatched_at ?? job.created_at) > NOT_FOUND_GRACE_MS) {
      // The provider has no record of this save long after it was sent (the
      // dispatch timed out before it registered). Polling cannot change that, so
      // ask the operator; the local copy is kept and a retry re-sends it.
      job.status = 'reconciliation_required';
      job.error = 'Hindsight has no record of this save (operation not_found); it was not stored remotely.';
      delete job.next_attempt_at;
    } else {
      job.error = error ? String(error.message) : null;
      job.next_attempt_at = new Date(this.clock.now() + Math.min(60000, 2000 * 2 ** Math.min(job.confirmation_checks, 5))).toISOString();
    }
    this.save(job);
  }

  async flush() {
    let before;
    do {
      before = JSON.stringify(Object.values(this.doc.read().jobs).map((j) => [j.id, j.status, j.confirmation_checks ?? 0]));
      await this.kick();
    }
    // Stop once a pass changes nothing: jobs held back by MAX_IN_FLIGHT wait for confirmations, not for another loop.
    while (this.engine && before !== JSON.stringify(Object.values(this.doc.read().jobs).map((j) => [j.id, j.status, j.confirmation_checks ?? 0]))
      && Object.values(this.doc.read().jobs).some((j) => ['pending', 'retryable'].includes(j.status) && (!j.next_attempt_at || Date.parse(j.next_attempt_at) <= this.clock.now())));
  }

  retry(id) {
    const job = this.doc.read().jobs[id];
    if (!job || !['blocked', 'retryable'].includes(job.status)) throw new HostError('memory_retry_unsafe', 'Only rejected or pre-dispatch work can be retried; uncertain writes require provider reconciliation');
    job.status = 'pending'; job.engine = this.engineName; delete job.next_attempt_at; this.save(job); this.kick();
    return { id, status: 'pending' };
  }

  status() {
    const jobs = Object.values(this.doc.read().jobs);
    return { engine: this.engine?.name ?? 'local', counts: jobs.reduce((counts, j) => { counts[j.status] = (counts[j.status] ?? 0) + 1; return counts; }, {}),
      unfinished: jobs.filter((j) => !['succeeded', 'local_saved', 'abandoned'].includes(j.status)).map((j) => ({ id: j.id, scope: j.scope, owner_id: j.owner_id, status: j.status, created_at: j.created_at, attempts: j.attempts, error: j.error ?? (this.engine ? null : 'No memory engine configured; content is stored locally'), document_id: j.item.document_id, next_attempt_at: j.next_attempt_at ?? null })) };
  }
}
