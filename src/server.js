import http from 'node:http';
import { chatTurnIds } from './core/chat-turns.js';
import { pipeline } from 'node:stream';
import { attachDesktopViewer } from './desktop-viewer.js';
import { acquireInstanceLock } from './core/instance-lock.js';
import { reasoningOptions } from '../web/reasoning.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Host } from './host.js';
import { buildAdapter, liveProvider } from './model/build-adapter.js';
import { engineFromEnv } from './services/memory-engine.js';
import { PRODUCT, VERSION, DISPLAY_VERSION, CODENAME } from './core/version.js';
import { CodexAuth } from './model/codex-auth.js';
import { SubscriptionLogin } from './services/subscription-login.js';
import { systemClock } from './core/clock.js';
import { normalizeShape, normalizeStyle, normalizeColor, normalizeHair } from '../web/avatar.js';
import { normalizeModel, normalizeProvider } from '../web/models.js';
import { ModelCatalog } from './services/model-catalog.js';
import { ProviderStore } from './services/provider-store.js';
import { HostError } from './core/util.js';
import { checkedHealthSnapshot, startHealthNotifier } from './core/health.js';
import { startAutomationTicker } from './services/automation-ticker.js';

// The interface layer: it accepts requests and shows activity, chats, tools,
// and results. It sits on top of the host's services and owns none of their
// state — every route below delegates to a service.

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.png': 'image/png',
};

export function createHost({ dir, live = false }) {
  // The provider store is built first: it applies saved custom keys to the
  // environment, so the catalog and the adapters see one consistent credential
  // set instead of a host that knows about a provider it cannot authenticate.
  const providers = new ProviderStore({ dir });
  const catalog = new ModelCatalog({ dir, providers });
  const adapter = buildAdapter({
    dir, catalog, providers,
    offlineMessage: 'No AI provider is connected, so this is a stand-in reply. Connect one in App settings → AI providers for real replies.',
  });
  // The interface needs approval cards a person can actually answer.
  // Memory is SQLite in the data folder unless HINDSIGHT_URL names a Hindsight engine.
  const host = new Host({ dir, adapter, clock: systemClock, approval_mode: 'wait', memory_engine: engineFromEnv(process.env, { dir }) });
  host.memoryRequired = process.env.BETTER_BOTS_REQUIRE_HINDSIGHT === '1';
  host.modelCatalog = catalog;
  host.providers = providers;
  return host;
}

/** Loopback needs no token. Anything else is reachable by strangers. */
export function isLoopback(hostname) {
  return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare lengths first; timingSafeEqual throws on a mismatch.
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) { try { return decodeURIComponent(rest.join('=')); } catch { return null; } }
  }
  return null;
}

/**
 * Without a token, only a request addressed to a loopback name is ours. A page
 * that rebinds its own DNS name to 127.0.0.1 reaches this socket with that name
 * in Host, and with a matching Origin, so the Host header is what tells it apart.
 */
export function loopbackHost(req) {
  try { return isLoopback(new URL(`http://${req.headers.host}`).hostname.replace(/^\[(.*)\]$/, '$1')); }
  catch { return false; }
}

/**
 * The console always wants a token. Without BETTER_BOTS_TOKEN the host makes one
 * the first time it starts and keeps it in the data folder, readable by its own
 * user only, so a restart does not log everybody out. Any other local program
 * could otherwise drive the console just by reaching 127.0.0.1.
 */
export function consoleToken(dir) {
  const file = path.join(dir, 'console-token');
  const read = () => { try { return fs.readFileSync(file, 'utf8').trim() || null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const existing = read();
  if (existing) return existing;
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(32).toString('base64url');
  // wx: two hosts racing to create it agree on whichever file landed first.
  try { fs.writeFileSync(file, `${token}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return read(); }
  return token;
}

/**
 * Bearer for scripts, cookie for the browser. EventSource cannot set headers,
 * so the live activity stream would be unauthenticated without the cookie.
 */
export function authorized(req, token) {
  if (!token) return loopbackHost(req);
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  return safeEqual(bearer, token) || safeEqual(readCookie(req.headers.cookie, 'better_bots_token'), token);
}

export function createServer({ host, live, token = null,
  catalog = host.modelCatalog ?? new ModelCatalog({ dir: host.dir }),
  providers = host.providers ?? new ProviderStore({ dir: host.dir }),
  subscriptionLogin = null }) {
  const startedAt = Date.now();
  const watchers = new Set();
  const stopThoughts = host.scheduler.subscribeThought(event => {
    for (const res of watchers) {
      if (res.writableLength > 1024 * 1024) { res.destroy(); watchers.delete(res); continue; }
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { watchers.delete(res); }
    }
  });
  host.audit.subscribe((event) => {
    for (const res of watchers) {
      // A client that stopped reading must not buffer the audit log in memory.
      if (res.writableLength > 1024 * 1024) { res.destroy(); watchers.delete(res); continue; }
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        watchers.delete(res);
      }
    }
  });

  async function modelSelection(body, current = {}) {
    if (body.model === undefined) {
      if (body.model_provider !== undefined) throw new HostError('invalid_model', 'Set model and model_provider together.');
      return {};
    }
    if (body.model === null || body.model === '') return { model: null, model_provider: null };
    const model = normalizeModel(body.model);
    if (!model) throw new HostError('invalid_model', 'Model must be a nonempty provider model ID without control characters.');
    const model_provider = body.model_provider === undefined ? current.model_provider ?? null : body.model_provider;
    // Catalog outages or delistings must not change an existing pin during a profile edit.
    if (model === current.model && model_provider === (current.model_provider ?? null)) return { model, model_provider };
    if (!normalizeProvider(model_provider) && !providers.normalize(model_provider)) throw new HostError('invalid_model_provider', 'Choose a provider for this model.');
    const available = (await catalog.list({ provider: model_provider })).models;
    if (!available.some((m) => m.id === model && m.provider === model_provider && !m.stale)) {
      throw new HostError('model_unavailable', 'This model is not in the current provider catalog. Refresh models and choose an available model.');
    }
    return { model, model_provider };
  }

  /** A provider or model change rewrites the model layer in place: no restart,
   * and no route into systemd from a web request. */
  function rebuildModels(provider) {
    if (provider) catalog.invalidate(provider);
    host.adapter = buildAdapter({ dir: host.dir, catalog, providers,
      offlineMessage: 'No model provider is configured, so this is a stand-in reply.' });
    live = liveProvider(providers);
  }

  const subscription = subscriptionLogin ?? new SubscriptionLogin({ auth: catalog.codexAuth ?? new CodexAuth(), onConnected: () => rebuildModels('codex') });

  const routes = {
    'GET /api/providers/codex/login': () => subscription.status(),
    'POST /api/providers/codex/login': () => subscription.start(),
    'POST /api/providers/codex/login/callback': body => subscription.submitCallback(body.id, body.callback_url),
    'DELETE /api/providers/codex/login': body => subscription.cancel(body.id),
    'GET /api/state': () => ({
      live,
      // A placeholder backend draws nothing (macOS, or Linux without the display
      // tools), so the console hides the desktop panel instead of failing per bot.
      capabilities: { room_start: true, agent_stop: true, desktop: host.computer.backend.kind !== 'placeholder' },
      product: PRODUCT, version: DISPLAY_VERSION, codename: CODENAME,
      // The routed adapter's model is the host default, whatever provider it is on.
      model: live ? (host.adapter?.model ?? process.env.BETTER_BOTS_DEFAULT_MODEL ?? process.env.BETTER_BOTS_MODEL ?? null) : 'scripted stand-in',
      model_provider: host.adapter?.fallback ?? null,
      ...host.status(),
    }),

    // Every tool the host can offer, for the per-agent tool picker. Remember and
    // Recall are listed but always on (ToolRegistry.allowedFor).
    'GET /api/tools': () => ({
      tools: [...host.tools.tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        always_on: tool.name === 'Remember' || tool.name === 'Recall',
        default: !reachesHost(tool),
      })),
    }),

    'GET /api/models': (_, url) => catalog.list({ force: url.searchParams.get('refresh') === '1' }),

    // Which providers can serve a turn. Never returns a key — only whether one
    // is present, so the page can say "configured" without holding a secret.
    'GET /api/providers': () => ({
      providers: Object.entries(providers.all()).map(([id, spec]) => {
        if (spec.oauth) {
          const status = (catalog.codexAuth ?? new CodexAuth()).status();
          return {
            id, label: spec.label, needs_key: false, oauth: true, key_env: null, custom: false,
            configured: status.signed_in, needs_reconnect: status.needs_reconnect === true,
            account: status.signed_in ? { plan: status.plan, expires_at: status.expires_at } : null,
            sign_in: 'Connect your ChatGPT account below. No API key is needed.',
            login: subscription.status(),
            note: status.signed_in ? null : status.why,
          };
        }
        return {
          id,
          label: spec.label,
          needs_key: spec.key_env.length > 0,
          configured: providers.keyed(id),
          key_env: spec.key_env[0] ?? null,
          custom: providers.isCustom(id),
          base_url: spec.base_url,
          models: providers.manualModels().filter((m) => m.provider === id).map((m) => ({ id: m.id, label: m.label })),
        };
      }),
    }),

    /**
     * Save a provider credential. Built-in keys go to the env file the service
     * reads at boot; a custom provider's key goes to its secrets file. Either
     * way the model layer is rebuilt in place — no restart, so no route into
     * systemd from a web request.
     */
    'POST /api/providers': (body) => {
      const spec = providers.get(body.provider);
      if (!spec) throw new HostError('unknown_provider', `no provider ${body.provider}`);
      const name = spec.key_env[0];
      if (!name) throw new HostError('no_credential', `${body.provider} takes no key`);
      const key = String(body.key ?? '').trim();
      if (!key) throw new HostError('empty_key', 'a key is required');

      providers.saveKey(body.provider, key);
      rebuildModels(body.provider);
      host.audit.record('provider.configured', { provider: body.provider, key_env: name });
      return { ok: true, provider: body.provider, configured: true };
    },

    /**
     * An operator's own endpoint: a label, a base URL, and a key. It becomes a
     * provider like any other — routable, discoverable, pinnable — and its key
     * is stored in the data dir, not the host env file, because the console
     * owns this one end to end.
     */
    'POST /api/custom-providers': (body) => {
      const spec = providers.addProvider({ label: body.label, base_url: body.base_url, key: body.key, wire: body.wire });
      catalog.invalidate(spec.id);
      rebuildModels();
      host.audit.record('provider.added', { provider: spec.id, base_url: spec.base_url });
      return { ok: true, provider: { id: spec.id, label: spec.label, base_url: spec.base_url, configured: providers.keyed(spec.id) } };
    },

    'PATCH /api/custom-providers': body => {
      const spec = providers.updateProvider(body.provider, body);
      rebuildModels(spec.id);
      host.audit.record('provider.updated', { provider: spec.id });
      return { ok: true, provider: { id: spec.id, label: spec.label, base_url: spec.base_url, configured: providers.keyed(spec.id) } };
    },

    'DELETE /api/custom-providers': (body) => {
      const id = providers.normalize(body.provider);
      if (!id || !providers.isCustom(id)) throw new HostError('unknown_provider', 'no such custom provider');
      if ((process.env.BETTER_BOTS_DEFAULT_PROVIDER ?? process.env.BETTER_BOTS_PROVIDER) === id) {
        throw new HostError('provider_in_use', `${id} is the host default provider (BETTER_BOTS_DEFAULT_PROVIDER); change the default before removing it.`);
      }
      const pinned = host.registry.list().filter((a) => a.profile.model_provider === id).map((a) => a.profile.name);
      providers.removeProvider(id);
      rebuildModels(id);
      host.audit.record('provider.removed', { provider: id });
      return { ok: true, provider: id, agents_pinned: pinned };
    },

    /**
     * A model the account can reach but the provider does not list: a preview
     * model, a fine-tune, a locally served name. The entry is vouched for by
     * the person adding it, so it is selectable without discovery agreeing.
     */
    'POST /api/models': (body) => {
      const entry = providers.addModel({ provider: body.provider, model: body.model, label: body.label, key: body.key });
      // The catalog merges manual entries at list time, so a refresh is not
      // needed for the picker to see it; the route only stays consistent.
      host.audit.record('model.added', { provider: entry.provider, model: entry.id });
      return { ok: true, model: entry };
    },

    'DELETE /api/models': (body) => {
      providers.removeModel(body.provider, body.model);
      host.audit.record('model.removed', { provider: body.provider, model: body.model });
      return { ok: true, provider: body.provider, model: body.model };
    },


    // Integrations: MCP servers and the tools they lend. Never returns a key,
    // token, or env value — describe() masks them.
    'GET /api/reconciliation': () => ({ items: host.reconciliation.list() }),
    'POST /api/reconciliation': (body) => {
      const result = host.reconciliation.resolve({ ...body, actor: 'user' });
      if (body.kind === 'run' && body.outcome === 'confirmed_not_executed') {
        void host.drain().catch(error => host.audit.record('run.dispatch_failed', { error: error.message }));
      }
      return result;
    },
    'GET /api/integrations': () => ({ integrations: host.integrations.describe(), presets: host.integrations.presets() }),
    'POST /api/integrations': (body) => {
      // A custom stdio server is a program this host starts, as itself, on every
      // connect. The request has to repeat the command it is agreeing to run,
      // which the console sends only after the person confirms it on screen.
      if (body.command !== undefined && String(body.confirm_command ?? '').trim() !== String(body.command).trim()) {
        throw new HostError('command_unconfirmed', 'Adding a local command needs confirm_command set to that exact command.');
      }
      return host.integrations.add(body);
    },
    'DELETE /api/integrations': (body) => host.integrations.remove(body.name),
    'POST /api/integrations/review-tool': (body) => host.integrations.reviewTool({ ...body, actor: 'user' }),
    'POST /api/integrations/reconnect': (body) => host.integrations.connect(body.name),
    'POST /api/integrations/sign-out': (body) => host.integrations.signOut(body.name),
    // The redirect lands on the console the person is looking at (tunnel or
    // domain), so the origin comes from the request that asked to sign in.
    'POST /api/integrations/sign-in': (body, url, req) => host.integrations.startSignIn(body.name, {
      redirect_uri: `${consoleOrigin(req)}/api/integrations/oauth/callback`,
    }),

    // What is waiting for an agent's next turn: queued, undelivered peer messages.
    'GET /api/inbox': (_, url) => ({
      messages: host.messages.pending(url.searchParams.get('agent_id')).map((m) => ({
        id: m.id, sender_id: m.sender_id, text: m.text, priority: m.priority, priority_reason: m.priority_reason, created_at: m.created_at,
      })),
    }),
    'GET /api/transcript': (_, url) => {
      const id = url.searchParams.get('agent_id');
      const roomId = url.searchParams.get('room_id');
      const ownerKind = roomId ? 'room' : 'agent';
      const ownerId = roomId || id;
      if (roomId) host.rooms.get(roomId); else host.registry.get(id);
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : null;
      if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
        throw new HostError('invalid_limit', 'Conversation page size must be between 1 and 500.');
      const page = limit === null ? { entries: host.transcripts.all(ownerKind, ownerId) }
        : host.transcripts.page(ownerKind, ownerId, { limit, before: url.searchParams.get('before') });
      if (roomId) return { kind: 'room', ...page };
      const turns = chatTurnIds(host.scheduler.durableRuns().filter(run => run.agent_id === id));
      const active = host.scheduler.activeRun(id);
      return { kind: 'agent',
        ...page,
        entries: page.entries.map(entry => entry.run_id ? {...entry, turn_id: turns.get(entry.run_id) ?? entry.run_id} : entry),
        active_run: active ? {...active, turn_id: turns.get(active.id) ?? active.id} : active };
    },

    'POST /api/desktop/connect': async (body) => {
      host.registry.get(body.agent_id);
      const outcome = await host.computer.requestWindow(body.agent_id);
      if (!outcome.ok) throw new HostError(outcome.reason, outcome.detail);
      const window = await host.computer.readyWindow(body.agent_id);
      if (!window.live) throw new HostError('desktop_unavailable', host.computer.describe().desktop_note);
      return { window };
    },

    'POST /api/agents': async (body) => host.registry.create({
      profile: {
        name: cleanName(body.name),
        role: body.role ?? '',
        description: body.prompt ?? '',
        ...await modelSelection(body),
        avatar_shape: normalizeShape(body.shape),
        avatar_style: normalizeStyle(body.style),
        avatar_color: normalizeColor(body.color),
        avatar_hair: normalizeHair(body.hair),
        desk: cleanDesk(body.desk),
        // New bots are safe by default: no host-machine tools unless chosen.
        allowed_tools: body.allowed_tools === undefined
          ? [...host.tools.tools.values()].filter((tool) => !reachesHost(tool)).map((tool) => tool.name)
          : cleanAllowedTools(body.allowed_tools),
      },
    }),

    // Re-facing an agent is a profile edit, so it touches the profile only —
    // the transcript and memory behind this ID are untouched.
    'PATCH /api/agents': async (body) => {
      // Absent means "leave alone"; present means "set to this". A settings form
      // that sends only what changed must not blank the fields it left out.
      const patch = {};
      if (body.name !== undefined) patch.name = cleanName(body.name);
      if (body.role !== undefined) patch.role = String(body.role).trim();
      if (body.prompt !== undefined) patch.description = String(body.prompt).trim();
      const current = host.registry.get(body.agent_id).profile;
      // A refused model or reasoning choice leaves those unchanged, but must not
      // throw away the prompt and other fields saved alongside it.
      let modelError = null;
      try {
        const model = await modelSelection(body, current);
        const selected = { ...current, ...model };
        const efforts = reasoningOptions(selected.model_provider ?? host.adapter.fallback, selected.model ?? host.adapter.model);
        if (body.reasoning_effort !== undefined) {
          const effort = body.reasoning_effort || null;
          if (effort && !efforts.includes(effort)) throw new HostError('invalid_reasoning_effort', 'Choose a reasoning level supported by this model.');
          model.reasoning_effort = effort;
        } else if (current.reasoning_effort && !efforts.includes(current.reasoning_effort)) model.reasoning_effort = null;
        Object.assign(patch, model);
      } catch (error) {
        if (!(error instanceof HostError)) throw error;
        modelError = error;
      }

      if (body.shape !== undefined) patch.avatar_shape = normalizeShape(body.shape);
      if (body.style !== undefined) patch.avatar_style = normalizeStyle(body.style);
      if (body.color !== undefined) patch.avatar_color = normalizeColor(body.color);
      if (body.hair !== undefined) patch.avatar_hair = normalizeHair(body.hair);
      if (body.desk !== undefined) patch.desk = cleanDesk(body.desk);
      if (body.allowed_tools !== undefined) patch.allowed_tools = cleanAllowedTools(body.allowed_tools);
      const updated = host.registry.updateProfile(body.agent_id, patch);
      if (modelError) throw new HostError(modelError.code, `Other settings were saved; the model was not changed. ${modelError.message}`, modelError.details);
      return updated;
    },

    'DELETE /api/agents': (body) => host.deleteAgent(body.agent_id, { confirm: true, actor: 'user' }),
    'DELETE /api/rooms': (body) => host.rooms.delete(body.room_id, { confirm: true, actor: 'user' }),
    'PATCH /api/rooms': (body) => host.rooms.update(body.room_id, {
      ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
      ...(body.memory !== undefined ? { memory: body.memory } : {}),
    }),
    'POST /api/rooms/pin': (body) => host.rooms.update(body.room_id, { pinned_at: body.pinned === false ? null : host.clock.iso() }),
    'POST /api/agents/lead': (body) => host.registry.updateProfile(body.agent_id, { lead: true }),
    // Pinned agents sit at the top of the roster: the orchestrator, the assistant.
    // A pin has a scope: the top of the agent's own desk, or the top of the whole rail.
    'POST /api/agents/pin': (body) => host.registry.updateProfile(body.agent_id, {
      pinned_at: body.pinned === false ? null : host.clock.iso(),
      pin_scope: body.pinned === false ? null : (body.scope === 'rail' ? 'rail' : 'desk'),
    }),
    'POST /api/blocked/resolve': (body) => host.resolveBlocked(body.report_id),

    // What an agent knows, and a way to put it right. The host reads only the
    // scopes this agent may see, exactly as a turn would.
    'GET /api/memory': async (_, url) => {
      const agent_id = url.searchParams.get('agent_id');
      if (!host.registry.has(agent_id)) throw new HostError('unknown_agent', `no bot ${agent_id}`);
      const recall = await host.memory.recall({ agent_id, scopes: sharedScopes(host), query: 'what matters right now', budget_chars: 1600 });
      return {
        agent_id,
        engine: recall.engine,
        retention: host.memory.retention.status(),
        standing: recall.standing ?? [],
        facts: recall.facts.map(publicFact),
        counts: { own: host.memory.factsIn('agent', agent_id).length, project: host.memory.factsIn('project', host.project_id).length, user: host.memory.factsIn('user', 'user').length },
      };
    },
    'GET /api/memory/retention': () => host.memory.retention.status(),
    'POST /api/memory/retention/retry': (body) => host.memory.retention.retry(body.retention_id),
    'POST /api/memory/search': async (body) => {
      const agent_id = body.agent_id;
      if (!host.registry.has(agent_id)) throw new HostError('unknown_agent', `no bot ${agent_id}`);
      const query = String(body.query ?? '').trim();
      if (!query) throw new HostError('invalid_query', 'say what to look for');
      const facts = await host.memory.search({ agent_id, scopes: [{ scope: 'agent', owner_id: agent_id }, ...sharedScopes(host)], query, limit: 12 });
      return { query, results: facts.map(publicFact) };
    },
    // A correction from the person is a shared fact written by the host, in the
    // scope the person chose. It never pretends to be the agent's own note.
    'POST /api/memory/correct': (body) => {
      const text = String(body.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (!text) throw new HostError('invalid_text', 'a correction needs words');
      const scope = body.scope === 'user' ? 'user' : 'project';
      const fact = host.memory.remember({
        // Profile: the person's own word is the one shared fact every bot keeps in mind.
        scope, owner_id: scope === 'user' ? 'user' : host.project_id, writer_agent_id: 'user', tier: 'profile', source: 'user_correction',
        text: `Correction from the user (${host.clock.iso().slice(0, 10)}): ${text}`,
      });
      return publicFact(fact);
    },
    'GET /api/desks': () => ({ desks: host.listDesks() }),
    'PATCH /api/desks': body => {
      const result = host.updateDesk(body);
      // Enabling a desk must resume admitted work even when no routine is due.
      if (body.enabled === true) void host.drain().catch(error => host.audit.record('run.dispatch_failed', { error: error.message }));
      return result;
    },
    'PATCH /api/automations': body => host.setAutomationEnabled(body.automation_id, body.enabled),
    'GET /api/automations': () => ({ automations: host.listAutomations(), automation_cancellations: host.automationCancellations() }),
    'POST /api/automations': (body) => host.scheduleAutomation({
      agent_id: body.agent_id, name: cleanName(body.name), text: String(body.text ?? '').trim(),
      due_at: body.due_at, every_ms: body.every_ms === undefined || body.every_ms === null ? null : Number(body.every_ms),
      cron: body.cron ? String(body.cron) : null, timezone: body.timezone ? String(body.timezone) : 'UTC',
    }),
    'DELETE /api/automations': (body) => host.cancelAutomation(body.automation_id),

    'POST /api/attachments/images': (body) => ({ attachment: host.attachments.save(body) }),

    'POST /api/ask': async (body) => {
      const run = host.userRequest({ agent_id: body.agent_id, text: body.text, attachments: body.attachments, authorized_recipients: body.authorized_recipients });
      await host.drain();
      return { run_id: run.id, result: host.turnResult(run.id) };
    },

    'POST /api/send': async (body) => {
      const ack = host.deliverPeerMessage({
        sender_id: body.sender_id,
        target_id: body.target_id,
        text: body.text,
        attachments: body.attachments,
        priority: Boolean(body.priority_reason),
        priority_reason: body.priority_reason ?? null,
        wake_room: true,
      });
      await host.drain();
      return ack;
    },

    // A group is created quiet. Pass `request` to open with a round straight away.
    'POST /api/rooms': async (body) => {
      const room = host.createRoom({ member_ids: body.member_ids, purpose: body.purpose, memory: body.memory ?? 'members' });
      const result = body.request ? await host.runRoom(room.id, { request: String(body.request) }) : null;
      return { room, result };
    },
    'POST /api/rooms/stop': (body) => ({ room_id: body.room_id, epoch: host.stopRoom(body.room_id) }),
    'POST /api/rooms/start': (body) => host.startRoomDiscussion(body.room_id),
    'POST /api/rooms/say': async (body) => {
      const result = await host.sayInRoom(body.room_id, { text: body.text, attachments: body.attachments, authorized_recipients: body.authorized_recipients });
      return { room_id: body.room_id, result };
    },

    'POST /api/approve': (body) => host.permissions.resolve(body.request_id, body.resolution, { actor: 'user' }),

    'POST /api/permissions': (body) => ({
      zone: body.zone,
      mode: host.permissions.setStandingMode(body.zone, body.mode, { actor: 'user' }),
    }),
    'POST /api/permissions/acknowledge': () => ({
      acknowledged_at: host.permissions.acknowledgeAutonomy({ actor: 'user' }),
    }),

    'GET /api/explain': (_, url) => host.explain(url.searchParams.get('run_id')),
    'POST /api/runs/cancel': async (body) => {
      const result = host.scheduler.cancelRun(body.run_id, { actor: 'user' });
      await host.previews.stopCancelled();
      return result;
    },
    'POST /api/agents/stop': (body) => {
      host.registry.get(body.agent_id);
      return host.scheduler.cancelAgent(body.agent_id, { actor: 'user' });
    },
    'GET /api/previews': () => ({ previews: host.previews.list() }),
    'POST /api/previews/stop': (body) => host.previews.stop(body.preview_id),

    'GET /api/activity': (_, url) => ({
      events: host.audit.tail(Number(url.searchParams.get('limit') ?? 80)),
    }),

    'GET /api/computer': () => ({ ...host.computer.describe(), assignments: host.computer.assignments() }),
  };

  const handle = async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, { error: 'bad_request' }); }
    // Identity on every response. The Mac shell refuses to show a page that
    // lacks it: a port taken by some other local server is then an error with
    // a name, not a stranger's website in a window titled Better Bots.
    res.setHeader('X-Better-Bots', VERSION);
    // The console approves real actions; no other site may frame it and steer clicks.
    res.setHeader('X-Frame-Options', 'DENY');
    // It also renders untrusted model output, so only this origin's own scripts
    // may run, even if a rendering bug ever let markup through.
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:", "connect-src 'self'", "form-action 'self'",
      "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!token && !loopbackHost(req)) {
      return send(res, 421, { error: 'bad_host', message: 'Open the console at 127.0.0.1 or localhost, or start it with BETTER_BOTS_TOKEN.' });
    }

    // A page on another origin can POST text/plain JSON to a loopback console
    // without a preflight. Browsers always label such a request with its Origin,
    // so a mutation whose Origin is not this console is refused.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let sameOrigin = false;
      try {
        const origin = new URL(req.headers.origin).host;
        const forwarded = (req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
        sameOrigin = origin === req.headers.host || (forwarded !== '' && origin === forwarded);
      } catch { /* malformed Origin is not ours */ }
      if (!sameOrigin) return send(res, 403, { error: 'bad_origin', message: 'Cross-origin requests are not accepted.' });
    }

    // Trading a token for a cookie, so EventSource can authenticate too.
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = (await readJson(req).catch(() => null)) ?? {};
      if (!token) return send(res, 200, { ok: true, required: false });
      if (!safeEqual(body.token, token)) return send(res, 401, { error: 'unauthorized' });
      const payload = JSON.stringify({ ok: true, required: true });
      res.writeHead(200, {
        'Set-Cookie': `better_bots_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      return res.end(payload);
    }

    // The OAuth redirect arrives from another site, so the SameSite cookie is
    // not on it. It carries only a code and the state we minted; the state is
    // what authenticates it. Answers with a page, because a browser is reading.
    if (url.pathname === '/api/integrations/oauth/callback' && req.method === 'GET') {
      const params = Object.fromEntries(url.searchParams);
      let title; let detail;
      try {
        const shown = await host.integrations.finishSignIn(params);
        title = `${shown.name}: signed in`;
        detail = shown.state === 'connected' ? `${shown.tools.length} tools are now available to your agents.` : `${shown.state}: ${shown.error ?? ''}`;
      } catch (err) {
        title = 'Sign-in did not complete';
        detail = err.message;
      }
      const page = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;padding:3rem;max-width:36rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p><a href="/">Back to the console</a> — this tab can be closed.</p></body>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page) });
      return res.end(page);
    }

    // Liveness for an uptime monitor. Token-free by design: only
    // healthy-vs-degraded and the failure classes behind that. Agent and run
    // counts are operational detail a stranger has no need for, so they stay off
    // this surface; richer state is behind the token under /api.
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
      const snapshot = await checkedHealthSnapshot({ host, live, startedAt });
      const { counts, ...visible } = snapshot;
      return send(res, visible.status === 'degraded' ? 503 : 200, visible);
    }

    if (url.pathname.startsWith('/api/') && !authorized(req, token)) {
      return send(res, 401, { error: 'unauthorized', message: 'this console requires a token' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
      try {
        const { attachment, buffer } = host.attachments.read(url.pathname.slice('/api/attachments/'.length));
        res.writeHead(200, {
          'Content-Type': attachment.media_type, 'Content-Length': buffer.length,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable',
        });
        return res.end(buffer);
      } catch (err) {
        return send(res, err.code === 'attachment_not_found' ? 404 : 400, { error: err.code ?? 'error', message: err.message });
      }
    }

    // Live activity feed. The interface shows what is happening as it happens.
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      watchers.add(res);
      req.on('close', () => watchers.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/vendor/novnc/')) {
      const root = path.resolve(here, '../node_modules/@novnc/novnc');
      const file = path.resolve(root, url.pathname.slice('/vendor/novnc/'.length));
      if (!file.startsWith(root + path.sep) || !file.endsWith('.js') || !fs.existsSync(file)) return send(res, 404, {error:'not_found'});
      res.writeHead(200, {'Content-Type':'text/javascript', 'Cache-Control':'no-cache'});
      return pipeline(fs.createReadStream(file), res, () => {});
    }

    // Screenshots taken on the agents' monitors. Behind the same token as everything under /api.
    if (req.method === 'GET' && url.pathname.startsWith('/api/screens/')) {
      let name = '';
      try { name = decodeURIComponent(url.pathname.slice('/api/screens/'.length)); } catch { /* falls through to 404 */ }
      if (!/^window-\d+-\d+\.png$/.test(name)) return send(res, 404, { error: 'not_found' });
      const file = path.join(host.dir, 'computer', 'shots', name);
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' });
      return pipeline(fs.createReadStream(file), res, () => {});
    }

    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) {
      try {
        const body = await readJson(req, key === 'POST /api/attachments/images' ? 7 * 1024 * 1024 : 1_000_000);
        const value = await routes[key](body, url, req);
        send(res, 200, value);
      } catch (err) {
        const missing = ['agent_not_found', 'run_not_found', 'room_not_found', 'workflow_not_found', 'unknown_target', 'unknown_sender', 'unknown_integration', 'attachment_not_found'];
        send(res, missing.includes(err.code) ? 404 : ['body_too_large', 'attachment_too_large'].includes(err.code) ? 413 : 400, {
          error: err.code ?? 'error',
          message: err.message,
        });
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res, req.method === 'HEAD', req, url.searchParams.get('v'));
    send(res, 405, { error: 'method_not_allowed' });
  };
  // One bad request must never take the host down: every handler failure ends
  // as a 500 (or a closed socket once the headers are out), not an unhandled rejection.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(`request failed: ${error?.message ?? error}`);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
  server.on('close', stopThoughts);
  server.on('close', () => subscription.close());
  attachDesktopViewer(server, {host, authorized, token});
  // Posts a degraded snapshot to BETTER_BOTS_NOTIFY_WEBHOOK, if one is configured.
  // Returns null and does nothing when the env var is unset.
  const notifier = startHealthNotifier({ host, live, startedAt });
  if (notifier) server.on('close', () => notifier.stop());
  return server;
}

/** Where the browser reached us: behind a tunnel that is 127.0.0.1:4173, behind TLS it is the domain. */
function consoleOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http';
  const host = (req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1:4173').split(',')[0].trim();
  return `${proto}://${host}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sharedScopes(host) {
  return [{ scope: 'project', owner_id: host.project_id }, { scope: 'user', owner_id: 'user' }];
}

function publicFact(f) {
  return { id: f.id, scope: f.owner_scope, tier: f.tier, text: f.text, learned_at: f.learned_at, source: f.source, writer: f.writer_agent_id ?? null, ...(f.when ? { when: f.when } : {}) };
}

/** A desk is a label that groups agents in the roster; empty means the default desk. */
function cleanDesk(desk) {
  return String(desk ?? '').trim().slice(0, 40);
}

/** Tools whose permission zone is the machine running the host, outside the sandbox. */
function reachesHost(tool) {
  return typeof tool.permission?.action === 'string' && tool.permission.action.startsWith('local.');
}

/** null means every tool; a list means only those tools (memory is always kept). */
function cleanAllowedTools(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string' && name.trim()))
    throw new HostError('invalid_allowed_tools', 'allowed_tools must be null or a list of tool names.');
  return [...new Set(value.map((name) => name.trim()))];
}

function cleanName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new HostError('invalid_name', 'a bot needs a name');
  return clean;
}

function serveStatic(pathname, res, headOnly = false, req = null, versionQuery = null) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(webDir, rel);
  // Never serve outside the web directory.
  if (!path.resolve(file).startsWith(path.resolve(webDir) + path.sep)) return send(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file)) return send(res, 404, { error: 'not_found' });
  const stat = fs.statSync(file);
  if (stat.isDirectory()) return send(res, 404, { error: 'not_found' });
  // Files revalidate by default: an ETag makes that one cheap 304 rather than
  // a re-download. Faces are the exception. The console asks for them with a
  // build version in the query (?v=N, bumped by the builder), so a versioned
  // face can be cached hard — and must be: a revalidation round trip on every
  // <img> the roster redraws is a visible blink on every face in the room.
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const versioned = rel.startsWith('avatars/') && Boolean(versionQuery);
  const headers = {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: etag,
  };
  if (req?.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  if (headOnly) return res.end();
  pipeline(fs.createReadStream(file), res, () => {});
}

function send(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req, limit = 1_000_000) {
  if (req.method === 'GET') return Promise.resolve({});
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        chunks.length = 0;
        reject(new HostError('body_too_large', 'body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dir = process.env.BETTER_BOTS_DIR ?? path.join(process.cwd(), '.data');
  // The data folder holds keys, transcripts and memory: private when created here.
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Refuse before touching anything if another host already owns this folder.
  try {
    const release = acquireInstanceLock(dir);
    process.on('exit', release);
  } catch (error) {
    if (error.code !== 'instance_running') throw error;
    console.error(`\x1b[31m${error.message}\x1b[0m`);
    process.exit(1);
  }
  // Any configured provider makes the host live, not only Anthropic —
  // including one an operator added from the console.
  const live = liveProvider(new ProviderStore({ dir }));
  const port = Number(process.env.BETTER_BOTS_PORT ?? 4173);
  const bind = process.env.BETTER_BOTS_HOST ?? '127.0.0.1';
  // A token chosen by the operator wins; otherwise the host keeps its own.
  const chosenToken = process.env.BETTER_BOTS_TOKEN || null;
  // The token is the console's only lock, and it may face the internet behind a
  // proxy. A short one could be guessed; the generated one is 43 characters.
  if (chosenToken && chosenToken.length < 32) {
    console.error('\x1b[31mBETTER_BOTS_TOKEN must be at least 32 characters\x1b[0m');
    console.error('Leave it unset and the host generates a strong one, or use: openssl rand -base64 32');
    process.exit(1);
  }
  const token = chosenToken ?? consoleToken(dir);

  // The console can create agents and spend your credentials. Leaving loopback
  // without a token would publish both, so this refuses rather than warns.
  if (!isLoopback(bind) && !token) {
    console.error(`\x1b[31mrefusing to bind ${bind} without BETTER_BOTS_TOKEN\x1b[0m`);
    console.error('This console has no other authentication. Set BETTER_BOTS_TOKEN, or bind 127.0.0.1 and tunnel in.');
    process.exit(1);
  }

  const host = createHost({ dir, live });
  void host.modelCatalog.list().catch((err) => console.error(`model discovery failed: ${err.message}`));
  const recovered = host.recover();
  if (recovered.memory_held) console.log(`memory: ${recovered.memory_held} save(s) queued for a different engine are held, not sent; send them with: better-bots memory release-held`);
  // Recovered runs are durable but, like automations, inert until something
  // starts them. Without this a run queued before a restart waited for the
  // next unrelated request to that agent.
  if (recovered.queued_runs.length > 0 || recovered.rearmed_wakes.length > 0 || host.messages.pendingRooms().length > 0) {
    host.drain().catch((err) => console.error(`recovery drain failed: ${err.message}`));
  }

  // Automations are durable but inert: something has to notice they are due.
  // On a laptop that was whatever command you happened to run; on a server that
  // never happens, so the process ticks itself.
  const tickMs = Number(process.env.BETTER_BOTS_TICK_MS ?? 15_000);
  const ticker = startAutomationTicker({ host, intervalMs: tickMs,
    onError: err => console.error(`tick failed: ${err.message}`) });

  // Saved integrations come up alongside the server; a slow one (uvx on first
  // run) must not hold the console hostage, so this is not awaited.
  void host.integrations.connectAll().then((all) => {
    for (const i of all) console.log(`plugin ${i.name.padEnd(12)} ${i.state}${i.tools ? ` (${i.tools.length} tools)` : ''}${i.error ? ` — ${i.error}` : ''}`);
  });

  const server = createServer({ host, live, token }).listen(port, bind, () => {
    const origin = `http://${isLoopback(bind) ? '127.0.0.1' : bind}:${port}`;
    console.log(`\x1b[1mBetter Bots\x1b[0m  ${origin}`);
    console.log(`store  ${dir}`);
    console.log('auth   token required');
    // The fragment never reaches the server or its logs; the page trades it for a cookie.
    console.log(chosenToken ? 'login  with BETTER_BOTS_TOKEN' : `login  ${origin}/#token=${token}`);
    console.log(`tick   automations every ${Math.round(tickMs / 1000)}s`);
    console.log(live
      ? `model  ${host.adapter.model ?? 'provider default'} \x1b[2m(provider plan and usage limits apply)\x1b[0m`
      : '\x1b[2mmodel  scripted stand-in — connect an AI provider in App settings for real replies\x1b[0m');
  });

  // systemd sends SIGTERM on restart. Finish what is in flight, then go.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      ticker.stop();
      const forced = setTimeout(() => process.exit(1), 10_000);
      forced.unref();
      Promise.allSettled([Promise.resolve().then(() => host.close()), new Promise((resolve) => server.close(resolve))])
        .then(() => process.exit(0));
    });
  }
}
