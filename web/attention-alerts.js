// Desktop notifications for the moments a person is waiting on: a bot finished
// the turn they asked for, or a bot needs them (an approval card, a stuck card).
// The tab title already says this; a notification reaches someone who has
// switched to another window. This file only decides WHAT to announce, from
// two consecutive /api/state snapshots, so it can be tested without a browser.

/** The parts of the console state that announcements are computed from. */
export function attentionSnapshot(state) {
  return {
    agents: (state.agents ?? []).map((a) => ({ id: a.id, name: a.name, run: a.active_run ? { id: a.active_run.id, lane: a.active_run.lane } : null })),
    approvals: (state.approvals ?? []).map((r) => ({ id: r.id, agent_id: r.agent_id, request: r })),
    blocked: (state.blocked ?? []).filter((b) => !b.resolved_at).map((b) => ({ id: b.id, agent_id: b.agent_id, detail: b.detail ?? b.reason ?? '' })),
    attention: (state.approvals?.length ?? 0) + (state.blocked ?? []).filter((b) => !b.resolved_at).length,
  };
}

/**
 * What changed between two snapshots that deserves a notification.
 * The first snapshot after loading announces nothing: it is history, not news.
 */
export function attentionChanges(previous, next, { describeApproval = (r) => r.tool ?? r.action } = {}) {
  if (!previous) return [];
  const name = (id) => next.agents.find((a) => a.id === id)?.name ?? previous.agents.find((a) => a.id === id)?.name ?? 'A bot';
  const out = [];
  const seenApprovals = new Set(previous.approvals.map((r) => r.id));
  for (const r of next.approvals) {
    if (seenApprovals.has(r.id)) continue;
    out.push({ key: `approval:${r.id}`, agent_id: r.agent_id, title: `${name(r.agent_id)} needs your approval`, body: clip(describeApproval(r.request)) || 'An action is waiting for you.' });
  }
  const seenBlocked = new Set(previous.blocked.map((b) => b.id));
  for (const b of next.blocked) {
    if (seenBlocked.has(b.id)) continue;
    out.push({ key: `blocked:${b.id}`, agent_id: b.agent_id, title: `${name(b.agent_id)} is stuck`, body: clip(b.detail) || 'It needs you to take a look.' });
  }
  // Only a turn the person asked for: background routines finishing are not a summons.
  for (const before of previous.agents) {
    if (before.run?.lane !== 'user') continue;
    const now = next.agents.find((a) => a.id === before.id);
    if (now && now.run?.id === before.run.id) continue;
    out.push({ key: `finished:${before.run.id}`, agent_id: before.id, title: `${name(before.id)} finished`, body: 'The reply is ready.' });
  }
  return out;
}

function clip(text, max = 140) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
