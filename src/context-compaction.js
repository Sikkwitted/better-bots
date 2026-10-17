// Turn compaction: when one turn's prompt reaches 70% of the model's context
// window, the older steps of that turn are summarised and replaced by the
// summary, and the latest steps are kept exactly as they were. A long tool-heavy
// task can then keep going instead of overflowing the window, which no retry
// can fix. The prior conversation (a short window, see context.js) is untouched;
// only the work inside the running turn is compacted.

export const COMPACT_AT = 0.7;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
const KEEP_STEPS = 2;
const CHARS_PER_TOKEN = 4;
const NOTE_OPEN = '<host_note compacted="true">';
const NOTE_CLOSE = '</host_note>';

export const COMPACT_SYSTEM = `You compress the working history of an AI agent's current task so it can continue with less context.
Write a faithful summary of the steps shown: what the task is, what has been done, what was found (keep exact names, paths, numbers, ids, commands and errors), what was decided, and what remains to do.
Do not invent anything. Do not address the agent as a person. Plain text, under 600 words.`;

/** The context window for an agent: its own setting, then the host's, then a conservative default. */
export function contextWindowFor(profile, env = process.env) {
  const n = Number(profile?.context_window ?? env.BETTER_BOTS_CONTEXT_WINDOW);
  return Number.isFinite(n) && n >= 4_000 ? n : DEFAULT_CONTEXT_WINDOW;
}

/** A provider-free token estimate; images are left out, their size is not text. */
export function estimateTokens(system, messages) {
  const chars = String(system ?? '').length + messages.reduce((sum, m) =>
    sum + JSON.stringify({ ...m, images: undefined, output_items: undefined }).length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Should this prompt be compacted? Reported prompt tokens win; the estimate covers what the report has not seen yet. */
export function needsCompaction({ reportedTokens = 0, system, messages, window }) {
  const tokens = Math.max(reportedTokens, estimateTokens(system, messages));
  return { tokens, threshold: Math.floor(window * COMPACT_AT), due: tokens >= window * COMPACT_AT };
}

/**
 * Split a turn's messages into what stays and what gets summarised. `baseLength`
 * is the rendered conversation plus the request; everything after it is work.
 * Null when there is too little work to compact.
 */
export function splitForCompaction(messages, baseLength) {
  const work = messages.slice(baseLength);
  const steps = work.map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  if (steps.length <= KEEP_STEPS) return null;
  const cut = steps[steps.length - KEEP_STEPS];
  return { base: messages.slice(0, baseLength), older: work.slice(0, cut), recent: work.slice(cut), steps: steps.length - KEEP_STEPS };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The older steps as plain text for the summariser, newest kept when it has to be cut. */
export function renderSteps(older, maxChars) {
  const lines = [];
  for (const m of older) {
    if (m.role === 'assistant') {
      if (m.content) lines.push(`Agent: ${m.content}`);
      for (const c of m.tool_calls ?? []) lines.push(`Tool call ${c.name}: ${clip(JSON.stringify(c.input ?? {}), 600)}`);
    } else if (m.role === 'tool_results') {
      for (const r of m.results ?? []) lines.push(`Result of ${r.name}: ${clip(JSON.stringify(r.output ?? null), 2_000)}`);
    } else if (m.screen_observation) {
      lines.push('[screenshot observed]');
    } else if (m.content) {
      lines.push(`Note: ${clip(String(m.content), 1_000)}`);
    }
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `[earliest steps omitted]\n${text.slice(-maxChars)}` : text;
}

/** The request without any earlier compaction note: each compaction replaces the last one. */
export function stripNote(content) {
  const s = String(content ?? '');
  const at = s.indexOf(NOTE_OPEN);
  return at < 0 ? s : s.slice(0, at).trimEnd();
}

export function previousSummary(content) {
  const s = String(content ?? '');
  const at = s.indexOf(NOTE_OPEN);
  if (at < 0) return null;
  const body = s.slice(at + NOTE_OPEN.length, s.lastIndexOf(NOTE_CLOSE) > at ? s.lastIndexOf(NOTE_CLOSE) : undefined);
  return body.replace(/^\s*Earlier steps of this task were compacted[^\n]*\n/, '').trim() || null;
}

/** The compacted turn: the request carries the summary, the latest steps follow unchanged. */
export function applyCompaction({ base, recent }, summary) {
  const request = base.at(-1);
  const content = `${stripNote(request.content)}\n\n${NOTE_OPEN}\nEarlier steps of this task were compacted to stay within the context window. Summary of the work so far:\n${summary.trim()}\n${NOTE_CLOSE}`;
  return [...base.slice(0, -1), { ...request, content }, ...recent];
}
