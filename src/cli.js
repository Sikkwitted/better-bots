#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Host } from './host.js';
import { engineFromEnv } from './services/memory-engine.js';
import { CodexAuth } from './model/codex-auth.js';
import { BANNER } from './core/version.js';
import { ScriptedAdapter } from './model/scripted-adapter.js';
import { AnthropicAdapter } from './model/anthropic-adapter.js';
import { systemClock } from './core/clock.js';
import { PROVIDERS } from '../web/models.js';
import { buildAdapter, liveProvider as isLive } from './model/build-adapter.js';
import { ProviderStore } from './services/provider-store.js';

// A small operator surface over the same services the agents use.

const dir = process.env.BETTER_BOTS_DIR ?? path.join(process.cwd(), '.data');
// The data folder holds keys, transcripts and memory: private when created here.
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

export const liveProvider = isLive;

/** One store per process; a command reads it, and the model layer reads it too. */
let store;
function providers() {
  return store ??= new ProviderStore({ dir });
}

function openHost() {
  // Interactive commands get modest settings on purpose. The library default of
  // effort:high with 64k output is right for a long agent turn and wrong for
  // someone waiting at a prompt — it can run for minutes and look like a hang.
  const adapter = buildAdapter({
    dir,
    providers: providers(),
    offlineMessage: 'No model provider configured. Set ANTHROPIC_API_KEY to use Claude.',
  });
  return new Host({ dir, adapter, clock: systemClock, memory_engine: engineFromEnv(process.env, { dir }) });
}

/**
 * Say out loud when a command is about to spend money, and that it may take a
 * while. It reports the agent's OWN model: an agent pinned to a flat-rate
 * provider is not spending per-token, and saying otherwise is worse than saying
 * nothing — the whole reason to pin a cheap model is to know what a turn costs.
 */
function noticeIfPaid(what, model = null, provider = null) {
  if (!liveProvider(providers())) return;
  const using = model ?? process.env.BETTER_BOTS_DEFAULT_MODEL ?? process.env.BETTER_BOTS_MODEL ?? 'host default';
  const route = provider ?? process.env.BETTER_BOTS_DEFAULT_PROVIDER ?? process.env.BETTER_BOTS_PROVIDER;
  const cost = route ? `uses ${providers().get(route)?.label ?? route}; provider plan and usage limits apply` : 'uses the configured host provider';
  process.stderr.write(`\x1b[2m${what} via ${using} — ${cost}; waiting...\x1b[0m\n`);
}

/** Accept a stable ID or a display name, but always act on the ID. */
function resolveAgent(host, token) {
  if (host.registry.has(token)) return host.registry.get(token);
  const matches = host.registry.list().filter(
    (a) => a.profile.name.toLowerCase() === String(token).toLowerCase(),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`"${token}" matches ${matches.length} agents; use the ID: ${matches.map((a) => a.id).join(', ')}`);
  }
  throw new Error(`no agent "${token}". Run: better-bots status`);
}

const commands = {
  status() {
    const host = openHost();
    const status = host.status();
    console.log(`store: ${dir}`);
    console.log(`computer: ${status.computer.computer_id} (${status.computer.window_count} windows)`);
    console.log(`standing permissions: ${JSON.stringify(status.standing_permissions)}`);
    console.log('\nagents');
    if (status.agents.length === 0) console.log('  (none yet — run: npm run cli -- create <name> <role>)');
    for (const a of status.agents) {
      const active = a.active_run ? `${a.active_run.lane}:${a.active_run.status}` : 'idle';
      const u = a.usage_24h ?? {};
      const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      console.log(`  ${a.name.padEnd(12)} ${a.id}  ${active.padEnd(18)} queued=${a.queued.length} inbox=${a.inbox} window=${a.window?.window_index ?? '-'}  24h=${u.runs ?? 0} runs/${fmtTokens(tokens)} tok`);
    }
    if (status.rooms.length > 0) {
      console.log('\nrooms');
      for (const r of status.rooms) console.log(`  ${r.id}  epoch=${r.epoch}  ${r.member_ids.length} members  ${r.purpose}`);
    }
    if (status.pending_approvals.length > 0) {
      console.log('\npending approvals');
      for (const r of status.pending_approvals) {
        console.log(`  ${r.id}  ${r.agent_id} wants ${r.action} on ${r.target}  expires ${r.expires_at}`);
        console.log(`     resolve with: npm run cli -- approve ${r.id} <allow_once|deny|always|never>`);
      }
    }
  },

  create([name, ...role]) {
    if (!name) throw new Error('usage: create <name> [role...]');
    const host = openHost();
    // Safe by default, as in the console: no tools that reach the host machine
    // outside the sandbox until someone grants them in Settings.
    const allowed_tools = [...host.tools.tools.values()]
      .filter((tool) => !(typeof tool.permission?.action === 'string' && tool.permission.action.startsWith('local.')))
      .map((tool) => tool.name);
    const agent = host.registry.create({ profile: { name, role: role.join(' '), allowed_tools } });
    console.log(`${agent.id}  ${agent.profile.name}`);
  },

  async ask([agentId, ...words]) {
    if (!agentId || words.length === 0) throw new Error('usage: ask <agent_id> <text...>');
    const host = openHost();
    const agent = resolveAgent(host, agentId);
    noticeIfPaid(`${agent.profile.name} is thinking`, agent.profile.model, agent.profile.model_provider);
    const run = host.userRequest({ agent_id: agent.id, text: words.join(' ') });
    await host.drain();
    const result = host.visibleResults().find((r) => r.run_id === run.id);
    if (!result) {
      console.log('(the run produced no visible result)');
    } else if (result.status === 'failed') {
      console.log(`run failed: ${result.error}`);
      process.exitCode = 1;
    } else {
      console.log(result.text || '(no visible text)');
    }
    if (result?.tools.length) console.log(`\ntools: ${result.tools.map((t) => `${t.name}[${t.decision}]`).join(', ')}`);
  },

  approve([requestId, resolution]) {
    if (!requestId || !resolution) throw new Error('usage: approve <request_id> <allow_once|deny|always|never>');
    const host = openHost();
    console.log(JSON.stringify(host.permissions.resolve(requestId, resolution, { actor: 'user' }), null, 2));
  },

  explain([runId]) {
    if (!runId) throw new Error('usage: explain <run_id>');
    const e = openHost().explain(runId);
    console.log(`run ${e.run.id}  agent=${e.run.agent_id}  lane=${e.run.lane}  status=${e.run.status}`);
    if (e.run.interrupt_reason) console.log(`interrupted: ${e.run.interrupt_reason} -> ${e.run.resume_policy}`);
    for (const event of e.audit) console.log(`  ${event.at}  ${event.type}`);
    if (e.result) console.log(`\nresult: ${e.result.text}`);
  },

  audit([count]) {
    const host = openHost();
    for (const event of host.audit.tail(Number(count) || 40)) {
      console.log(`${event.at}  ${event.type.padEnd(30)} ${JSON.stringify(omit(event, ['id', 'at', 'type']))}`);
    }
  },

  recover() {
    const host = openHost();
    console.log(JSON.stringify(host.recover(), null, 2));
  },

  async send([from, to, ...words]) {
    if (!from || !to || words.length === 0) {
      throw new Error('usage: send <from> <to> <text...> [--priority=stop|supersede|safety|time_critical]');
    }
    const host = openHost();
    const flag = words.find((w) => w.startsWith('--priority'));
    const text = words.filter((w) => w !== flag).join(' ');
    const reason = flag ? (flag.split('=')[1] || 'supersede') : null;

    const sender = resolveAgent(host, from);
    const target = host.rooms.has(to) ? { id: to } : resolveAgent(host, to);
    const ack = host.deliverPeerMessage({
      sender_id: sender.id, target_id: target.id, text,
      priority: Boolean(reason), priority_reason: reason,
    });
    console.log(`${ack.message_id}  priority=${ack.priority}`);
    console.log(ack.note);
    for (const note of ack.capability_notes) console.log(`note: ${note}`);
    if (ack.interrupt_note) console.log(`scheduler: ${ack.interrupt_note}`);

    // The reply, if any, arrives on a later wake. Run it now so the CLI shows it.
    noticeIfPaid(
      `${host.registry.has(target.id) ? host.registry.get(target.id).profile.name : 'the room'} is waking`,
      host.registry.has(target.id) ? host.registry.get(target.id).profile.model : null,
    );
    await host.drain();
    const inbound = host.transcripts.all('agent', target.id).filter((e) => e.kind === 'peer_message_in');
    if (inbound.length) console.log(`\ndelivered on a later wake: "${inbound.at(-1).text.slice(0, 120)}"`);
  },

  async room([purpose, ...members]) {
    // As in the console, only the members remember the outcome unless asked:
    // --shared puts it in project memory for every bot, --room-only keeps it in
    // the room's own history, --forget keeps it nowhere.
    // (--private is still accepted; it is the default.)
    const memory = members.includes('--shared') ? 'project' : members.includes('--room-only') ? 'room' : members.includes('--forget') ? 'none' : 'members';
    members = members.filter((m) => !m.startsWith('--'));
    if (!purpose || !members.length) throw new Error('usage: room "<purpose>" <agent> [...] [--shared|--room-only|--forget]');
    const host = openHost();
    const ids = members.map((m) => resolveAgent(host, m).id);
    const created = host.createRoom({ member_ids: ids, purpose, memory });
    // From the CLI a room is still a one-shot meeting: the purpose is the request.
    noticeIfPaid(`${ids.length} agents meeting (up to ${host.rooms.limits.MAX_MESSAGES} turns)`);
    const result = await host.runRoom(created.id, { request: purpose });
    console.log(`${created.id}  ${result.total_messages} message(s), stopped: ${result.stop_reason}\n`);
    for (const m of result.transcript.filter((x) => !x.system)) {
      console.log(`  ${host.registry.get(m.sender_id).profile.name.padEnd(12)} ${m.text}`);
    }
  },

  // schedule <agent> "<name>" --cron "0 7 * * 1-5" [--tz America/Chicago] <text...>
  // schedule <agent> "<name>" --every 6h <text...>
  // schedule <agent> "<name>" --at 2026-09-04T12:00:00Z <text...>
  schedule(args) {
    const host = openHost();
    const [agentToken, name, ...rest] = args;
    if (!agentToken || !name) throw new Error('usage: schedule <agent> "<name>" (--cron "<expr>" [--tz <zone>] | --every <e.g. 6h> | --at <iso>) <text...>');
    const opts = { cron: null, timezone: 'UTC', every_ms: null, due_at: undefined };
    const words = [];
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--cron') opts.cron = rest[++i];
      else if (a === '--tz') opts.timezone = rest[++i];
      else if (a === '--every') opts.every_ms = parseDuration(rest[++i]);
      else if (a === '--at') opts.due_at = rest[++i];
      else words.push(a);
    }
    const agent = resolveAgent(host, agentToken);
    const item = host.scheduleAutomation({ agent_id: agent.id, name, text: words.join(' '), ...opts });
    const when = item.cron ? `cron "${item.cron}" (${item.timezone})` : item.every_ms ? `every ${item.every_ms / 1000}s` : 'once';
    console.log(`${item.id}  ${agent.profile.name}  ${when}  next: ${item.due_at}`);
  },

  automations() {
    const host = openHost();
    const items = host.listAutomations();
    if (items.length === 0) return console.log('no automations');
    for (const i of items) {
      const when = i.cron ? `cron "${i.cron}" ${i.timezone}` : i.every_ms ? `every ${i.every_ms / 1000}s` : 'once';
      console.log(`  ${i.id}  ${host.registry.has(i.agent_id) ? host.registry.get(i.agent_id).profile.name.padEnd(12) : i.agent_id}  ${when.padEnd(28)} next=${i.fired ? 'done' : i.due_at}  fires=${i.fires ?? 0}  ${i.name}`);
    }
  },

  async consolidate(args) {
    const host = openHost();
    const results = await host.consolidateMemory({ force: true });
    if (!results.length) return console.log('nothing to consolidate: no bank has new evidence');
    for (const r of results) {
      const detail = r.outcome === 'committed' ? `${r.statements} verified statement(s)${r.dropped?.length ? `, ${r.dropped.length} dropped as unsupported` : ''}`
        : r.reason ?? r.error ?? '';
      console.log(`  ${`${r.scope}-${r.owner_id}`.padEnd(28)} ${r.outcome.padEnd(10)} ${detail}`);
    }
  },

  memory([sub]) {
    if (sub !== 'release-held') throw new Error('usage: memory release-held');
    const host = openHost();
    host.memory.recover();
    const released = host.memory.retention.releaseHeld();
    console.log(released.length ? `released ${released.length} held save(s) to ${host.memory.retention.engineName}` : 'nothing is held');
    return host.memory.flush();
  },

  'delete-group'([roomId]) {
    if (!roomId) throw new Error('usage: delete-group <room_id>');
    const removed = openHost().rooms.delete(roomId, { confirm: true, actor: 'cli' });
    console.log(`deleted group ${removed.id} (${removed.purpose})`);
  },

  unschedule([automationId]) {
    if (!automationId) throw new Error('usage: unschedule <automation_id>');
    const removed = openHost().cancelAutomation(automationId);
    console.log(`cancelled ${removed.id} (${removed.name})`);
  },

  import([sourceDir]) {
    if (!sourceDir) throw new Error('usage: import <directory>   (SKILL.md, CLAUDE.md, AGENTS.md, .claude/CLAUDE.md, .cursor/rules/*)');
    const host = openHost();
    // A folder with a SKILL.md is a skill: manifest plus its declared files,
    // helper scripts stored but never run here. Anything else is instruction files.
    const isSkill = ['SKILL.md', 'skill.md'].some((m) => fs.existsSync(path.join(sourceDir, m)));
    const imported = isSkill
      ? [host.workflows.importSkill(sourceDir, { source_ecosystem: 'claude' })]
      : host.workflows.importFromDirectory(sourceDir, { source_ecosystem: 'local' });
    if (imported.length === 0) console.log('no supported instruction files found');
    for (const w of imported) console.log(`${w.id}  ${w.name}  (${w.source_ecosystem})`);
    console.log('\nnothing is enabled by import. Grant it: better-bots enable <workflow_id> <agent>');
  },

  enable([workflowId, agentToken]) {
    if (!workflowId || !agentToken) throw new Error('usage: enable <workflow_id> <agent>');
    const host = openHost();
    const agent = resolveAgent(host, agentToken);
    const w = host.workflows.enableFor(workflowId, agent.id, { actor: 'user' });
    console.log(`${w.name} enabled for ${agent.profile.name} (${agent.id})`);
  },

  /** Answers "is it ready to go" without spending anything. */
  doctor() {
    const host = openHost();
    const checks = [];
    // node:sqlite (the default memory engine) needs no flag from 22.13.
    const [major, minor] = process.versions.node.split('.').map(Number);
    checks.push([major > 22 || (major === 22 && minor >= 13), `node ${process.versions.node} (need >= 22.13 for built-in SQLite memory)`]);

    let sdk = false;
    try { import.meta.resolve('@anthropic-ai/sdk'); sdk = true; } catch { sdk = false; }
    checks.push([sdk, sdk ? 'anthropic sdk installed' : 'anthropic sdk missing — run: npm install @anthropic-ai/sdk']);

    // Any provider with a key, or a subscription the host can read, makes the box live.
    const all = providers().all();
    const keyed = Object.entries(all).filter(([, spec]) => spec.key_env?.length > 0 && spec.key_env.some((name) => process.env[name])).map(([id]) => id);
    const custom = Object.keys(all).filter((id) => providers().isCustom(id));
    const codex = new CodexAuth().status();
    checks.push([keyed.length > 0, keyed.length ? `API keys present for: ${keyed.join(', ')}` : 'no provider API key in the environment']);
    if (custom.length) checks.push([true, `custom providers: ${custom.map((id) => `${id} (${all[id].base_url})`).join(', ')}`]);
    checks.push([codex.signed_in, codex.signed_in
      ? `ChatGPT subscription signed in${codex.plan ? ` (${codex.plan})` : ''}; token good until ${codex.expires_at}, refreshes itself`
      : `ChatGPT subscription not signed in — connect in App settings → AI providers`]);

    const live = (sdk && keyed.length > 0) || codex.signed_in;
    checks.push([true, `store ${dir} (${host.registry.list().length} agent(s))`]);    checks.push([live, live ? 'agents will talk to a real model' : 'agents will talk to the scripted stand-in, not a real model']);

    for (const [ok, text] of checks) console.log(`${ok ? '  ok ' : ' warn'}  ${text}`);
    console.log(live
      ? '\nready. Prove the live path with one small paid call: better-bots smoke'
      : '\nthe host works offline, but agents will not think until the two warnings above are cleared.');
    if (!live) process.exitCode = 1;
  },


  /** What is connected and what each lends. Spends nothing; does not connect. */
  plugins() {
    const host = openHost();
    const all = host.integrations.describe();
    if (!all.length) {
      console.log('no integrations. Connect one: better-bots connect <preset|name> ...\n');
      for (const p of host.integrations.presets()) console.log(`  ${p.id.padEnd(12)} ${p.label}${p.sign_in ? '  (signs in through the console)' : p.secret && !p.secret.optional ? `  (needs: ${p.secret.label})` : ''}`);
      return;
    }
    for (const i of all) {
      const where = i.transport === 'http' ? i.url : [i.command, ...(i.args ?? [])].join(' ');
      console.log(`${i.name.padEnd(14)} ${i.transport.padEnd(6)} ${i.trust.padEnd(11)} ${where}${i.preset ? `  [${i.preset}]` : ''}`);
    }
    console.log('\nstate is live only while the server runs; the console shows tools and sign-in.');
  },

  /**
   * connect <preset> [--key K] [--url U] [--name N] [--read-only]
   * connect <name> --url U [--header K=V ...] [--read-only]
   * connect <name> --command "uvx --from x y" [--env K=V ...] [--read-only]
   */
  async connect(args) {
    const flags = parseFlags(args);
    const [token] = flags._;
    if (!token) throw new Error('usage: connect <preset|name> [--key K] [--url U] [--header K=V] [--command "..."] [--env K=V] [--read-only]');
    const host = openHost();
    if (flags['read-only']) console.log('Read-only access now requires a per-tool review in Plugins; --read-only does not bypass review.');
    const trust = undefined;
    let input;
    if (host.integrations.presets().some((p) => p.id === token)) {
      input = { preset: token, name: flags.name ?? token, key: flags.key ?? '', url: flags.url ?? '', trust };
    } else if (flags.url) {
      input = { name: token, url: flags.url, headers: pairs(flags.header), trust };
    } else if (flags.command) {
      const [command, ...rest] = String(flags.command).split(/\s+/);
      input = { name: token, command, args: rest, env: pairs(flags.env), trust };
    } else {
      throw new Error(`"${token}" is not a preset (${host.integrations.presets().map((p) => p.id).join(', ')}); give --url or --command`);
    }
    process.stderr.write(`\x1b[2mconnecting ${input.name}...\x1b[0m\n`);
    const shown = await host.integrations.add(input);
    if (shown.state === 'connected') {
      console.log(`${shown.name}: connected — ${shown.tools.length} tools`);
      for (const t of shown.tools) console.log(`  ${t.action ?? (t.read_only ? 'integration.read' : 'external.unclassified')}  ${t.name}`);
    } else if (shown.state === 'needs_sign_in') {
      console.log(`${shown.name}: saved. It wants a person: open the console, Plugins, and press Sign in.`);
    } else {
      console.log(`${shown.name}: ${shown.state} — ${shown.error}`);
      process.exitCode = 1;
    }
    await host.integrations.close();
  },

  async disconnect([name]) {
    if (!name) throw new Error('usage: disconnect <name>');
    const host = openHost();
    await host.integrations.remove(name);
    console.log(`${name}: removed`);
  },

  /**
   * providers                          what can serve a turn, and what each lists
   * add-provider <label> <base_url>    an OpenAI-compatible endpoint, with --key
   * remove-provider <id>               remove one and its manual models
   * add-model <provider> <model_id>    a model the provider does not list; --label, --key
   * remove-model <provider> <model_id>
   */
  providers() {
    const all = providers().all();
    const manual = providers().manualModels();
    const rows = Object.entries(all).map(([id, spec]) => {
      const models = manual.filter((m) => m.provider === id);
      const state = spec.oauth
        ? (new CodexAuth().status().signed_in ? 'signed in' : 'not signed in')
        : !spec.key_env?.length ? 'local (no key)'
        : providers().keyed(id) ? 'key set' : 'no key';
      return { id, label: spec.label, state, where: spec.base_url ?? '—', models: models.length };
    });
    const width = Math.max(...rows.map((r) => r.id.length), 8);
    console.log('PROVIDER'.padEnd(width) + '  STATE          ENDPOINT                              MANUAL MODELS');
    for (const r of rows) console.log(`${r.id.padEnd(width)}  ${r.state.padEnd(14)}  ${r.where.padEnd(38)}  ${r.models}`);
    if (!manual.length) return;
    console.log('\nmanually added models');
    for (const m of manual) console.log(`  ${m.provider} / ${m.id}${m.label ? `  (${m.label})` : ''}`);
  },

  'add-provider'([label, baseUrl, ...rest]) {
    const flags = parseFlags(rest);
    if (!label || !baseUrl) throw new Error('usage: add-provider <label> <base_url> [--key K]');
    const spec = providers().addProvider({ label, base_url: baseUrl, key: flags.key, wire: 'openai' });
    console.log(`${spec.id}  ${spec.label}  ${spec.base_url}`);
    console.log(providers().keyed(spec.id) ? 'key saved; models are discovered on use or from the console.'
      : 'no key given — save one with: better-bots add-provider <label> <url> --key K, or in the console.');
  },

  'remove-provider'([id]) {
    if (!id) throw new Error('usage: remove-provider <id>');
    providers().removeProvider(id);
    console.log(`${id}: removed`);
  },

  'add-model'([provider, modelId, ...rest]) {
    const flags = parseFlags(rest);
    if (!provider || !modelId) throw new Error('usage: add-model <provider> <model_id> [--label "Display name"] [--key K]');
    const entry = providers().addModel({ provider, model: modelId, label: flags.label, key: flags.key });
    console.log(`added ${entry.provider} / ${entry.id}${entry.label ? ` (${entry.label})` : ''}`);
    console.log('agents can pin it in settings, or set it as the host default with BETTER_BOTS_DEFAULT_MODEL.');
  },

  'remove-model'([provider, modelId]) {
    if (!provider || !modelId) throw new Error('usage: remove-model <provider> <model_id>');
    providers().removeModel(provider, modelId);
    console.log(`removed ${provider} / ${modelId}`);
  },

  help() {
    console.log(`${BANNER}

  status                    agents, lanes, inboxes, screens, pending approvals
  doctor                    can this host actually run thinking agents?
  create <name> [role...]   register an agent
  ask <agent> <text>        send a user-lane request and print the visible result
  send <from> <to> <text>   peer message; add --priority=<reason> to supersede
  room "<purpose>" <a> [b...]  run a bounded meeting and print the transcript
                            only members remember it; --shared adds it to project memory,
                            --room-only keeps it in the room, --forget to none
  import <dir>              import a SKILL.md skill, or CLAUDE.md / AGENTS.md / .cursor/rules
  enable <workflow> <agent> let one agent use an imported workflow
  approve <req> <answer>    allow_once | deny | always | never
  explain <run_id>          what happened in one run, and why
  audit [n]                 the last n audit events
  recover                   re-arm queued work after a restart
  schedule <agent> "<name>" --cron "0 7 * * 1-5" --tz America/Chicago <text>
                            or --every 6h, or --at <iso>; runs in the automation lane
  automations               list schedules and when each fires next
  memory release-held       send saves held after an engine change to the engine configured now
  consolidate               rewrite each bot's settled knowledge now; every statement must cite
                            saved memory and pass a second model's check (costs model calls)
  delete-group <room_id>    delete a group (its transcript stays on disk)
  unschedule <id>           cancel a schedule
  plugins                   connected MCP servers (integrations) and the presets
  connect <preset|name> ... connect an MCP server: --key, --url, --header K=V, --command "...", --read-only
  disconnect <name>         remove an integration and its tools
  providers                 what can serve a turn: built-in, custom, and manual models
  add-provider <label> <url>  an OpenAI-compatible endpoint of your own; --key K
  remove-provider <id>      remove a custom provider and its manual models
  add-model <provider> <id>  a model the provider does not list; --label "Name" --key K
  remove-model <provider> <id>

  store: BETTER_BOTS_DIR (default ./.data)
  memory: SQLite in the store by default; HINDSIGHT_URL to use Hindsight instead
  model: set ANTHROPIC_API_KEY to route turns to Claude, or add your own endpoint: add-provider
  tuning: BETTER_BOTS_MODEL, BETTER_BOTS_EFFORT (default medium), BETTER_BOTS_MAX_TOKENS (8192), BETTER_BOTS_TIMEOUT_MS (120000)`);
  },
};

function omit(obj, keys) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

// Only act when invoked as a program. Importing this file (tests, tooling) must
// not run a command.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2);
  const run = commands[command] ?? commands.help;
  try {
    await run(rest);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}

/** `--key v --header A=1 --header B=2 --read-only x y` -> { key: 'v', header: ['A=1','B=2'], 'read-only': true, _: ['x','y'] } */
function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    const next = args[i + 1];
    const value = inline ?? (next !== undefined && !next.startsWith('--') ? args[++i] : true);
    if (key in out && key !== '_') out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

/** ['A=1', 'B=2'] -> { A: '1', B: '2' } */
function pairs(list) {
  const out = {};
  for (const item of [].concat(list ?? [])) {
    if (item === true) continue;
    const [k, ...rest] = String(item).split('=');
    if (k) out[k] = rest.join('=');
  }
  return out;
}

function fmtTokens(n) {
  return n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "90s", "15m", "6h", "1d" -> milliseconds. */
function parseDuration(text) {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(text ?? '').trim());
  if (!m) throw new Error(`duration like 15m, 6h, or 1d expected, got "${text}"`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}
