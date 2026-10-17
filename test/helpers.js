import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';

// Tests never draw on a real display, even on a host that has one. The desktop
// backend is chosen by environment, so pin it before any Host is built.
process.env.BETTER_BOTS_DESKTOP ??= 'placeholder';
// Nor do they pick up a real ChatGPT sign-in from the developer's machine.
process.env.BETTER_BOTS_CODEX_AUTH_FILE ??= '/nonexistent/better-bots-test-codex-auth.json';

export function tmpDir(label = 'better-bots') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

/**
 * A test script describes the FIRST model step of a turn. The host feeds tool
 * results back for up to MAX_MODEL_STEPS, and a real model would then summarise
 * rather than re-issue the same call, so that is what oneStep() does here.
 */
export function oneStep(fn) {
  return (ctx) => (isToolFollowUp(ctx) ? [say('done')] : fn(ctx));
}

export function isToolFollowUp(ctx) {
  return ctx.messages?.at(-1)?.role === 'tool_results';
}

/**
 * A host with a deterministic clock and a scripted model. Permission defaults
 * are Linux's on every machine, so the suite means the same thing on a Mac;
 * the macOS sandbox default has its own test.
 */
export function makeHost({ dir = tmpDir(), script = () => [], clock = fixedClock(), window_count = 3, platform = 'linux' } = {}) {
  const adapter = new ScriptedAdapter(oneStep(script));
  const host = new Host({ dir, adapter, clock, window_count, platform });
  return { host, adapter, clock, dir };
}

/** Reopen the same directory with a fresh process-equivalent host. */
export function reopenHost({ dir, script = () => [], clock = fixedClock(), window_count = 3, platform = 'linux' }) {
  const adapter = new ScriptedAdapter(oneStep(script));
  return { host: new Host({ dir, adapter, clock, window_count, platform }), adapter };
}

export function makeGate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

export function say(text) {
  return { type: 'text', text };
}

export function call(name, input) {
  return { type: 'tool_call', id: `tc_${name}`, name, input };
}
