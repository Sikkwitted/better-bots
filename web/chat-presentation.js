// Presentation only: saved text and tool receipts remain unchanged.
export function withApprovalStatus(run, approvals = []) {
  if (!run) return run;
  const request = approvals.find(request => request.run_id === run.id);
  return request ? { ...run, phase: 'approval', approval_request_id: request.id } : run;
}

export function roomProgress(room, agents = [], approvals = [], desks = []) {
  const discussion = room?.discussion;
  if (discussion?.status !== 'active') return null;
  for (const [round, speakers] of Object.entries(discussion.rounds ?? {})) {
    const id = speakers.find(id => !discussion.turns?.[`${round}:${id}`]);
    if (!id) continue;
    const agent = agents.find(agent => agent.id === id);
    const name = agent?.name ?? id;
    const approval = approvals.find(request => request.run_id === agent?.active_run?.id);
    if (approval) return { text: `Waiting for ${name}: a permission request must be answered before this member can continue.`, agent_id: id, approval_request_id: approval.id };
    if (desks.some(desk => desk.name === (agent?.desk ?? '') && desk.enabled === false)) return { text: `${name} cannot join while their desk is paused.`, agent_id: id };
    const active = agent?.active_run;
    if (active && (active.payload?.room_id !== room.id || active.payload?.epoch !== room.epoch)) return { text: `Waiting for ${name} to finish another turn. This room discussion is queued.`, agent_id: id };
    return { text: active ? `${name} is responding to the room.` : `Waiting for ${name} to join the discussion.`, agent_id: id };
  }
  return { text: 'Starting the room discussion.' };
}

export function presentChatEntries(entries, activeRun = null) {
  const workingRuns = new Set(activeRun?.id ? [activeRun.turn_id ?? activeRun.id] : []);
  const presented = entries.toReversed().map(entry => {
    const turn = entry.turn_id ?? entry.run_id;
    if (turn && ['tool_call', 'approval_pending'].includes(entry.kind)) workingRuns.add(turn);
    if (entry.kind === 'agent_text' && turn && !entry.result_id && workingRuns.has(turn)) {
      return {...entry, kind: 'agent_progress'};
    }
    return entry;
  }).reverse();
  // Providers may emit several text blocks for the final reply. A bot's own chat
  // shows one line per room it took part in, not one per round.
  return presented.reduce((result, entry) => {
    const last = result.at(-1);
    if (entry.kind === 'system_note' && entry.room_id && last?.kind === 'system_note' && last.room_id === entry.room_id) {
      result[result.length - 1] = entry;
    } else if (entry.kind === 'agent_text' && last?.kind === 'agent_text' && entry.run_id && entry.run_id === last.run_id && entry.result_id === last.result_id) {
      result[result.length - 1] = {...last, text: `${last.text}\n\n${entry.text}`};
    } else result.push(entry);
    return result;
  }, []);
}

/** A finished turn with no thoughts and no tool steps would fold to an empty "Reasoning" row. */
export function hasVisibleWork(entries) {
  return entries.some(e => ['tool_call', 'tool_result', 'approval_pending', 'system_note'].includes(e.kind) || (e.kind === 'reasoning' && Boolean(e.text?.trim())));
}

export function groupChatActivity(entries) {
  const groups = [];
  for (const entry of entries) {
    const work = ['tool_call', 'tool_result', 'agent_progress', 'reasoning', 'approval_pending'].includes(entry.kind) || (entry.kind === 'system_note' && Boolean(entry.run_id) && !entry.room_id && !entry.recovery_required && !entry.report_id && !entry.text?.startsWith('Stopped:'));
    const last = groups.at(-1);
    const run = entry.turn_id ?? entry.run_id ?? (entry.kind === 'reasoning' ? entry.stream_id?.split(':')[0] : null);
    if (work && last?.work && (!run || !last.run || run === last.run)) {
      last.entries.push(entry); last.run ??= run;
    } else groups.push({work, run, entries:[entry]});
  }
  return groups;
}
