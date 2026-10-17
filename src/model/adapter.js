// The model layer.
//
// The orchestration contract is provider-neutral. The host must be able to replace
// an adapter without rewriting memory, messaging, meetings, or permissions, so
// nothing below imports a service.
//
//   ModelAdapter
//     stream(messages, tools, settings)   -> AsyncIterable<ModelEvent>
//     normalize_tool_call(call)           -> { id, name, input }
//     report_usage()                      -> usage record (labelled as an estimate
//                                            unless it is authoritative billing data)
//     cancel(reason)                      -> maps to scheduler interruption

/**
 * @typedef {{type:'text', text:string}
 *          |{type:'tool_call', id:string, name:string, input:object}
 *          |{type:'usage', usage:object}
 *          |{type:'done', stop_reason:string}} ModelEvent
 */

export class ModelAdapter {
  constructor({ provider, model }) {
    this.provider = provider;
    this.model = model;
    this._usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
    // Per-call usage identity and provenance: one final record per call, so an
    // estimate can never be double-added to the provider's own report.
    this._callSession = Math.random().toString(36).slice(2, 10);
    this._callSeq = 0;
    this._provenances = [];
    this._cancelled = null;
  }

  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error('stream() must be implemented by a provider adapter');
  }

  /** Every provider shape collapses to one tool-call shape before execution. */
  normalizeToolCall(call) {
    const input = call.input ?? call.arguments ?? call.parameters ?? {};
    return {
      id: call.id ?? call.tool_call_id ?? call.call_id ?? null,
      name: call.name ?? call.function?.name ?? null,
      input: typeof input === 'string' ? safeParse(input) : input,
    };
  }

  /** A stable unique id for one model call, shared by everything that call reports. */
  nextCallId() {
    return `call_${this._callSession}_${(++this._callSeq).toString(36)}`;
  }

  /**
   * Record one call's final usage exactly once. The provenance class travels
   * with the numbers: `provider_reported` when the provider sent token counts,
   * `estimated` when only a local estimate exists, `unknown` when neither.
   * None of these are billing figures, so `reportUsage()` keeps
   * `authoritative: false` regardless of class.
   */
  noteUsage({ provenance = 'unknown', call = {} }) {
    this._usage.input_tokens += call.input_tokens ?? 0;
    this._usage.output_tokens += call.output_tokens ?? 0;
    this._usage.cache_read_input_tokens = (this._usage.cache_read_input_tokens ?? 0) + (call.cache_read_input_tokens ?? 0);
    this._usage.cache_creation_input_tokens = (this._usage.cache_creation_input_tokens ?? 0) + (call.cache_creation_input_tokens ?? 0);
    this._provenances.push(provenance);
  }

  reportUsage() {
    const seen = this._provenances;
    const provenance = seen.length === 0 ? 'unknown' : (seen.every((p) => p === seen[0]) ? seen[0] : 'mixed');
    // The note must agree with the class: provider-reported counts are not
    // "estimated", and nothing here is ever billing data.
    const notes = {
      provider_reported: PROVIDER_REPORTED_NOTE,
      estimated: 'Estimated usage reported by the adapter, not authoritative billing data.',
      mixed: 'Totals mix provider-reported and estimated calls; not authoritative billing data.',
      unknown: 'No usage recorded yet; these counts are not authoritative billing data.',
    };
    return {
      provider: this.provider,
      model: this.model,
      ...this._usage,
      provenance,
      authoritative: false,
      note: notes[provenance],
    };
  }

  /** Provider cancellation maps onto scheduler interruption. */
  cancel(reason) {
    this._cancelled = reason;
    return { cancelled: true, reason };
  }

  get cancelled() {
    return this._cancelled;
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/** A usable token count: a finite, non-negative number. Anything else is absent. */
export function tokenValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Whether a provider frame carries at least one usable (non-negative) count. */
export function hasTokenData(obj, keys) {
  return keys.some((key) => typeof obj?.[key] === 'number' && Number.isFinite(obj[key]) && obj[key] >= 0);
}

export const PROVIDER_REPORTED_NOTE = 'Provider-reported token counts, not authoritative billing data.';
