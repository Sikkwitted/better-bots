import path from 'node:path';
import { JsonDoc } from '../core/store.js';
import { newId, HostError } from '../core/util.js';

// An agent is a bundle, not a model. The record is what preserves continuity.
// Profile, transcript, and memory are separate objects; updating a
// profile must never rewrite a transcript, so this service owns profiles only.

const DEFAULT_PROFILE = {
  name: 'Agent',
  role: '',
  description: '',
  title: '',
  // Must stay in step with web/avatar.js — test/avatar.test.js pins the pair.
  avatar_shape: 'round',
  avatar_style: 'plain',
  avatar_color: '#51FFCD',
  avatar_hair: 'dark',
  // null = inherit the model the host was started with.
  model: null,
  model_provider: null,
  // One lead returns the one answer. A role, not a primitive: rooms do not need one.
  lead: false,
};

// The console's name for the default desk (stored as ''). Keep in step with web/app.js.
export const DEFAULT_DESK_LABEL = 'General';

// Records are keyed by id in plain objects, so an id must never resolve to an
// inherited property ("constructor" would otherwise find Object itself).
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const own = (records, id) => (Object.hasOwn(records, id) ? records[id] : undefined);

export class AgentRegistry {
  constructor({ dir, clock, audit, knownDesks = () => [] }) {
    this.dir = dir;
    this.clock = clock;
    this.audit = audit;
    // Desks with settings but possibly no members yet (desks.json); supplied by the host.
    this.knownDesks = knownDesks;
    this.doc = new JsonDoc(path.join(dir, 'agents', 'registry.json'), { agents: {} });
  }

  /** Stable ID that does not depend on the display name. */
  create({ id, profile = {}, enabled_workflows = [] } = {}) {
    const agentId = id ?? newId('agt');
    const record = {
      id: agentId,
      profile: { ...DEFAULT_PROFILE, ...profile },
      created_at: this.clock.iso(),
      enabled_workflows,
    };
    if (RESERVED_IDS.has(agentId)) throw new HostError('bad_agent_id', `${agentId} cannot be an agent id`);
    this.doc.update((state) => {
      if (state.deleted && Object.hasOwn(state.deleted, agentId)) throw new HostError('agent_deleted', 'deleted agent IDs cannot be reused');
      if (Object.hasOwn(state.agents, agentId)) throw new HostError('agent_exists', `agent ${agentId} already exists`);
      if (profile.desk !== undefined) record.profile.desk = this.#resolveDesk(profile.desk, state);
      state.agents[agentId] = record;
      return state;
    });
    this.audit.record('agent.created', { agent_id: agentId, name: record.profile.name });
    return record;
  }

  get(agentId) {
    const record = own(this.doc.read().agents, agentId);
    if (!record) throw new HostError('agent_not_found', `unknown agent ${agentId}`);
    return record;
  }

  has(agentId) {
    return Boolean(own(this.doc.read().agents, agentId));
  }

  list() {
    return Object.values(this.doc.read().agents);
  }

  /** Profile edits touch the profile only. The transcript store is never involved. */
  updateProfile(agentId, patch) {
    let updated;
    this.doc.update((state) => {
      const record = own(state.agents, agentId);
      if (!record) throw new HostError('agent_not_found', `unknown agent ${agentId}`);
      if (patch.desk !== undefined) patch = { ...patch, desk: this.#resolveDesk(patch.desk, state) };
      // One lead per desk. Crowning this agent uncrowns the previous lead of the
      // same desk; other desks keep theirs, since each desk is its own workflow.
      if (patch.lead === true) {
        const desk = patch.desk ?? record.profile.desk ?? '';
        for (const other of Object.values(state.agents)) if ((other.profile.desk ?? '') === desk) other.profile.lead = false;
      }
      record.profile = { ...record.profile, ...patch };
      updated = record;
      return state;
    });
    this.audit.record('agent.profile_updated', { agent_id: agentId, fields: Object.keys(patch) });
    return updated;
  }

  /**
   * A desk is referenced by its stored name. The console shows the default desk
   * ('') as "General", so that label means the default desk, and a name that
   * differs from an existing desk only by case or spacing means that desk.
   * Only a genuinely new name starts a new desk.
   */
  #resolveDesk(input, state) {
    const name = String(input ?? '').trim().replace(/\s+/g, ' ');
    const key = name.toLowerCase();
    if (key === '' || key === DEFAULT_DESK_LABEL.toLowerCase()) return '';
    const existing = [
      ...Object.values(state.agents).map((a) => a.profile.desk ?? ''),
      ...(this.knownDesks() ?? []),
    ];
    return existing.find((d) => d && d.trim().replace(/\s+/g, ' ').toLowerCase() === key) ?? name;
  }

  /**
   * A stored "General" label would split agents into a phantom desk beside the
   * default one; move them back, auditing each move. Returns the repaired agent
   * IDs.
   */
  repairDefaultDeskLabels() {
    const isLabel = (desk) => typeof desk === 'string' && desk !== '' && desk.trim().toLowerCase() === DEFAULT_DESK_LABEL.toLowerCase();
    if (!this.list().some((record) => isLabel(record.profile.desk))) return [];
    const repaired = [];
    this.doc.update((state) => {
      for (const record of Object.values(state.agents)) {
        const desk = record.profile.desk;
        if (isLabel(desk)) {
          record.profile.desk = '';
          repaired.push({ id: record.id, from: desk });
        }
      }
      return state;
    });
    for (const { id, from } of repaired) this.audit.record('agent.desk_repaired', { agent_id: id, from, to: '' });
    return repaired.map((r) => r.id);
  }

  enableWorkflow(agentId, workflowId) {
    let updated;
    this.doc.update((state) => {
      const record = own(state.agents, agentId);
      if (!record) throw new HostError('agent_not_found', `unknown agent ${agentId}`);
      if (!record.enabled_workflows.includes(workflowId)) record.enabled_workflows.push(workflowId);
      updated = record;
      return state;
    });
    this.audit.record('agent.workflow_enabled', { agent_id: agentId, workflow_id: workflowId });
    return updated;
  }

  /** Deletion has an explicit user confirmation path. */
  delete(agentId, { confirm = false, actor = 'user' } = {}) {
    if (!confirm) {
      throw new HostError('confirmation_required', `deleting ${agentId} requires confirm: true`);
    }
    if (actor !== 'user') {
      throw new HostError('user_only_decision', 'only the user may delete an agent');
    }
    this.doc.update((state) => {
      (state.deleted ??= {})[agentId] ??= { at: this.clock.iso() };
      delete state.agents[agentId];
      return state;
    });
    this.onDelete?.(agentId);
    this.audit.record('agent.deleted', { agent_id: agentId, actor });
    return { deleted: true, agent_id: agentId };
  }

  /**
   * Teammate directory for the context envelope.
   * Names and roles are visible; transcripts and memory are not.
   */
  visibleTo(agentId) {
    return this.list()
      .filter((a) => a.id !== agentId)
      .map((a) => ({ id: a.id, name: a.profile.name, role: a.profile.role || a.profile.title }));
  }
}
