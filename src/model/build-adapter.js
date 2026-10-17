import { AnthropicAdapter } from './anthropic-adapter.js';
import { OpenAICompatAdapter } from './openai-adapter.js';
import { RoutingAdapter } from './routing-adapter.js';
import { ScriptedAdapter } from './scripted-adapter.js';
import { PROVIDERS, normalizeModel, normalizeProvider, wireFor } from '../../web/models.js';
import { ModelCatalog } from '../services/model-catalog.js';
import { ProviderStore } from '../services/provider-store.js';
import { CodexAdapter } from './codex-adapter.js';
import { CodexAuth, defaultCodexAuthFile } from './codex-auth.js';

// One place where the model layer is assembled, because the server and the CLI
// both need it and must agree. Anything that must be true of both belongs here.

/** True when at least one provider can actually serve a turn. */
/** OAuth providers are live when someone is signed in, not when a key is set. */
export function oauthReady(provider = 'codex', env = process.env) {
  if (provider !== 'codex') return false;
  return new CodexAuth({ file: defaultCodexAuthFile(env) }).status().signed_in;
}

/**
 * Any provider with a key, or a subscription the host can read, makes the box
 * live. Custom providers count too: a host whose only credential is an
 * operator-added endpoint is not a scripted stand-in.
 */
export function liveProvider(providers = null) {
  const requested = providers && providers.normalize(process.env.BETTER_BOTS_DEFAULT_PROVIDER ?? process.env.BETTER_BOTS_PROVIDER);
  if (normalizeProvider(process.env.BETTER_BOTS_DEFAULT_PROVIDER ?? process.env.BETTER_BOTS_PROVIDER)) return true;
  if (requested) return true;
  if (oauthReady('codex')) return true;
  return Object.values(providers?.all() ?? PROVIDERS).some((spec) => spec.key_env?.length > 0 && spec.key_env.some((name) => process.env[name]));
}

/**
 * Interactive callers get modest settings on purpose: the library default of
 * effort:high with 64k output is right for a long agent turn and wrong for
 * someone waiting at a prompt, where it looks like a hang.
 */
export function buildAdapter({ offlineMessage, catalog = null, dir = process.env.BETTER_BOTS_DIR, providers = null } = {}) {
  providers ??= new ProviderStore({ dir });
  if (!liveProvider(providers)) {
    return new ScriptedAdapter(() => [{ type: 'text', text: offlineMessage ?? 'No model provider configured.' }]);
  }
  catalog ??= new ModelCatalog({ dir, providers });

  const shared = {
    effort: process.env.BETTER_BOTS_EFFORT ?? 'medium',
    max_tokens: Number(process.env.BETTER_BOTS_MAX_TOKENS ?? 8192),
    timeout_ms: Number(process.env.BETTER_BOTS_TIMEOUT_MS ?? 120_000),
  };

  const routes = {};
  for (const [provider, spec] of Object.entries(providers.all())) {
    const wire = providers.wire(provider);
    if (wire === 'codex') {
      routes[provider] = new CodexAdapter({ auth: catalog.codexAuth, timeout_ms: Number(process.env.BETTER_BOTS_LOCAL_TIMEOUT_MS ?? 600_000), reasoning_effort: process.env.BETTER_BOTS_CODEX_EFFORT ?? null });
      continue;
    }
    routes[provider] = wire === 'openai'
      ? new OpenAICompatAdapter({
          provider,
          base_url: spec.base_url,
          key_env: spec.key_env,
          max_tokens: shared.max_tokens,
          // A local model on consumer hardware is slower than a hosted one and
          // must not be cut off mid-answer by a timeout meant for the network.
          timeout_ms: provider === 'local'
            ? Number(process.env.BETTER_BOTS_LOCAL_TIMEOUT_MS ?? 600_000)
            : shared.timeout_ms,
        })
      : new AnthropicAdapter({
          ...shared,
          ...(provider === 'anthropic' ? { model: process.env.BETTER_BOTS_MODEL } : {}),
        });
  }
  // Provider and model are independent settings, never inferred from an ID.
  const defaultModel = normalizeModel(process.env.BETTER_BOTS_DEFAULT_MODEL ?? process.env.BETTER_BOTS_MODEL);
  const configured = Object.entries(providers.all()).find(([, spec]) => spec.key_env?.length > 0 && spec.key_env.some((name) => process.env[name]))?.[0]
    ?? (oauthReady('codex') ? 'codex' : undefined);
  const requested = process.env.BETTER_BOTS_DEFAULT_PROVIDER ?? process.env.BETTER_BOTS_PROVIDER;
  if (requested && !providers.normalize(requested)) throw new Error(`Unknown default provider: ${requested}`);
  const fallback = normalizeProvider(requested) ?? providers.normalize(requested) ?? configured;
  return new RoutingAdapter({ routes, fallback, default_model: defaultModel, catalog });
}
