// What each AI provider is, where its key comes from, and in what order to show them.
// The host knows provider ids and wire formats; a person needs to know what to do.

/** Providers the interface does not offer. None: every provider the host knows is configurable here. */
export const HIDDEN_PROVIDERS = new Set();

const ORDER = ['anthropic', 'codex', 'openai', 'openrouter', 'deepseek', 'glm', 'atria', 'local'];

export const PROVIDER_COPY = {
  anthropic: {
    title: 'Anthropic (Claude)',
    blurb: 'Claude models. Uses an API key from the Anthropic Console and is billed per use.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'A Claude Pro or Max login can’t be used here: Anthropic only allows those inside its own apps. An API key works.',
    // Suggested model IDs. Once a key is saved, the provider’s real list replaces the need for these.
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
  },
  codex: {
    title: 'ChatGPT (your subscription)',
    note: 'Unofficial: this signs in the way OpenAI’s Codex CLI does. OpenAI can change or block it at any time, and using it may break their terms for your account. An OpenAI API key is the supported route.',
  },
  openai: {
    title: 'OpenAI (API key)',
    blurb: 'GPT models. Uses an API key and is billed per use.',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    title: 'OpenRouter',
    blurb: 'One key for many providers’ models, including free ones.',
    keyUrl: 'https://openrouter.ai/keys',
  },
  deepseek: {
    title: 'DeepSeek',
    blurb: 'DeepSeek models. Uses an API key.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  glm: { title: 'Z.ai (GLM)', blurb: 'GLM models from Z.ai. Uses an API key.' },
  atria: { title: 'Atria', blurb: 'Atria’s hosted preview models. Uses the key your account was issued.' },
  local: { title: 'On this computer (Ollama)', blurb: 'Models running on this computer through Ollama. No key, nothing leaves your machine.' },
};

/** Hidden providers removed; the common ones first in a sensible order; operator-added ones last. */
export function orderProviders(providers) {
  const rank = (p) => { const i = ORDER.indexOf(p.id); return i === -1 ? ORDER.length : i; };
  return providers.filter((p) => !HIDDEN_PROVIDERS.has(p.id)).sort((a, b) => rank(a) - rank(b));
}

export const providerTitle = (provider) => PROVIDER_COPY[provider.id]?.title ?? provider.label;

/** Suggested models that are not already added or already discovered for this provider. */
export function missingSuggestions(providerId, added = [], discovered = []) {
  const have = new Set([...added.map((m) => m.id), ...discovered.filter((m) => m.provider === providerId).map((m) => m.id)]);
  return (PROVIDER_COPY[providerId]?.models ?? []).filter((m) => !have.has(m.id));
}
