// The host owns time, not the model. An injectable clock lets
// approval expiry and rate limits be tested deterministically.

export const systemClock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** A controllable clock for tests and replay. */
export function fixedClock(startMs = Date.UTC(2026, 7, 25, 12, 0, 0)) {
  let t = startMs;
  return {
    now: () => t,
    iso: () => new Date(t).toISOString(),
    advance(ms) {
      t += ms;
      return t;
    },
  };
}
