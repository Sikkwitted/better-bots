/** Admit due schedules every tick, even while another run waits for approval. */
export function startAutomationTicker({ host, intervalMs = 15_000, onError = console.error }) {
  let draining = null;
  const tick = () => {
    void host.memory.retention.kick().catch(onError);
    if (process.env.BETTER_BOTS_CONSOLIDATE !== 'off') void host.consolidateMemory?.().catch(onError);
    try {
      const fired = host.tickAutomations();
      if (fired.length && !draining) {
        draining = Promise.resolve().then(() => host.drain()).catch(onError)
          .finally(() => { draining = null; });
      }
      return fired;
    } catch (error) { onError(error); return []; }
  };
  const timer = setInterval(tick, intervalMs);
  return { tick, stop: () => clearInterval(timer), get running() { return draining; } };
}
