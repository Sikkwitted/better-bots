// Token observations are not billing statements, including provider-reported ones.
export const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const confidence = { unknown: 0, estimated: 1, provider_reported: 2 };

export function recordUsage(records, id, observation) {
  const provenance = Object.hasOwn(confidence, observation.provenance) ? observation.provenance : 'unknown';
  if (confidence[records.get(id)?.provenance] > confidence[provenance]) return;
  const call = Object.fromEntries(TOKEN_FIELDS.map(key => {
    const n = Number(observation.call?.[key] ?? 0);
    return [key, Number.isFinite(n) && n >= 0 ? n : 0];
  }));
  records.set(id, { ...call, provenance, authoritative: false });
}

export function totalUsage(observations) {
  const result = { ...Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0])), calls: 0, provenance: 'unknown', authoritative: false };
  const classes = new Set();
  for (const row of observations) {
    for (const key of TOKEN_FIELDS) result[key] += row[key] ?? 0;
    result.calls += row.calls ?? 1;
    classes.add(row.provenance ?? 'unknown');
  }
  result.provenance = classes.size > 1 ? 'mixed' : [...classes][0] ?? 'unknown';
  return result;
}
