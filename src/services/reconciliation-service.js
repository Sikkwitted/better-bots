import { createHash } from 'node:crypto';
import { HostError, newId } from '../core/util.js';

const revision = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const OUTCOMES = ['confirmed_complete', 'confirmed_not_executed', 'abandoned', 'unresolved'];
const UNCERTAIN = ['recovery_required', 'reconciliation_required'];

/** Operator decisions commit with the affected state; audit repair is idempotent. */
export class ReconciliationService {
  constructor({ scheduler, memory, audit, clock }) {
    Object.assign(this, { scheduler, memory, audit, clock });
  }

  store(kind) {
    if (kind === 'run') return { doc: this.scheduler.queues, key: 'runs' };
    if (kind === 'memory') return { doc: this.memory.doc, key: 'jobs' };
    throw new HostError('bad_kind', 'choose run or memory');
  }

  list() {
    return ['run', 'memory'].flatMap((kind) => {
      const { doc, key } = this.store(kind);
      return Object.values(doc.read()[key] ?? {})
        .filter((item) => UNCERTAIN.includes(item.status))
        .map((item) => ({ kind, id: item.id, revision: revision(item), record: item }));
    });
  }

  resolve({ kind, id, expected_revision, outcome, evidence, request_id, actor = 'user' }) {
    if (actor !== 'user') throw new HostError('user_only_decision', 'only the user resolves uncertain work');
    if (!OUTCOMES.includes(outcome) || typeof evidence !== 'string' || !evidence.trim() || !request_id) {
      throw new HostError('resolution_evidence_required', 'choose an outcome and supply evidence and a request ID');
    }
    const { doc, key } = this.store(kind);
    let decision;
    doc.update((state) => {
      const item = state[key]?.[id];
      if (!item) throw new HostError('not_found', 'unknown reconciliation item');
      const previous = (item.resolutions ?? []).find((d) => d.request_id === request_id);
      if (previous) {
        if (previous.outcome !== outcome || previous.evidence !== evidence.trim()) {
          throw new HostError('resolution_conflict', 'request ID already used for a different decision');
        }
        decision = previous;
        return state;
      }
      if (revision(item) !== expected_revision) throw new HostError('stale_resolution', 'state changed; inspect the current evidence before resolving');
      if (!UNCERTAIN.includes(item.status)) throw new HostError('not_uncertain', 'this item is not awaiting reconciliation');
      if (kind === 'run' && this.scheduler.active.has(item.agent_id)) throw new HostError('run_active', 'wait for the agent to stop before resolving');
      if (outcome === 'confirmed_not_executed' && kind === 'run') this.assertRetrySafe(item);

      decision = {
        id: newId('resolution'), request_id, kind, item_id: id, outcome,
        evidence: evidence.trim(), actor, at: this.clock.iso(),
        previous_status: item.status, checkpoint: item.checkpoint ?? null,
        ...(kind === 'memory' && outcome === 'confirmed_not_executed' && item.operation_id ? {
          previous_operation: {
            operation_id: item.operation_id, receipt: item.receipt ?? null,
            error: item.error ?? null, confirmation_checks: item.confirmation_checks ?? 0,
          },
        } : {}),
      };
      (item.resolutions ??= []).push(decision);
      if (outcome === 'confirmed_complete') {
        item.status = kind === 'run' ? 'completed' : 'succeeded';
        item.completed_at = this.clock.iso();
        if (kind === 'run') item.finished_at = this.clock.iso();
        else item.receipt = { success: true, operator_confirmed: true, evidence: decision.evidence, resolution_id: decision.id };
      } else if (outcome === 'abandoned') {
        item.status = kind === 'run' ? 'cancelled' : 'abandoned';
        item.finished_at = this.clock.iso();
      } else if (outcome === 'confirmed_not_executed') {
        if (kind === 'run') {
          Object.assign(item, { status: 'queued', finished_at: null, started_at: null, interrupt_reason: null, resume_policy: null });
          item.checkpoint = { phase: 'prepared', at: this.clock.iso(), resolution_id: decision.id };
          delete item.uncertain_effect;
          const queue = (state.pending[item.agent_id] ??= []);
          if (!queue.some((run) => run.id === id)) queue.push(structuredClone(item));
        } else {
          item.status = 'pending';
          item.phase = 'ensure_bank';
          // The old ID names a terminal failed operation at the provider. Only
          // an evidence-backed non-execution decision permits a fresh attempt;
          // unresolved work must keep polling its original ID instead.
          delete item.operation_id;
          delete item.receipt;
          delete item.confirmation_checks;
          delete item.completed_at;
          delete item.next_attempt_at;
          delete item.error;
        }
      }
      // Unresolved records stay blocked, with the new evidence preserved.
      return state;
    });
    this.auditDecision(decision);
    return { ok: true, decision };
  }

  assertRetrySafe(item) {
    if (this.scheduler.isRunCancelled(item)) throw new HostError('run_cancelled', 'cancelled run cannot be retried; request any remaining work explicitly');
    if (this.scheduler.isAutomationCancelled(item.payload.automation_id)) {
      throw new HostError('automation_cancelled', 'cancelled automation cannot be retried');
    }
    if ((item.checkpoints ?? []).some((c) => c.phase === 'tool_recorded' && c.record?.decision === 'allowed')) {
      throw new HostError('completed_effects_present', 'recorded actions exist; do not retry the whole run. Abandon or confirm its outcome, then request only the remaining work.');
    }
  }

  auditDecision(decision) {
    if (!this.audit.where((event) => event.type === 'reconciliation.resolved' && event.resolution_id === decision.id).length) {
      this.audit.record('reconciliation.resolved', {
        ...decision, resolution_id: decision.id,
        ...(decision.kind === 'run' ? { run_id: decision.item_id } : { retention_id: decision.item_id }),
      });
    }
  }

  recover() {
    for (const kind of ['run', 'memory']) {
      const { doc, key } = this.store(kind);
      for (const item of Object.values(doc.read()[key] ?? {})) {
        for (const decision of item.resolutions ?? []) this.auditDecision(decision);
      }
    }
  }
}
