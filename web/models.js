// Provider protocols are configuration; model IDs come from each provider's
// catalog. Keep the provider alongside the raw ID: subscription and API access
// to the same model are different routes, with different billing.

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    base_url: null,            // the SDK default
    key_env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  },
  // Z.ai speaks Anthropic's wire format, so the same adapter reaches it with
  // nothing but a different base URL and token.
  glm: {
    label: 'Z.ai (GLM)',
    base_url: 'https://api.z.ai/api/anthropic',
    key_env: ['GLM_API_KEY', 'ZAI_API_KEY'],
  },
  // Everything below is OpenAI-shaped, so the same adapter reaches all of them
  // — adding a provider is an entry here, not code.
  openai: {
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    key_env: ['OPENAI_API_KEY'],
    wire: 'openai',
  },
  openrouter: {
    label: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    key_env: ['OPENROUTER_API_KEY'],
    wire: 'openai',
  },
  deepseek: {
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    key_env: ['DEEPSEEK_API_KEY'],
    wire: 'openai',
  },
  // Atria's hosted preview models. OpenAI-shaped like the rest, reached with
  // the GLMMODELS_API_KEY the account is issued.
  atria: {
    label: 'Atria',
    base_url: 'https://api.atria-asi.ai/v1',
    key_env: ['GLMMODELS_API_KEY'],
    wire: 'openai',
  },
  // Ollama on this machine. OpenAI-shaped like the rest, and no credential,
  // because it never leaves the box.
  local: {
    label: 'Local (Ollama)',
    base_url: 'http://127.0.0.1:11434/v1',
    key_env: [],
    wire: 'openai',
  },
  // A ChatGPT Plus/Pro subscription, signed in once with the Codex CLI on the
  // box. No key: the host reads and refreshes the CLI's auth.json (OAuth).
  codex: {
    label: 'ChatGPT (subscription)',
    base_url: 'https://chatgpt.com/backend-api',
    key_env: [],
    wire: 'codex',
    oauth: true,
    sign_in: 'Connect ChatGPT in App settings → AI providers',
  },
};

/** Which wire format a provider speaks. Anthropic is the default. */
export function wireFor(provider) {
  return PROVIDERS[provider]?.wire ?? 'anthropic';
}

/** null means "inherit the host default" — not an error. */
export function normalizeModel(model) {
  if (typeof model !== 'string' || /[\x00-\x1f\x7f]/.test(model)) return null;
  const id = model.trim();
  return id && id.length <= 256 ? id : null;
}

export function normalizeProvider(provider) {
  return typeof provider === 'string' && Object.hasOwn(PROVIDERS, provider) ? provider : null;
}

/**
 * A custom provider's id comes from its label, so a person names it once and
 * the host has a stable key for it. null rejects anything that could not be a
 * safe identifier or an env-var stem.
 */
export function providerSlug(label) {
  const id = String(label ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return id && /^[\w-]+$/.test(id) ? id : null;
}

/** Where a custom provider's key lives. Built-ins keep their own names. */
export function keyEnvName(id) {
  return `${String(id ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/**
 * An operator-supplied endpoint. http(s) only, no embedded credentials, no
 * control characters — a URL that can be stored and dialed without becoming an
 * injection surface. Trailing slashes are trimmed so endpoint joining is uniform.
 */
export function normalizeBaseUrl(url) {
  const value = String(url ?? '').trim();
  if (!value || value.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return parsed.href.replace(/\/+$/, '');
}
