import { ModelAdapter } from './adapter.js';

/**
 * A deterministic adapter used by the demo and the acceptance tests.
 *
 * It exists to prove the design's central claim: the host owns orchestration, so
 * the whole system runs, restarts, interrupts, and audits correctly with a model
 * that has no intelligence at all. Swap in AnthropicAdapter and nothing else moves.
 *
 * @param script (ctx) => ModelEvent[]  where ctx = { agent_id, messages, tools, payload }
 */
export class ScriptedAdapter extends ModelAdapter {
  constructor(script, { provider = 'scripted', model = 'scripted-1' } = {}) {
    super({ provider, model });
    this.script = script;
    this.calls = [];
  }

  async *stream(messages, tools, settings = {}) {
    // A cancellation applies to one stream, not to the adapter for all time.
    // Without this reset an interrupted run leaves every later turn silently empty.
    settings.signal?.throwIfAborted();
    this._cancelled = null;
    const ctx = { messages, tools, settings, agent_id: settings.agent_id, payload: settings.payload };
    this.calls.push(ctx);
    this._usage.calls += 1;
    const produced = this.script(ctx);
    // A script may return an array of events or an async generator, which is how
    // tests hold a run open long enough to interrupt it.
    if (produced && typeof produced[Symbol.asyncIterator] === 'function') {
      for await (const event of produced) {
        if (settings.signal ? settings.signal.aborted : this._cancelled) return;
        if (event.type === 'text') this._usage.output_tokens += Math.ceil(event.text.length / 4);
        yield event;
      }
    } else {
      for (const event of (await produced) ?? []) {
        if (settings.signal ? settings.signal.aborted : this._cancelled) return;
        if (event.type === 'text') this._usage.output_tokens += Math.ceil(event.text.length / 4);
        yield event;
      }
    }
    // A cancelled stream does not report a normal end of turn.
    if (settings.signal ? settings.signal.aborted : this._cancelled) return;
    // A scripted turn is free, but the shape is the real one so the host's sums are exercised.
    yield { type: 'usage', usage: { ...this.reportUsage(), call: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    yield { type: 'done', stop_reason: 'end_turn' };
  }
}
