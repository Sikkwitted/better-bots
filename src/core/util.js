import { randomUUID } from 'node:crypto';

/** Stable, opaque identifiers. Messages are addressed by ID, never by display name. */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function clampText(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? { text: s, truncated: false } : { text: s.slice(0, max), truncated: true };
}

/** Cheap lexical overlap score, used only to rank memory for a budgeted recall. */
export function overlapScore(query, text) {
  if (!query) return 0;
  const terms = new Set(
    String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2),
  );
  if (terms.size === 0) return 0;
  const words = new Set(
    String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
  let hits = 0;
  for (const t of terms) if (words.has(t)) hits += 1;
  return hits / terms.size;
}

export class HostError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.details = details;
  }
}
