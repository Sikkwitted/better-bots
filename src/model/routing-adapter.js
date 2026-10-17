import { ModelAdapter } from './adapter.js';

// The host holds one adapter. Agents can be pinned to different providers, so
// something has to choose per turn — and that choice must not leak
// into memory, messaging, meetings, or permissions. This is that seam: it looks
// like one adapter to the host and delegates by settings.provider.

export class RoutingAdapter extends ModelAdapter {
  /**
   * @param routes  { [provider]: ModelAdapter }
   * @param fallback provider used when an agent pins nothing
   */
  constructor({ routes, fallback = 'anthropic', default_model = null, catalog = null }) {
    const base = routes[fallback] ?? Object.values(routes)[0];
    super({ provider: 'routed', model: default_model ?? base?.model ?? null });
    this.routes = routes;
    this.fallback = fallback;
    this.default_model = default_model;
    this.catalog = catalog;
    this.lastUsed = null;
  }

  #pick(provider) {
    const chosen = this.routes[provider];
    if (!chosen) throw new Error(`no adapter for provider ${provider}`);
    return chosen;
  }

  async *stream(messages, tools, settings = {}) {
    if (settings.model && !settings.provider) throw new Error('A provider is required for a pinned model; choose its provider in agent settings.');
    const provider = settings.provider ?? this.fallback;
    const adapter = this.#pick(provider);
    this.lastUsed = adapter;
    this._usage.calls += 1;
    // An unpinned agent inherits the host default model as well as its provider,
    // so a GLM fallback never asks Z.ai for a Claude model id.
    // Legacy profiles also use an empty string for an unpinned model.
    let model = (settings.model === '' ? null : settings.model) ?? (settings.provider ? null : this.default_model) ?? adapter.model;
    if (!model && this.catalog) {
      const available = (await this.catalog.list({ provider })).models.filter((m) => m.provider === provider && !m.stale);
      model = available.find((m) => m.is_default)?.id ?? (available.length === 1 ? available[0].id : null);
    }
    if (!model) throw new Error(`Choose a model for ${provider} in agent settings, or set BETTER_BOTS_DEFAULT_PROVIDER and BETTER_BOTS_DEFAULT_MODEL.`);
    yield { type: 'model_selected', provider, model };
    yield* adapter.stream(messages, tools, { ...settings, provider, ...(model ? { model } : {}) });
  }

  normalizeToolCall(call) {
    return (this.lastUsed ?? this.#pick(this.fallback)).normalizeToolCall(call);
  }

  /** Usage is per provider, so report it that way rather than summing apples. */
  reportUsage() {
    const by = {};
    const classes = new Set();
    for (const [provider, adapter] of Object.entries(this.routes)) {
      const report = adapter.reportUsage();
      by[provider] = report;
      // A route that never carried traffic reports unknown; it does not
      // contaminate the aggregate class. Any real observation counts.
      if (report.calls > 0 || report.provenance !== 'unknown') classes.add(report.provenance);
    }
    const provenance = classes.size === 0 ? 'unknown' : (classes.size === 1 ? [...classes][0] : 'mixed');
    return { provider: 'routed', calls: this._usage.calls, by_provider: by, provenance, authoritative: false };
  }

  /** An interruption applies to the turn in flight, so only that adapter. */
  cancel(reason) {
    super.cancel(reason);
    return this.lastUsed?.cancel(reason) ?? { cancelled: true, reason };
  }
}
