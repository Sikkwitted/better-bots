// Continuations belong to the original request; unrelated runs do not.
export function chatTurnIds(runs) {
  const byId = new Map(runs.map(run => [run.id, run]));
  return new Map(runs.map(run => {
    let current = run;
    const seen = new Set([run.id]);
    while (current.payload?.kind === 'continue') {
      const parent = byId.get(current.payload.parent_run_id);
      if (!parent || parent.agent_id !== run.agent_id || seen.has(parent.id)) break;
      seen.add(parent.id); current = parent;
    }
    return [run.id, current.id];
  }));
}
