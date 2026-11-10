import path from 'node:path';
import { JsonDoc } from '../core/store.js';
import { newId, HostError } from '../core/util.js';

// Permissions and trust: what a bot may do on its own, and what it must ask for.
//
// Bots are autonomous by default: every action runs without asking, and the
// person accepts that once, when they install and first open Better Bots.
// Local file tools execute on the host machine, outside the sandbox.
// Standing modes are always | ask | never, default always, with an admin ceiling.
// Choosing Ask or Never for a zone is how a person takes control back.

export const ZONES = ['local', 'external', 'sandbox', 'coordination'];
export const MODES = ['always', 'ask', 'never'];
export const RESOLUTIONS = ['allow_once', 'deny', 'always', 'never'];
export const APPROVAL_TTL_MS = 10 * 60 * 1000; // pending asks expire after ten minutes

/** The permission matrix: each action's zone, default and what it does. */
export const ACTION_POLICY = {
  'coordination.handoff': { zone: 'coordination', default: 'allow', why: 'One-owner task handoff or an already authorized recipient.' },
  'coordination.fanout': { zone: 'coordination', default: 'allow', require_exact_target: true, why: 'Adds a recipient or room to this task. Approval covers this exact send; its recipients remain authorized for the task.' },
  'web.read_public':        { zone: 'external',  default: 'allow',    why: 'Low local impact.' },
  'sandbox.read_file':      { zone: 'sandbox',   default: 'allow',    why: 'Agent-owned environment.' },
  'sandbox.write_file':     { zone: 'sandbox',   default: 'allow',    why: 'Agent-owned environment.' },
  'sandbox.run_test':       { zone: 'sandbox',   default: 'allow',    why: 'Reversible and contained.' },
  'sandbox.run_command':    { zone: 'sandbox',   default: 'allow',    why: 'Reversible and contained.' },
  'local.read_file':        { zone: 'local',     default: 'allow',    why: "Reads host-machine data outside the sandbox." },
  'local.list_directory':   { zone: 'local',     default: 'allow',    why: "Reads host-machine data outside the sandbox." },
  'local.write_file':       { zone: 'local',     default: 'allow',    why: 'Changes user-owned state.', require_exact_target: true },
  'local.run_command':      { zone: 'local',     default: 'allow',    why: 'Runs on the machine hosting Better Bots.', require_exact_target: true },
  'external.browser': { zone: 'external', default: 'allow', require_exact_target: true, why: 'Operates the bot’s browser and desktop.' },
  'external.unclassified': { zone: 'external', default: 'allow', require_exact_target: true, high_risk: true, why: 'A connected tool without a reviewed classification.' },
  'external.fetch_dependency': { zone: 'external', default: 'allow', require_exact_target: true, why: 'Downloads this exact integrity-pinned public dependency into the agent workspace. Does not execute install scripts.' },
  'external.credentials': { zone: 'external', default: 'allow', require_exact_target: true, high_risk: true, why: 'Changes credentials or account access.' },
  'external.publish':       { zone: 'external',  default: 'allow', why: 'External side effect.', require_exact_target: true },
  'external.pay':           { zone: 'external',  default: 'allow', why: 'External side effect.', require_exact_target: true, high_risk: true },
  'external.send':          { zone: 'external',  default: 'allow', why: 'External side effect.', require_exact_target: true },
  'external.delete':        { zone: 'external',  default: 'allow', why: 'Destructive side effect.', require_exact_target: true },
  // Tools from connected MCP servers. A tool the server marks read-only (or an
  // integration the user marked read-only) reads like a public page; anything
  // else may place an order or deploy a release.
  'integration.read':       { zone: 'external',  default: 'allow',    why: 'Reads from a connected service.' },
  'integration.act':        { zone: 'external',  default: 'allow',    why: 'Acts in a connected service.', require_exact_target: true },
  'policy.change_standing': { zone: 'policy',    default: 'user_only', why: 'Alters the trust boundary itself.' },
};

const MODE_RANK = { never: 0, ask: 1, always: 2 };

export class PermissionService {
  constructor({ dir, clock, audit }) {
    this.clock = clock;
    this.audit = audit;
    this.doc = new JsonDoc(path.join(dir, 'permissions', 'state.json'), {
      // Standing mode per zone. The local zone covers host-machine tools.
      standing: { local: 'always', external: 'always', sandbox: 'always', coordination: 'always' },
      explicit: {},
      // When the person accepted the first-open notice that bots work without asking.
      autonomy_acknowledged_at: null,
      // The ceiling is the most permissive setting policy allows. It starts
      // unrestricted; an administrator lowers it to constrain the user's choice.
      ceiling: { local: 'always', external: 'always', sandbox: 'always', coordination: 'always' },
      requests: {},  // request_id -> ApprovalRequest
      grants: [],    // allow-once grants, scoped to agent+action+target+scope
      denials: [],   // remembered denials for the current direction
    });
    if (!this.doc.read().ceiling.coordination) this.doc.update((s) => { s.ceiling.coordination = 'always'; s.standing.coordination = 'always'; return s; });
    // Old files do not distinguish defaults from choices. Preserve every saved
    // restriction conservatively rather than guessing that it was only a default.
    if (!this.doc.read().explicit) this.doc.update((state) => {
      state.explicit = Object.fromEntries(Object.keys(state.standing).map((zone) => [zone, true]));
      return state;
    });
    // A zone nobody chose shows the built-in default, which is what applies.
    const unchosen = ZONES.filter((zone) => !this.doc.read().explicit[zone] && this.doc.read().standing[zone] !== 'always');
    if (unchosen.length) this.doc.update((state) => { for (const zone of unchosen) state.standing[zone] = 'always'; return state; });
  }

  /** The person accepted the first-open notice that bots work without asking. */
  acknowledgeAutonomy({ actor = 'user' } = {}) {
    if (actor !== 'user') throw new HostError('user_only_decision', 'only the user accepts the autonomy notice');
    const at = this.clock.iso();
    this.doc.update((state) => { state.autonomy_acknowledged_at ??= at; return state; });
    this.audit.record('permission.autonomy_acknowledged', { actor });
    return this.doc.read().autonomy_acknowledged_at;
  }

  validateZone(zone) {
    if (!ZONES.includes(zone)) throw new HostError('bad_zone', `unknown permission zone ${zone}`);
  }

  policyFor(action) {
    const policy = ACTION_POLICY[action];
    if (!policy) throw new HostError('unknown_action', `no policy for action ${action}`);
    return policy;
  }

  effectivePolicy(action, state = this.doc.read()) {
    const policy = this.policyFor(action);
    const unchosen = policy.default === 'allow' ? 'always' : 'ask';
    const configured = state.explicit?.[policy.zone] ? state.standing[policy.zone] : unchosen;
    const ceiling = state.ceiling[policy.zone] ?? 'ask';
    let mode = MODES.includes(configured) && MODES.includes(ceiling)
      ? (MODE_RANK[configured] <= MODE_RANK[ceiling] ? configured : ceiling) : 'never';
    return { configured, ceiling, mode };
  }

  standingMode(zone) {
    this.validateZone(zone);
    return this.doc.read().standing[zone] ?? 'ask';
  }

  /** An administrator can impose a ceiling; the user cannot exceed it. */
  setCeiling(zone, mode, { actor = 'admin' } = {}) {
    this.validateZone(zone);
    if (actor !== 'admin') throw new HostError('admin_only', 'only an administrator sets the ceiling');
    if (!MODES.includes(mode)) throw new HostError('bad_mode', `unknown mode ${mode}`);
    this.doc.update((state) => {
      state.ceiling[zone] = mode;
      if (MODE_RANK[state.standing[zone] ?? 'ask'] > MODE_RANK[mode]) state.standing[zone] = mode;
      return state;
    });
    this.audit.record('permission.ceiling_set', { zone, mode, actor });
    return this.doc.read().ceiling[zone];
  }

  /** Changing a standing permission is a user-only decision. */
  setStandingMode(zone, mode, { actor = 'user' } = {}) {
    this.validateZone(zone);
    if (actor !== 'user') {
      this.audit.record('permission.standing_change_blocked', { zone, mode, actor });
      throw new HostError('user_only_decision', 'only the user may change a standing permission');
    }
    if (!MODES.includes(mode)) throw new HostError('bad_mode', `unknown mode ${mode}`);
    const ceiling = this.doc.read().ceiling[zone] ?? 'ask';
    if (MODE_RANK[mode] > MODE_RANK[ceiling]) {
      this.audit.record('permission.ceiling_enforced', { zone, requested: mode, ceiling });
      throw new HostError('ceiling_exceeded', `policy ceiling for ${zone} is ${ceiling}`);
    }
    this.doc.update((state) => {
      state.standing[zone] = mode;
      state.explicit[zone] = true;
      return state;
    });
    this.audit.record('permission.standing_set', { zone, mode, actor });
    return mode;
  }

  /**
   * The gate. Returns one of:
   *   { decision: 'allowed', basis }
   *   { decision: 'blocked', basis }
   *   { decision: 'ask', request }
   */
  authorize({ agent_id, action, target, scope_id, run_id = null, call_id = null, tool = null, input_hash = null, parameters = null, consume = true }) {
    const policy = this.policyFor(action);

    if (policy.default === 'user_only') {
      this.audit.record('permission.blocked', { agent_id, action, target, basis: 'user_only_decision' });
      return { decision: 'blocked', basis: 'user_only_decision', why: policy.why };
    }
    if (policy.require_exact_target && (target === undefined || target === null || target === '')) {
      return { decision: 'blocked', basis: 'exact_target_required', why: 'This action must name its exact target.' };
    }

    const state = this.doc.read();
    const { configured, ceiling, mode } = this.effectivePolicy(action, state);
    const details = { zone: policy.zone, configured, ceiling, effective_mode: mode, run_id, call_id, tool };
    this.audit.record('permission.evaluated', { agent_id, action, target, ...details });

    if (mode === 'never') {
      this.audit.record('permission.blocked', { agent_id, action, target, basis: ceiling === 'never' ? 'ceiling_never' : 'standing_never' });
      return { decision: 'blocked', basis: ceiling === 'never' ? 'ceiling_never' : 'standing_never', why: 'Never is a real block.' };
    }

    // Denials are remembered for the current direction so the agent cannot re-ask.
    if (this.#findDenial(state, { agent_id, action, target, scope_id })) {
      this.audit.record('permission.blocked', { agent_id, action, target, basis: 'denied_earlier' });
      return { decision: 'blocked', basis: 'denied_earlier', why: 'The user already denied this action in this scope.' };
    }

    if (mode === 'always') {
      this.audit.record(consume ? 'permission.allowed' : 'permission.preview_allowed', { agent_id, action, target, ...details, basis: state.explicit?.[policy.zone] ? 'standing_always' : 'default_allow', run_id });
      return { decision: 'allowed', basis: state.explicit?.[policy.zone] ? 'standing_always' : 'default_allow' };
    }

    // A live allow-once grant covers exactly this agent, action, target, and scope.
    const grant = this.#findGrant(state, { agent_id, action, target, scope_id, run_id, call_id, tool, input_hash });
    if (grant) {
      this.audit.record(consume ? 'permission.allowed' : 'permission.preview_allowed', { agent_id, action, target, basis: 'allow_once', grant_id: grant.id, ...details });
      if (consume) this.#consumeGrant(grant.id);
      return { decision: 'allowed', basis: 'allow_once', grant_id: grant.id };
    }

    const existing = Object.values(state.requests).find((r) => r.resolution === null && Date.parse(r.expires_at) > this.clock.now()
      && r.agent_id === agent_id && r.action === action && r.target === target && r.scope_id === scope_id
      && (r.run_id ?? null) === run_id && (r.call_id ?? null) === call_id && (r.tool ?? null) === tool && (r.input_hash ?? null) === input_hash);
    if (existing) return { decision: 'ask', request: existing };
    const request = {
      id: newId('apr'),
      agent_id,
      action,
      target,
      scope_id,
      run_id, call_id, tool, input_hash, parameters,
      effective_mode: mode, ceiling,
      zone: policy.zone,
      why: policy.why,
      high_risk: Boolean(policy.high_risk),
      created_at: this.clock.iso(),
      expires_at: new Date(this.clock.now() + APPROVAL_TTL_MS).toISOString(),
      resolution: null,
    };
    this.doc.update((s) => {
      s.requests[request.id] = request;
      return s;
    });
    this.audit.record('permission.asked', {
      request_id: request.id, agent_id, action, target, scope_id, run_id, call_id, tool, input_hash, expires_at: request.expires_at,
    });
    return { decision: 'ask', request };
  }

  /**
   * The user should see what happened and why: a card can carry the
   * agent's screen at the moment it asked, so the person decides on evidence.
   */
  attachEvidence(requestId, evidence, { run_id = null } = {}) {
    this.doc.update((s) => {
      if (s.requests[requestId]) {
        s.requests[requestId].evidence = evidence;
        if (run_id && !s.requests[requestId].run_id) s.requests[requestId].run_id = run_id;
      }
      return s;
    });
    // The run id lets the drilldown find this evidence after the card is gone.
    this.audit.record('permission.evidence_attached', { request_id: requestId, run_id, screenshot: evidence?.screenshot ?? null });
  }

  pendingRequests() {
    const now = this.clock.now();
    return Object.values(this.doc.read().requests).filter(
      (r) => r.resolution === null && Date.parse(r.expires_at) > now,
    ).map((r) => ({ ...r, ceiling: this.effectivePolicy(r.action).ceiling, effective_mode: this.effectivePolicy(r.action).mode }));
  }

  getRequest(requestId) {
    return this.doc.read().requests[requestId] ?? null;
  }

  requestsForRun(runId) {
    return Object.values(this.doc.read().requests).filter(request => request.run_id === runId);
  }

  /** The four answers to an approval card. Only the user may answer. */
  resolve(requestId, resolution, { actor = 'user' } = {}) {
    if (actor !== 'user') throw new HostError('user_only_decision', 'only the user resolves an approval');
    if (!RESOLUTIONS.includes(resolution)) {
      throw new HostError('bad_resolution', `unknown resolution ${resolution}`);
    }
    const request = this.getRequest(requestId);
    if (!request) throw new HostError('request_not_found', `unknown approval request ${requestId}`);
    if (request.resolution) throw new HostError('already_resolved', 'this approval was already answered');
    if (Date.parse(request.expires_at) <= this.clock.now()) {
      this.doc.update((state) => {
        state.requests[requestId].resolution = 'expired';
        return state;
      });
      this.audit.record('permission.expired', { request_id: requestId, agent_id: request.agent_id, action: request.action });
      return { ok: false, reason: 'expired', request_id: requestId };
    }

    if (resolution === 'allow_once' && this.effectivePolicy(request.action).mode === 'never') {
      this.audit.record('permission.blocked', { request_id: requestId, basis: 'current_policy_never' });
      return { ok: false, reason: 'current_policy_never', request_id: requestId };
    }
    this.doc.update((state) => {
      const stored = state.requests[requestId];
      stored.resolution = resolution;
      stored.resolved_at = this.clock.iso();

      if (resolution === 'allow_once') {
        state.grants.push({
          id: newId('grn'),
          agent_id: stored.agent_id,
          action: stored.action,
          target: stored.target,
          scope_id: stored.scope_id,
          run_id: stored.run_id ?? null, call_id: stored.call_id ?? null, tool: stored.tool ?? null, input_hash: stored.input_hash ?? null,
          expires_at: stored.expires_at,
          created_at: this.clock.iso(),
          consumed: false,
        });
      }
      if (resolution === 'deny') {
        state.denials.push({
          id: newId('den'),
          agent_id: stored.agent_id,
          action: stored.action,
          target: stored.target,
          scope_id: stored.scope_id,
          created_at: this.clock.iso(),
        });
      }
      if (resolution === 'always' || resolution === 'never') {
        const zone = stored.zone;
        const ceiling = state.ceiling[zone] ?? 'ask';
        const wanted = resolution === 'always' ? 'always' : 'never';
        if (MODE_RANK[wanted] > MODE_RANK[ceiling]) {
          stored.resolution = 'ceiling_blocked';
          stored.ceiling = ceiling;
        } else {
          state.standing[zone] = wanted;
          state.explicit[zone] = true;
        }
      }
      return state;
    });

    const stored = this.getRequest(requestId);
    if (stored.resolution === 'ceiling_blocked') {
      this.audit.record('permission.ceiling_enforced', {
        request_id: requestId, requested: resolution, ceiling: stored.ceiling,
      });
      return { ok: false, reason: 'ceiling_exceeded', ceiling: stored.ceiling, request_id: requestId };
    }
    this.audit.record('permission.resolved', {
      request_id: requestId, resolution, agent_id: stored.agent_id, action: stored.action, target: stored.target, actor,
      run_id: stored.run_id ?? null, scope_id: stored.scope_id,
      call_id: stored.call_id ?? null, tool: stored.tool ?? null,
    });
    return { ok: true, resolution, request_id: requestId };
  }

  /**
   * Approvals are retired at scope completion or when a new turn begins.
   * Remembered denials retire with the same scope, which is what stops nagging
   * without turning a denial into a permanent rule.
   */
  retireScope(scopeId) {
    let retired = { grants: 0, denials: 0, requests: 0 };
    this.doc.update((state) => {
      const grantsBefore = state.grants.length;
      state.grants = state.grants.filter((g) => g.scope_id !== scopeId);
      const denialsBefore = state.denials.length;
      state.denials = state.denials.filter((d) => d.scope_id !== scopeId);
      let requests = 0;
      for (const request of Object.values(state.requests)) {
        if (request.scope_id === scopeId && request.resolution === null) {
          request.resolution = 'retired';
          requests += 1;
        }
      }
      retired = { grants: grantsBefore - state.grants.length, denials: denialsBefore - state.denials.length, requests };
      return state;
    });
    if (retired.grants || retired.denials || retired.requests) {
      this.audit.record('permission.scope_retired', { scope_id: scopeId, ...retired });
    }
    return retired;
  }

  retireOtherScopes(agentId, currentScope) {
    const state = this.doc.read();
    const scopes = new Set([...Object.values(state.requests).filter((r) => r.resolution === null), ...state.grants, ...state.denials]
      .filter((r) => r.agent_id === agentId && r.scope_id !== currentScope).map((r) => r.scope_id));
    for (const scope of scopes) this.retireScope(scope);
  }

  auditTrail() {
    return this.audit.where((e) => String(e.type).startsWith('permission.'));
  }

  #findGrant(state, { agent_id, action, target, scope_id, run_id, call_id, tool, input_hash }) {
    return state.grants.find(
      (g) => !g.consumed && g.agent_id === agent_id && g.action === action &&
        g.target === target && g.scope_id === scope_id &&
        (g.run_id ?? null) === run_id && (g.call_id ?? null) === call_id && (g.tool ?? null) === tool && (g.input_hash ?? null) === input_hash &&
        Date.parse(g.expires_at) > this.clock.now(),
    ) ?? null;
  }

  #consumeGrant(grantId) {
    this.doc.update((state) => {
      const grant = state.grants.find((g) => g.id === grantId);
      if (grant) grant.consumed = true;
      return state;
    });
  }

  #findDenial(state, { agent_id, action, target, scope_id }) {
    return state.denials.find(
      (d) => d.agent_id === agent_id && d.action === action &&
        d.target === target && d.scope_id === scope_id,
    ) ?? null;
  }
}
