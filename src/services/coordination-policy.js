import path from 'node:path';
import { JsonDoc } from '../core/store.js';
import { HostError } from '../core/util.js';

/** One durable recipient set per task, shared by continuations and peer wakes. */
export class CoordinationPolicy {
  constructor({ dir, audit, rooms }) {
    this.doc = new JsonDoc(path.join(dir, 'coordination.json'), { tasks: {} });
    this.audit = audit;
    this.rooms = rooms;
  }

  taskId(run) {
    return run.payload.coordination_id ?? run.payload.automation_id ?? run.id;
  }

  targets(target) {
    return this.rooms.has(target) ? this.rooms.get(target).member_ids : [target];
  }

  initialState(run) {
    return { recipients: [run.agent_id, ...(run.payload.authorized_recipients ?? [])], handoff_used: false };
  }

  ensure(run) {
    const id = this.taskId(run);
    this.doc.update((state) => {
      state.tasks[id] ??= this.initialState(run);
      return state;
    });
  }

  state(run) {
    return this.doc.read().tasks[this.taskId(run)] ?? this.initialState(run);
  }

  requiresApproval(run, target) {
    const state = this.state(run);
    const extra = this.targets(target).filter((id) => !state.recipients.includes(id));
    return extra.length > 0 && (this.rooms.has(target) || state.handoff_used);
  }

  commit(run, target, approved = false) {
    if (this.requiresApproval(run, target) && !approved) {
      throw new HostError('fanout_approval_required', 'additional task recipients require explicit approval');
    }
    const id = this.taskId(run);
    const prior = this.state(run);
    const recipients = this.targets(target);
    this.doc.update((state) => {
      state.tasks[id] = { ...prior, recipients: [...new Set([...prior.recipients, ...recipients])], handoff_used: true };
      return state;
    });
    this.audit.record('coordination.recipients_authorized', {
      task_id: id, run_id: run.id, recipients,
      basis: approved ? 'exact_approval' : 'authorized_or_single_handoff',
    });
    return id;
  }
}
