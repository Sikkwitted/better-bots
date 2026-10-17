import fs from 'node:fs';
import path from 'node:path';
import { logDiagnostics } from './store.js';

// The box is meant to run unattended with the laptop shut, so there has to be a
// way to ask "are you sick?" without opening the console, and a way for it to
// say so without being asked. Both live here.
//
// /healthz is deliberately token-free and carries no secrets, no model IDs, and
// no transcript content: only enough for an uptime monitor to tell healthy from
// degraded. Everything richer stays behind the token under /api.

// Failure classes an unattended box actually hits. These are real audit event
// types emitted elsewhere in the host; if one is renamed, its count simply
// reads zero here rather than breaking the endpoint.
const ERROR_EVENTS = [
  'run.model_failed',        // provider auth, overload, or a bad route
  'memory.engine_failed',    // remote retention failed
  'computer.release_failed', // a monitor would not come down
];
const WARN_EVENTS = [
  'computer.window_action_failed',
  'integration.failed',
  'integration.sign_in_failed',
  'integration.refresh_failed',
  'room.recovery_failed',
  'preview.cleanup_failed',
  'memory.engine_fallback',
];

const DEFAULT_WINDOW_MS = 15 * 60_000; // only recent failures count as "sick"
const BACKUP_STALE_MS = 48 * 3600_000;  // a nightly backup that stopped running

/** deploy/backup.sh records each night's outcome in the state folder. A host
 * with no scheduled backup has no file and no signal. */
function backupSignal(dir, now) {
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(dir, 'backup-status.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (report.result !== 'complete') return {type:'backup_failed', n:1};
  return now - Date.parse(report.at) <= BACKUP_STALE_MS ? null : {type:'backup_stale', n:1};
}
const DEFAULT_AUDIT_TAIL = 400;        // bounded read; the window is what matters

/**
 * One health snapshot. Cheap to call: a bounded audit tail plus a few service
 * status calls that already back the console. Never throws.
 */
export function healthSnapshot({
  host,
  live = false,
  startedAt = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  auditTail = DEFAULT_AUDIT_TAIL,
  now = Date.now(),
}) {
  let failedChecks = 0;
  const read = (fn, fallback) => {
    try { return fn(); } catch { failedChecks++; return fallback; }
  };
  const recent = read(() => host.audit.tail(auditTail).filter(e => e.at && Date.parse(e.at) >= now - windowMs), []);
  const runs = read(() => host.scheduler.durableRuns(), []);
  const reconciliation = read(() => host.reconciliation.list(), []);
  const unfinished = read(() => host.memory.retention.status().unfinished ?? [], []);
  const corruption = read(() => logDiagnostics(host.dir), []);
  const backup = read(() => backupSignal(host.dir, now), null);
  const counts = {
    agents: read(() => host.registry.list().length, null),
    active_runs: runs.filter(r => r.status === 'running').length,
    pending_approvals: read(() => host.permissions.pendingRequests().length, null),
    monitors_assigned: read(() => host.computer.assignments().length, null),
  };
  const recovery = runs.filter(r => r.status === 'recovery_required').length;
  const failedRetention = unfinished.filter(j => ['retryable', 'blocked', 'reconciliation_required'].includes(j.status)).length;
  // Held work waits for the operator's consent to a new engine; it is not stalled.
  const stalledRetention = unfinished.filter(j => !['retryable', 'blocked', 'reconciliation_required', 'held'].includes(j.status)
    && j.created_at && now - Date.parse(j.created_at) > windowMs).length;
  const count = type => recent.filter(e => e.type === type).length;
  const errors = ERROR_EVENTS.map(type => ({type, n:count(type)})).filter(e => e.n > 0);
  const warns = WARN_EVENTS.map(type => ({type, n:count(type)})).filter(e => e.n > 0);
  const state = [
    recovery && {type:'recovery_required', n:recovery},
    corruption.length && {type:'log_corruption', n:corruption.length},
    failedRetention && {type:'memory_retention_failed', n:failedRetention},
    stalledRetention && {type:'memory_retention_stalled', n:stalledRetention},
    host.memoryRequired && !host.memory.engine && {type:'memory_engine_missing', n:1},
    backup,
    failedChecks && {type:'health_check_failed', n:failedChecks},
  ].filter(Boolean);
  return {
    status: errors.length || state.length ? 'degraded' : 'ok',
    at: new Date(now).toISOString(),
    uptime_seconds: Math.max(0, Math.round((now - startedAt) / 1000)),
    live,
    window_ms: windowMs,
    signals: {errors, warns, state, reconciliation_open:reconciliation.length, retention_unfinished:unfinished.length},
    counts,
  };
}

// Probe the actual dependency even on a quiet host. Cache/coalesce requests so an
// unauthenticated uptime endpoint cannot flood Hindsight. Never expose errors,
// URLs, credentials or provider response bodies. A changed engine invalidates it.
const memoryProbes = new WeakMap();
export async function checkedHealthSnapshot(options) {
  const {host, now = Date.now()} = options;
  const engine = host.memory.engine;
  let healthy = true;
  if (engine) {
    let probe = memoryProbes.get(host);
    if (!probe || probe.engine !== engine || (!probe.pending && now >= probe.expires)) {
      probe = {engine, pending:true, expires:0};
      probe.promise = (async () => {
        let timer;
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => engine.health()),
            new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('memory health timeout')), 5000);}),
          ]);
          return ['healthy', 'ok'].includes(result?.status) && result?.database === 'connected';
        } catch { return false; }
        finally { clearTimeout(timer); probe.pending = false; probe.expires = now + 30_000; }
      })();
      memoryProbes.set(host, probe);
    }
    healthy = await probe.promise;
  }
  const snapshot = healthSnapshot(options);
  snapshot.dependencies = { memory: { required: Boolean(host.memoryRequired), configured: Boolean(engine), healthy: Boolean(engine && healthy) } };
  if (!healthy) {
    snapshot.status = 'degraded';
    snapshot.signals.state.push({type:'memory_engine_unavailable', n:1});
  }
  return snapshot;
}

/** A stable fingerprint of *which* faults are present, so a persistent fault
 * is not re-spammed. Counts are deliberately excluded: a fault going from one
 * failure to two is the same fault, still failing. A new fault *type* is the
 * only thing that earns an immediate repeat notice. */
export function healthSignature(snapshot) {
  const s = snapshot?.signals;
  if (!s) return 'none';
  return [
    s.errors.map((e) => e.type).join(','),
    s.state.map((e) => e.type).join(','),
  ].join('|');
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;

/**
 * Posts a health snapshot to BETTER_BOTS_NOTIFY_WEBHOOK when the host is degraded.
 * Inert unless that env var is set, and it never lets a broken or slow webhook
 * affect the host: the send is fire-and-forget and every failure is swallowed.
 * Returns null when disabled, so callers need not special-case it.
 */
export function startHealthNotifier({
  host,
  live = false,
  startedAt = Date.now(),
  webhook = process.env.BETTER_BOTS_NOTIFY_WEBHOOK,
  intervalMs = DEFAULT_INTERVAL_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  retryMs = 5_000,
  post = defaultPost,
  now = Date.now,
}) {
  if (!webhook || !/^https?:\/\//.test(webhook)) return null;

  let lastSignature = null;
  let lastNotify = -Infinity;
  let sending = false;
  let failures = 0;
  let retryAt = -Infinity;
  const snapshot = () => checkedHealthSnapshot({ host, live, startedAt, now: now() });

  const tick = async () => {
    if (sending || now() < retryAt) return;
    sending = true;
    try {
      const current = await snapshot();
      if (current.status !== 'degraded') {
        lastSignature = null;
        failures = 0;
        return;
      }
      const signature = healthSignature(current);
      const t = now();
      // Re-notify on a new fault at once; on a persistent one, at most per cooldown.
      if (signature === lastSignature && t - lastNotify < cooldownMs) return;
      await post(webhook, current);
      lastSignature = signature;
      lastNotify = now();
      failures = 0;
      retryAt = -Infinity;
    } catch {
      // A broken or slow webhook must never affect the host it is watching.
      retryAt = now() + Math.min(60_000, retryMs * 2 ** Math.min(failures++, 4));
    } finally { sending = false; }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.(); // monitoring must not keep the host alive on its own
  return { tick, stop: () => clearInterval(timer) };
}

async function defaultPost(webhook, snapshot) {
  // A short, plain-text body so it reads well in a chat or email gateway.
  const lines = [
    `Better Bots is degraded`,
    ``,
    ...snapshot.signals.errors.map((e) => `error: ${e.type} (x${e.n})`),
    ...snapshot.signals.state.map((e) => `error: ${e.type} (x${e.n})`),
    ...(snapshot.signals.warns.map((e) => `warn:  ${e.type} (x${e.n})`)),
    ``,
    `uptime ${snapshot.uptime_seconds}s · agents ${snapshot.counts.agents} · monitors ${snapshot.counts.monitors_assigned}`,
  ];
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n'), status: snapshot.status, at: snapshot.at }),
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Health notification failed (HTTP ${response.status})`);
}
