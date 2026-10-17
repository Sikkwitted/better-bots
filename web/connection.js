/** Retry reads only. Mutations must never be replayed after an uncertain reply. */
export async function retryRead(read, { onError = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let delay = 500;
  for (;;) {
    try { return await read(); }
    catch (error) { onError(error); await wait(delay); delay = Math.min(10_000, delay * 2); }
  }
}
