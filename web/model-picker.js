import { PROVIDERS, normalizeModel } from './models.js';

export function encodeModelChoice(model, provider = null) {
  return model == null || model === '' ? '' : JSON.stringify([provider, model]);
}

export function decodeModelChoice(value) {
  if (value === '') return { model: null, model_provider: null };
  let choice;
  try { choice = typeof value === 'string' ? JSON.parse(value) : null; } catch { /* rejected below */ }
  if (!Array.isArray(choice) || choice.length !== 2 || !normalizeModel(choice[1])
    || (choice[0] !== null && (typeof choice[0] !== 'string' || !choice[0].trim()))) {
    throw new Error('Invalid model selection. Choose a model or Host default.');
  }
  return { model: choice[1], model_provider: choice[0] };
}

function providerLabel(id, providers) {
  return providers.find((provider) => provider.id === id)?.label ?? PROVIDERS[id]?.label ?? id;
}

export function modelLabel(model, provider, providers = []) {
  return provider ? `${providerLabel(provider, providers)} / ${model}` : model;
}

/** Rebuild from the current field value, never from a selection captured before a request. */
export function modelOptions({ models, providers }, value = '') {
  const groups = new Map(providers.map((provider) => [provider.id, { label: provider.label, options: [] }]));
  const free = { label: 'Free models', options: [] };
  const populatedProviders = new Set();
  const seen = new Set();
  for (const model of models) {
    const key = encodeModelChoice(model.id, model.provider);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!groups.has(model.provider)) groups.set(model.provider, { label: providerLabel(model.provider, providers), options: [] });
    populatedProviders.add(model.provider);
    const isFree = model.is_free === true;
    (isFree ? free : groups.get(model.provider)).options.push({
      value: key,
      label: `${modelLabel(model.label || model.id, model.provider, providers)}${model.is_default ? ' (provider default)' : ''}${model.stale ? ' (cached)' : ''}`,
      description: model.description || '',
    });
  }
  for (const provider of providers) {
    const group = groups.get(provider.id);
    if (!populatedProviders.has(provider.id) && ['error', 'stale', 'ready'].includes(provider.state)) {
      group.options.push({ value: `unavailable:${provider.id}`, disabled: true,
        label: `${provider.label} — ${/HTTP (401|403)/.test(provider.error ?? '') ? 'authentication rejected; replace key or sign in' : 'models unavailable; refresh or check connection'}`,
        description: provider.error ?? 'The provider returned no models.' });
    }
  }
  const available = [...groups.values()].filter((group) => group.options.length);
  if (value && !seen.has(value)) {
    const { model, model_provider } = decodeModelChoice(value);
    const label = model_provider ? modelLabel(model, model_provider, providers) : `Provider unspecified (legacy) / ${model}`;
    available.unshift({ label: 'Current selection', options: [{ value, label: `${label} (unavailable; kept)`, description: '' }] });
  }
  if (free.options.length) {
    free.options.sort((a, b) => a.label.localeCompare(b.label));
    available.unshift(free);
  }
  return { value, groups: available };
}

/** Credential presence is not proof that discovery or inference works. */
export function providerStatus(provider, discovery) {
  if (provider.oauth && provider.needs_reconnect) return { label: 'reconnect needed', failed: true, detail: 'Your ChatGPT sign-in expired or was revoked. Use Reconnect below.' };
  if (discovery?.state === 'checking') return { label: 'checking new key', failed: false, detail: 'Key saved. Checking model access with the replacement credential.' };
  if (discovery?.state === 'error' || discovery?.state === 'stale') {
    const auth = /HTTP (401|403)/.test(discovery.error ?? '');
    return { label: auth ? 'authentication rejected' : 'discovery unavailable', failed: true,
      detail: `${discovery.error ?? 'Model discovery failed.'} ${auth
        ? (provider.oauth ? 'Sign in again using Reconnect below.' : 'Replace the saved API key below, then refresh models.')
        : 'Check the provider connection and refresh models.'}${discovery.state === 'stale' ? ' Previously discovered models are cached.' : ''}` };
  }
  if (!provider.configured) return { label: provider.oauth ? 'not signed in' : 'no key', failed: true, detail: '' };
  return { label: discovery?.state === 'ready' ? 'models loaded' : provider.oauth ? 'signed in' : provider.needs_key ? 'key saved' : 'not checked',
    failed: false, detail: discovery?.state === 'ready' ? 'Model list loaded. Inference access is checked when a run starts.' : '' };
}

export function modelCatalogStatus({ data, busy, error }) {
  const lines = [busy ? 'Refreshing models... Your selection is kept.'
    : error ? `Could not refresh models: ${error}. Previous options and your selection are kept.`
      : data.models.length ? `${data.models.length} models listed. Host default follows the host configuration.`
        : 'No models discovered. Host default is still available; connect an account in App settings → AI providers.'];
  for (const provider of data.providers) {
    if (provider.state !== 'stale' && provider.state !== 'error') continue;
    lines.push(`${provider.label}: ${provider.state === 'stale' ? 'using cached models' : 'models unavailable'}. ${provider.error || 'Refresh models to try again.'}`);
  }
  return lines.join('\n');
}

/** One flight for both fields. Credential changes queue a fresh discovery and discard the old result. */
export function createModelCatalog(request, onChange) {
  let flight;
  let queued = false;
  const store = {
    data: { models: [], providers: [] },
    busy: false,
    error: null,
    credentialsChanged(provider) {
      store.data = {
        models: store.data.models.filter(model => model.provider !== provider),
        providers: [...store.data.providers.filter(entry => entry.id !== provider),
          { id: provider, state: 'checking', error: null }],
      };
      return store.refresh(true);
    },
    refresh(force = false) {
      if (store.busy) {
        queued ||= force;
        return flight;
      }
      store.busy = true;
      store.error = null;
      flight = (async () => {
        do {
          queued = false;
          try {
            const data = await request(force);
            if (!Array.isArray(data?.models) || !Array.isArray(data?.providers)) throw new Error('Invalid model catalog response');
            if (!queued) { store.data = data; store.error = null; }
          } catch (error) {
            if (!queued) store.error = error.message || 'Model discovery failed';
          }
          force = true;
        } while (queued);
        store.busy = false;
        onChange();
      })();
      onChange();
      return flight;
    },
  };
  return store;
}
