import path from 'node:path';
import crypto from 'node:crypto';
import { JsonDoc } from '../core/store.js';
import { HostError } from '../core/util.js';
import { PlaceholderDesktop } from './desktop-backend.js';

// One computer, separate screens.
//
// The accurate mental model, stated in code and in describe():
// agents SHARE one sandbox computer; each active agent can be assigned its own
// private desktop WINDOW. A private screen is not a private file system.

export class ComputerService {
  constructor({ dir, clock, audit, computer_id = 'sandbox-1', window_count = 3, vnc_base = 'vnc://sandbox-1', backend = null, shell_isolation = 'process' }) {
    this.clock = clock;
    // The desktop backend draws the monitors; this service only owns who holds which one.
    this.backend = backend ?? new PlaceholderDesktop({ vnc_base });
    this.audit = audit;
    this.computer_id = computer_id;
    this.window_count = window_count;
    this.shell_isolation = shell_isolation;
    this.vnc_base = vnc_base;
    this.doc = new JsonDoc(path.join(dir, 'computer', 'assignments.json'), { assignments: {} });
    this.actions = new Map();
    this.userControllers = new Map();
    this.releases = new Map();
    this.viewers = new Map();
    this.canPark = () => false;
    this.allocation = Promise.resolve();
  }

  /**
   * What is shared and what is separate. The interface should show this rather
   * than implying separate machines.
   */
  describe() {
    return {
      computer_id: this.computer_id,
      window_count: this.window_count,
      desktop: this.backend.kind,
      desktop_note: this.backend.note ?? (this.backend.kind === 'xvfb'
        ? 'Monitors are real X displays on this machine, each with its own loopback VNC endpoint.'
        : 'Monitors are bookkeeping on this host: no display server, so screens record actions but draw nothing.'),
      boundaries: [
        { surface: 'Desktop view', boundary: 'separate per-agent window', private: true },
        { surface: 'VNC connection', boundary: 'separate URL and display token', private: true },
        { surface: 'Window ownership', boundary: 'token tied to the assigned window', private: true },
        { surface: 'Underlying computer', boundary: 'shared sandbox', private: false },
        { surface: 'Files and terminal environment', boundary: 'shared machine state', private: false },
        ['bwrap', 'seatbelt'].includes(this.shell_isolation)
          ? { surface: 'Shell (SandboxRunCommand)', boundary: `${this.shell_isolation === 'bwrap' ? 'per-command kernel namespaces (bubblewrap)' : 'macOS Seatbelt'}: own directory read-write, shared state read-only; host transactions commit shared changes`, private: true }
          : { surface: 'Shell (SandboxRunCommand)', boundary: 'shell disabled: no enforced filesystem boundary available', private: false },
        { surface: 'Agent transcript and profile', boundary: 'separate per-agent storage', private: true },
      ],
      shell_isolation: this.shell_isolation,
      warning: 'A private screen does not imply a private file system. Shared paths need locks or per-agent workspaces.',
    };
  }

  assignments() {
    return Object.values(this.doc.read().assignments);
  }

  /**
   * Assign a free window index. Capacity is real: when every monitor on the shared
   * computer is in use, this returns an explicit failure with fallbacks rather than
   * pretending unlimited parallel browser work exists.
   */
  assignWindow(agentId) {
    let outcome;
    this.doc.update((state) => {
      if (Object.values(state.releasing ?? {}).some(a => a.agent_id === agentId)) {
        outcome = { ok: false, reason: 'screen_releasing', detail: 'The previous screen is still being released; wait for cleanup before opening another.', options: ['queue_the_computer_use_step', 'fall_back_to_non_visual_tools'] };
        return state;
      }
      const existing = state.assignments[agentId];
      if (existing) {
        existing.last_seen = this.clock.iso();
        outcome = { ok: true, reused: true, assignment: existing };
        return state;
      }
      const taken = new Set([...Object.values(state.assignments).map((a) => a.window_index), ...Object.keys(state.releasing ?? {}).map(Number)]);
      let index = -1;
      for (let i = 0; i < this.window_count; i += 1) {
        if (!taken.has(i)) { index = i; break; }
      }
      if (index === -1) {
        outcome = {
          ok: false,
          reason: 'no_monitor_available',
          detail: `every monitor on shared computer ${this.computer_id} is in use`,
          options: ['queue_the_computer_use_step', 'fall_back_to_non_visual_tools', 'reuse_a_released_window', 'tell_the_user_the_screen_is_unavailable'],
        };
        return state;
      }
      const assignment = {
        agent_id: agentId,
        computer_id: this.computer_id,
        window_index: index,
        owner_token: crypto.randomBytes(16).toString('hex'), // a fresh ownership generation
        vnc_url: this.backend.vncUrl(index),
        assigned_at: this.clock.iso(),
        last_seen: this.clock.iso(),
      };
      state.assignments[agentId] = assignment;
      outcome = { ok: true, reused: false, assignment };
      return state;
    });

    if (outcome.ok) {
      this.audit.record('computer.window_assigned', {
        agent_id: agentId, window_index: outcome.assignment.window_index, reused: outcome.reused,
      });
    } else {
      this.audit.record('computer.window_unavailable', { agent_id: agentId, reason: outcome.reason });
    }
    return outcome;
  }

  serial(index, operation) {
    const task = (this.actions.get(index) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.actions.set(index, task);
    return task;
  }

  requestWindow(agentId) {
    const task = this.allocation.catch(() => {}).then(async () => {
      let outcome = this.assignWindow(agentId);
      if (outcome.ok || outcome.reason !== 'no_monitor_available' || !this.backend.supportsParking) return outcome;
      const candidates = this.assignments().sort((a,b) => a.last_seen.localeCompare(b.last_seen));
      for (const candidate of candidates) {
        const id = candidate.agent_id;
        if (this.viewers.get(id) || this.userControllers.has(id) || !this.canPark(id) || this.clock.now() - Date.parse(candidate.last_seen) < 30_000) continue;
        await this.releaseWindow(id, {preserve: true});
        this.audit.record('computer.window_parked', {agent_id:id, for_agent_id:agentId});
        outcome = this.assignWindow(agentId);
        break;
      }
      return outcome.ok ? outcome : {...outcome, detail: `All ${this.window_count} desktop slots are busy, being watched, or were just opened. An unused desktop will be parked automatically when a slot can safely be reused. Try again shortly.`};
    });
    this.allocation = task;
    return task;
  }

  releaseWindow(agentId, {preserve = false} = {}) {
    let released;
    this.doc.update((state) => {
      released = state.assignments[agentId] ?? Object.values(state.releasing ?? {}).find(a => a.agent_id === agentId);
      if (released) {
        if (preserve) released.preserve_profile = true;
        (state.releasing ??= {})[released.window_index] = released;
        delete state.assignments[agentId];
      }
      return state;
    });
    if (!released) return Promise.resolve({ released: false, window_index: null });
    const index = released.window_index;
    if (this.releases.has(index)) return this.releases.get(index);
    const task = this.serial(index, async () => {
      try {
        await this.backend.release(index, released.preserve_profile ? {preserveFor:agentId} : undefined);
        this.doc.update(state => { delete state.releasing[index]; return state; });
        this.audit.record('computer.window_released', { agent_id: agentId, window_index: index });
        return { released: true, window_index: index };
      } catch (error) {
        this.audit.record('computer.release_failed', { agent_id: agentId, window_index: index, error: error.message });
        throw error;
      }
    });
    this.releases.set(index, task);
    task.then(() => this.releases.delete(index), () => this.releases.delete(index));
    return task;
  }

  recoverReleases() {
    return Promise.allSettled(Object.values(this.doc.read().releasing ?? {}).map(a => this.releaseWindow(a.agent_id)));
  }

  /** Ownership token is the assignment boundary. Without it, a window cannot be driven. */
  verifyOwner(agentId, windowIndex, ownerToken) {
    const assignment = this.doc.read().assignments[agentId];
    return Boolean(
      assignment &&
        assignment.window_index === windowIndex &&
        assignment.owner_token === ownerToken,
    );
  }

  /** Any computer-use action goes through here, so window theft is impossible. */
  useWindow(agentId, { window_index, owner_token, action, detail = {} }) {
    if (!this.verifyOwner(agentId, window_index, owner_token)) {
      this.audit.record('computer.window_theft_blocked', {
        agent_id: agentId, window_index, action,
      });
      throw new HostError('window_not_owned', `agent ${agentId} does not own window ${window_index}`);
    }
    this.doc.update((state) => {
      state.assignments[agentId].last_seen = this.clock.iso();
      return state;
    });
    this.audit.record('computer.window_action', { agent_id: agentId, window_index, action, ...detail });
    return { ok: true, computer_id: this.computer_id, window_index, action };
  }

  /** Brings the agent's monitor up for real (or records that it cannot) and reports how to view it. */
  readyWindow(agentId) {
    const assignment = this.doc.read().assignments[agentId];
    if (!assignment) return Promise.reject(new HostError('window_not_owned', `agent ${agentId} holds no window`));
    return this.serial(assignment.window_index, () => this.readyOwnedWindow(agentId, assignment));
  }

  async readyOwnedWindow(agentId, assignment) {
    if (!this.verifyOwner(agentId, assignment.window_index, assignment.owner_token)) throw new HostError('window_not_owned', 'assignment changed before opening the screen');
    const monitor = await this.backend.ensureMonitor(assignment.window_index, {agentId});
    if (!this.verifyOwner(agentId, assignment.window_index, assignment.owner_token)) throw new HostError('window_not_owned', 'assignment changed while opening the screen');
    if (monitor.vnc_url) {
      assignment.vnc_url = monitor.vnc_url;
      this.doc.update((state) => { state.assignments[agentId].vnc_url = monitor.vnc_url; return state; });
    }
    return { ...assignment, live: monitor.real, ...(monitor.view ? { view: monitor.view } : {}) };
  }

  /**
   * The computer-use accessor: the ownership gate above runs first, so
   * the backend never sees a call from an agent that does not hold the window.
   */
  performWindowAction(agentId, args) {
    return this.serial(args.window_index, () => this.performOwnedAction(agentId, args));
  }

  async performOwnedAction(agentId, args) {
    args.signal?.throwIfAborted();
    if (this.userControllers.has(agentId) && args.action !== 'screenshot') throw new HostError('desktop_user_control', 'The user is controlling this desktop. Wait until they return control before using it.');
    const gate = this.useWindow(agentId, args);
    let outcome;
    try {
      outcome = await this.backend.perform(args.window_index, args.action, args.detail ?? {}, { signal: args.signal });
    } catch (err) {
      this.audit.record('computer.window_action_failed', { agent_id: agentId, window_index: args.window_index, action: args.action, error: err.message });
      return { ...gate, ok: false, error: 'screen_action_failed', message: err.message };
    }
    if (!this.verifyOwner(agentId, args.window_index, args.owner_token)) throw new HostError('window_not_owned', 'assignment changed during the screen action');
    if (outcome.screenshot) {
      this.doc.update((state) => {
        if (state.assignments[agentId]) state.assignments[agentId].last_screenshot = outcome.screenshot;
        return state;
      });
    }
    return { ...gate, ...outcome };
  }
}
