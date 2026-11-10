import { retryRead } from './connection.js';
import { draftStore } from './draft-store.js';
import { mountSubscriptionLogin } from './subscription-login.js';
import { presentChatEntries, groupChatActivity, hasVisibleWork, withApprovalStatus, roomProgress } from './chat-presentation.js';
import { createWorkflowPanel } from './workflows.js';
// The interface layer. It holds no orchestration state of its own — it renders
// what the host reports and posts intents back to it.

import { avatarImage, normalizeShape, normalizeStyle, normalizeColor, normalizeHair, hairOptions, COLORS, SHAPE_NAMES, STYLES, HAIRS } from './avatar.js';
import { encodeModelChoice, decodeModelChoice, modelOptions, modelLabel, modelCatalogStatus, createModelCatalog, providerStatus } from './model-picker.js';
import { ImageAttachmentDraft, captureComposerSubmission, requestForSubmission, restoreFailedText, attachmentQueueNote, renderAttachmentGallery } from './image-attachments.js';
import { createJobsPanel } from './jobs.js';
import { reasoningOptions, EFFORT_LABELS } from './reasoning.js';
import { createDesktopViewer } from './desktop-viewer.js';
import { orderProviders, providerTitle, PROVIDER_COPY, missingSuggestions } from './provider-copy.js';
import { ZONE_COPY, MODE_COPY, zoneTitle, describeRequest, standingRuleHelp, OUTCOME_TOAST } from './permission-copy.js';
import { renderMarkdown } from './markdown.js';
import { attentionSnapshot, attentionChanges } from './attention-alerts.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const state = { agents: [], rooms: [], approvals: [], automations: [], selected: null, selectedKind: 'agent', live: false };

const desktopViewer = createDesktopViewer({root: $('#desktop-viewer'), status: $('#desktop-status'), screen: $('#desktop-screen'), enlarge: $('#desktop-enlarge'), control: $('#desktop-control'), retry: $('#desktop-retry'), dialog: $('#desktop-dialog'), openDesktop: agent_id => api('POST', '/api/desktop/connect', {agent_id})});

async function api(method, route, body) {
  const res = await fetch(route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || data.error || `${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function base64FromBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
  }
  return btoa(chunks.join(''));
}

async function uploadImage(file) {
  const { attachment } = await api('POST', '/api/attachments/images', {
    name: file.name,
    media_type: file.type,
    data: base64FromBytes(await file.arrayBuffer()),
  });
  return attachment;
}

/** Trade the token for a cookie — EventSource cannot send an Authorization header. */
function unlock() {
  const form = $('#token-form');
  form.hidden = false;
  form.querySelector('input').focus();
  return new Promise((resolve) => {
    form.onsubmit = async (submitEvent) => {
      submitEvent.preventDefault();
      // The whole login link works as well as the bare token.
      const typed = String(new FormData(form).get('token')).trim();
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: typed.match(/#token=([^&\s]+)/)?.[1] ?? typed }),
      });
      if (!res.ok) return banner('That token was not accepted.', true);
      form.hidden = true;
      form.reset();
      resolve();
    };
  });
}

/**
 * The login link the host prints carries the token in the fragment, which the
 * browser never sends anywhere. Trade it for the cookie once, then take it out
 * of the address bar so it does not linger in history or get shared by accident.
 */
async function loginFromLink() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) return;
  history.replaceState(null, '', location.pathname + location.search);
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => null);
  if (!res?.ok) banner('That login link was not accepted. Paste the token instead.', true);
}

let bannerTimer;
function banner(text, bad = false) {
  const node = $('#banner');
  node.textContent = text;
  node.className = `banner${bad ? ' bad' : ''}`;
  node.setAttribute('role', bad ? 'alert' : 'status');
  node.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { node.hidden = true; }, bad ? 6000 : 3000);
}

// -------------------------------------------------------------------- jobs ---

const jobs = createJobsPanel({
  panel: $('#jobs-panel'), api, getAgents: () => state.agents,
  onVisibilityChange(visible, agentId, returnFocus) {
    $('#all-jobs').setAttribute('aria-expanded', String(visible && !agentId));
    $('#open-jobs').setAttribute('aria-expanded', String(visible && !!agentId));
    $('#transcript').hidden = visible;
    $('#composer').hidden = visible;
    if (visible) { closeSettings(); closeMemory(); $('#thoughts').hidden = true; showPane('chat'); }
    else { renderHead(); if (returnFocus && !agentId) showPane('agents'); }
  },
});
const confirmDiscardSettings = () => !agentSettingsDirty() || confirm('Discard unsaved bot settings?');
$('#all-jobs').onclick = (event) => { if (confirmDiscardSettings()) jobs.open(null, event.currentTarget); };
$('#open-jobs').onclick = (event) => {
  if (state.selectedKind === 'agent' && state.selected && confirmDiscardSettings()) jobs.open(state.selected, event.currentTarget);
};

// ------------------------------------------------------------------- state ---

function showEmptyInstallation() {
  const content = $('#transcript-content');
  let title = $('#empty-title');
  let description = $('#empty-description');
  let create = $('#empty-create-agent');
  if (!title || !description || !create) {
    const empty = el('div', 'empty');
    title = el('h2'); title.id = 'empty-title';
    description = el('p'); description.id = 'empty-description';
    create = el('button', 'primary', 'Create your first bot');
    create.id = 'empty-create-agent'; create.type = 'button';
    empty.append(title, description, create);
    content.replaceChildren(empty);
  }
  title.textContent = 'Better Bots';
  description.textContent = 'Create a bot, choose its model, then start a conversation. Connect an AI provider in App settings for live replies.';
  create.hidden = false;
  create.onclick = () => {
    showPane('agents');
    if ($('#agent-form').hidden) $('#new-agent').click();
  };
}

let refreshSerial = 0;
async function refresh(reconcileJobs = true) {
  const request = ++refreshSerial;
  const jobsRevision = jobs.revision;
  const data = await api('GET', '/api/state');
  if (request !== refreshSerial) return;
  showAutonomyNotice(data.autonomy_acknowledged);
  state.modelProvider = data.model_provider;
  state.roomStartEnabled = data.capabilities?.room_start === true;
  state.agentStopEnabled = data.capabilities?.agent_stop === true;
  state.desktopEnabled = data.capabilities?.desktop !== false;
  state.reconciliation = data.reconciliation ?? [];
  state.previews = data.previews ?? [];
  state.logCorruption = data.log_corruption ?? [];
  state.agents = data.agents;
  state.desks = data.desks ?? [];
  const jobsUpdated = jobs.update(data, jobsRevision);
  state.automations = jobs.items;
  state.rooms = data.rooms;
  state.approvals = data.pending_approvals;
  state.agents = state.agents.map(agent => ({ ...agent, active_run: withApprovalStatus(agent.active_run, state.approvals) }));
  state.blocked = data.blocked ?? [];
  state.live = data.live;
  $('#provider-notice').hidden = state.live !== false;
  // A side channel: a notification failing must never stop the console refreshing.
  try { announceAttention(); } catch { /* notifications are best effort */ }
  state.model = data.model;
  state.standing = data.standing_permissions ?? {};
  state.explicitPermissions = data.explicit_permissions ?? {};
  state.ceilings = data.permission_ceilings ?? {};
  // "1.0.0 · Better Bots" just repeats the name beside it; show the codename only once it differs.
  if (data.version) $('#brand-version').textContent = data.codename && data.codename !== (data.product ?? 'Better Bots') ? `${data.version} · ${data.codename}` : data.version;
  if (state.selectedKind === 'agent' && !state.agents.some((a) => a.id === state.selected)) {
    // The console opens on the lead: that is who returns the one answer.
    state.selected = (state.agents.find((a) => a.lead) ?? state.agents[0])?.id ?? null;
  }
  if (!state.agents.length && !state.selected) showEmptyInstallation();
  renderAgents();
  renderRooms();
  renderApprovals();
  renderPermissions();
  renderHead();
  renderComposer();
  // Reasoning deltas do not emit audit events. Poll the conversation as well
  // as status so the in-flight reasoning remains visible before the answer.
  clearTimeout(liveTick);
  if (state.agents.some((a) => a.active_run)) liveTick = setTimeout(async () => {
    try { await refresh(); await loadTranscript(); }
    catch (error) {
      banner(`Could not refresh live conversation: ${error.message}`, true);
      liveTick = setTimeout(() => refresh().catch(() => {}), 2000); // keep polling while a run is active
    }
  }, 700);
  // A mutation acknowledgement can invalidate the final SSE read on an idle
  // host. Only the latest response gets one guarded follow-up, never a retry loop.
  if (!jobsUpdated && reconcileJobs) await refresh(false);
}
let liveTick;

function agentById(id) {
  return state.agents.find((a) => a.id === id);
}

// ----------------------------------------------------------------- avatars ---

function resetFieldset(box) {
  box.replaceChildren(box.querySelector('legend'));
}

/** One big preview you can actually see, and three things to cycle: body,
    character, colour. Click the face to cycle the character. Hidden inputs
    carry the choice so the forms read it with FormData like any other field. */
const COLOR_NAMES = { '#51FFCD': 'mint', '#37FF5D': 'green', '#F5FF32': 'yellow', '#FF8234': 'orange', '#FEDE8D': 'sand', '#E1FFF3': 'ice', '#B5B5B5': 'grey', '#000000': 'black', '#FE3E51': 'red' };

function buildPicker(box, group, chosen = {}) {
  const state = {
    shape: normalizeShape(chosen.shape),
    style: normalizeStyle(chosen.style),
    color: normalizeColor(chosen.color),
    hair: normalizeHair(chosen.hair),
  };
  const lists = { shape: SHAPE_NAMES, style: STYLES, color: COLORS, hair: HAIRS };
  const labels = { shape: 'Body', style: 'Character', color: 'Colour', hair: 'Hair' };
  const rows = {};

  resetFieldset(box);
  const hidden = {};
  for (const key of Object.keys(lists)) {
    hidden[key] = el('input');
    hidden[key].type = 'hidden';
    hidden[key].name = `${group}-${key}`;
    box.append(hidden[key]);
  }

  const stage = el('button', 'avatar-stage');
  stage.type = 'button';
  stage.title = 'Click to cycle the character';
  stage.setAttribute('aria-label', 'Preview. Click to cycle the character.');
  box.append(stage);

  const steppers = el('div', 'avatar-steppers');
  const values = {};
  const step = (key, delta) => {
    const list = key === 'hair' ? hairOptions(state.style) : lists[key];
    state[key] = list[(list.indexOf(state[key]) + delta + list.length) % list.length];
    render();
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  for (const key of Object.keys(lists)) {
    const row = el('div', 'stepper');
    const prev = el('button', 'ghost step', '‹');
    prev.type = 'button';
    prev.setAttribute('aria-label', `Previous ${labels[key].toLowerCase()}`);
    prev.onclick = () => step(key, -1);
    const next = el('button', 'ghost step', '›');
    next.type = 'button';
    next.setAttribute('aria-label', `Next ${labels[key].toLowerCase()}`);
    next.onclick = () => step(key, 1);
    const text = el('span', 'stepper-value');
    const small = el('small', null, labels[key]);
    const strong = el('strong');
    text.append(small, strong);
    values[key] = strong;
    row.append(prev, text, next);
    rows[key] = row;
    steppers.append(row);
  }
  box.append(steppers);

  function render() {
    stage.replaceChildren(avatarImage(state.shape, state.style, state.color, { size: 132, className: 'avatar avatar-big', hair: state.hair }));
    // Hair only offers what this character's renders can show: colour where it
    // has hair. A choice the character cannot show snaps back to the default.
    const hairs = hairOptions(state.style);
    if (!hairs.includes(state.hair)) state.hair = 'dark';
    rows.hair.hidden = hairs.length < 2;
    for (const key of Object.keys(lists)) {
      hidden[key].value = state[key];
      if (key === 'color') {
        const dot = el('i', 'dot');
        dot.style.setProperty('--c', state.color);
        values[key].replaceChildren(dot, ` ${COLOR_NAMES[state.color.toUpperCase()] ?? state.color}`);
      } else {
        values[key].textContent = state[key];
      }
    }
  }
  stage.onclick = () => step('style', 1);
  render();
}

const workflows = createWorkflowPanel({ dialog: $('#workflow-manager'), api,
  getAgents: () => state.agents, onVisibility: desks => { state.desks = desks; renderAgents(); } });
$('#manage-workflows').onclick = event => workflows.open(event.currentTarget);

// ------------------------------------------------------------------- models ---

let modelsReady = false;
const modelCatalog = createModelCatalog(
  (force) => api('GET', `/api/models${force ? '?refresh=1' : ''}`),
  () => { renderModelPickers(); renderHead(); updateProviderStatuses(); },
);

function refreshModels(force = false) {
  if (modelsReady) return modelCatalog.refresh(force);
}

/** Read the current selection at render time, including edits made during discovery. */
function buildModelSelect(select, chosen = select.value) {
  const picker = modelOptions(modelCatalog.data, chosen);
  select.replaceChildren();
  const inherit = el('option', null, 'Host default');
  inherit.value = '';
  select.append(inherit);
  for (const group of picker.groups) {
    const box = el('optgroup');
    box.label = group.label;
    for (const model of group.options) {
      const option = el('option', null, model.label);
      option.value = model.value;
      option.title = model.description;
      option.disabled = Boolean(model.disabled);
      box.append(option);
    }
    select.append(box);
  }
  select.value = picker.value;
}

function renderModelPickers() {
  const status = modelCatalogStatus(modelCatalog);
  for (const prefix of ['create', 'edit']) {
    const select = $(`#${prefix}-model`);
    buildModelSelect(select);
    select.setAttribute('aria-busy', String(modelCatalog.busy));
    $(`#${prefix}-model-refresh`).disabled = !modelsReady || modelCatalog.busy;
    const note = $(`#${prefix}-model-status`);
    if (note.textContent !== status) note.textContent = status;
  }
}

// --------------------------------------------------------------- providers ---

function updateProviderStatuses() {
  for (const row of document.querySelectorAll('#providers .provider')) {
    if (!row.providerInfo) continue;
    const status = providerStatus(row.providerInfo, modelCatalog.data.providers.find((p) => p.id === row.providerInfo.id));
    const chip = row.querySelector('.provider-head .chip');
    chip.textContent = status.label;
    chip.className = `chip ${status.failed ? 'inbox' : 'agent'}`;
    const detail = row.querySelector('.provider-discovery-status');
    detail.textContent = status.detail;
    detail.hidden = !status.detail;
  }
}

/** Shows which providers can serve a turn, and takes a key for the ones that cannot. */
let subscriptionPanel = null;
async function renderProviders() {
  const box = $('#providers');
  if (box.hidden) return;
  subscriptionPanel?.dispose();
  box.replaceChildren();
  let providers;
  try {
    ({ providers } = await api('GET', '/api/providers'));
  } catch (err) {
    box.append(el('p', 'hint', err.message));
    return;
  }

  for (const provider of orderProviders([...providers])) {
    const copy = PROVIDER_COPY[provider.id] ?? {};
    const row = el('div', 'provider');
    row.providerInfo = provider;
    const head = el('div', 'provider-head');
    head.append(el('strong', null, providerTitle(provider)));

    head.append(el('span', `chip ${provider.configured ? 'agent' : 'inbox'}`,
      providerStatus(provider).label));
    if (provider.custom) {
      // An operator's own endpoint can be taken back out; a built-in one can only be re-keyed.
      const remove = el('button', 'ghost small', 'Remove');
      remove.type = 'button';
      remove.onclick = async () => {
        if (!confirm(`Remove the ${provider.label} provider and its manually added models? Bots pinned to it must be re-pinned.`)) return;
        try {
          const result = await api('DELETE', '/api/custom-providers', { provider: provider.id });
          banner(`${provider.label} removed${result.body?.agents_pinned?.length ? `; re-pin: ${result.body.agents_pinned.join(', ')}` : ''}`);
        } catch (err) {
          banner(`Provider was not removed: ${err.message}`, true);
          return;
        }
        await modelCatalog.refresh(true);
        await renderProviders();
      };
      head.append(remove);
    }
    row.append(head);
    if (copy.blurb) row.append(el('p', 'provider-blurb', copy.blurb));
    // The address only matters for providers someone added themselves.
    if (provider.base_url && provider.custom) row.append(el('p', 'hint provider-endpoint', provider.base_url));
    if (copy.note) row.append(el('p', 'hint provider-note', copy.note));
    row.append(el('p', 'hint provider-discovery-status'));

    // Models a person vouched for, whatever provider lists or fails to list.
    for (const model of provider.models ?? []) {
      const line = el('div', 'provider-model');
      line.append(el('span', null, `${model.id}${model.label ? ` — ${model.label}` : ''}`));
      const drop = el('button', 'ghost small', 'Remove');
      drop.type = 'button';
      drop.onclick = async () => {
        try {
          await api('DELETE', '/api/models', { provider: provider.id, model: model.id });
        } catch (err) {
          banner(`Model was not removed: ${err.message}`, true);
          return;
        }
        await modelCatalog.refresh(true);
        await renderProviders();
      };
      line.append(drop);
      row.append(line);
    }

    // One-click suggestions, so adding Claude models doesn't mean knowing their exact IDs.
    const suggestions = missingSuggestions(provider.id, provider.models ?? [], modelCatalog.data.models ?? []);
    if (suggestions.length) {
      const suggest = el('div', 'provider-suggest');
      suggest.append(el('span', 'hint', 'Add a model:'));
      for (const model of suggestions) {
        const add = el('button', 'ghost small', `+ ${model.label}`);
        add.type = 'button';
        add.title = model.id;
        add.onclick = async () => {
          add.disabled = true;
          try { await api('POST', '/api/models', { provider: provider.id, model: model.id, label: model.label }); }
          catch (err) { banner(`${model.label} was not added: ${err.message}`, true); add.disabled = false; return; }
          banner(`${model.label} added. Pick it in a bot’s settings${provider.configured ? '.' : ' once you’ve added your API key.'}`);
          await modelCatalog.refresh(true);
          await renderProviders();
        };
        suggest.append(add);
      }
      row.append(suggest);
    }

    if (provider.oauth) {
      subscriptionPanel = mountSubscriptionLogin({ root: row, provider, api, onConnected: async () => {
        banner('ChatGPT connected. Loading your subscription models…');
        await modelCatalog.refresh(true);
        await renderProviders();
      } });
      box.append(row);
      updateProviderStatuses();
      continue;
    }
    if (!provider.needs_key && !provider.custom) {
      row.append(el('p', 'hint', 'Runs locally — no key needed.'));
      box.append(row);
      updateProviderStatuses();
      continue;
    }

    const edit = el('button', provider.configured ? 'ghost small' : 'primary small', provider.configured ? 'Change key' : 'Add API key');
    edit.type = 'button';
    edit.setAttribute('aria-label', `${provider.configured ? 'Change the key for' : 'Add an API key for'} ${providerTitle(provider)}`);
    edit.setAttribute('aria-expanded', 'false');
    head.append(edit);
    const form = el('form', 'provider-form provider-editor');
    form.hidden = true;
    const name = el('input');
    name.value = provider.label;
    name.required = true;
    name.maxLength = 40;
    const url = el('input');
    url.type = 'url';
    url.value = provider.base_url ?? '';
    url.required = true;
    const field = (title, control) => {
      const label = el('label', 'provider-field', title);
      label.append(control);
      form.append(label);
    };
    if (provider.custom) { field('Provider name', name); field('Base URL', url); }
    const input = el('input');
    input.type = 'password';
    input.placeholder = provider.configured ? 'Leave blank to keep saved key' : 'Paste your API key';
    input.required = !provider.custom && !provider.configured;
    input.autocomplete = 'off';
    const save = el('button', 'ghost', 'Save');
    save.type = 'submit';
    field('API key', input);
    const keyHelp = el('p', 'hint', provider.configured ? 'Your saved key is kept unless you enter a replacement.' : 'Your key is saved on the machine running Better Bots and never shown here again.');
    if (copy.keyUrl) { const link = el('a', null, ' Get a key ↗'); link.href = copy.keyUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; keyHelp.append(link); }
    form.append(keyHelp);
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.type = 'button';
    const closeEditor = () => {
      form.hidden = true; edit.setAttribute('aria-expanded', 'false');
      input.value = ''; name.value = provider.label; url.value = provider.base_url ?? '';
      edit.focus();
    };
    edit.onclick = () => {
      if (!form.hidden) { closeEditor(); return; }
      form.hidden = false; edit.setAttribute('aria-expanded', 'true');
      (provider.custom ? name : input).focus();
    };
    cancel.onclick = closeEditor;
    const feedback = el('p', 'hint provider-feedback');
    feedback.setAttribute('role', 'status');
    form.append(save, cancel, feedback);
    // The key is posted and never rendered back — the panel only ever learns
    // whether one is present.
    form.onsubmit = async (submitEvent) => {
      submitEvent.preventDefault();
      if (!provider.custom && !input.value.trim()) { closeEditor(); return; }
      feedback.textContent = 'Saving…';
      save.disabled = true;
      try {
        if (provider.custom) {
          await api('PATCH', '/api/custom-providers', { provider: provider.id, label: name.value.trim(), base_url: url.value.trim(), key: input.value.trim() });
        } else {
          await api('POST', '/api/providers', { provider: provider.id, key: input.value.trim() });
        }
      } catch (err) {
        feedback.textContent = `Changes were not saved: ${err.message}`;
        banner(feedback.textContent, true);
        save.disabled = false;
        return;
      }
      input.value = '';
      provider.configured = true;
      banner(`${provider.label} settings saved; checking model access…`);
      await modelCatalog.credentialsChanged(provider.id);
      const discovery = modelCatalog.data.providers.find(entry => entry.id === provider.id);
      if (discovery?.state === 'ready') banner(`${provider.label} settings saved; models loaded`);
      else {
        const rejected = /HTTP (401|403)/.test(discovery?.error ?? '');
        banner(rejected
          ? `${providerTitle(provider)} rejected that key. Check you copied all of it, then try again.`
          : `${providerTitle(provider)} key saved, but checking it ${discovery?.state === 'checking' ? 'could not finish' : 'failed'}. ${discovery?.error ?? modelCatalog.error ?? 'Refresh models to retry.'}`, true);
      }
      save.disabled = false;
      await renderProviders();
    };
    row.append(form);
    box.append(row);
  }

  // Custom providers an operator added — the endpoint, the key it uses, and the
  // models the provider does not list but the account can reach.
  /** A provider the console has never seen: name it, point it at an endpoint, hand it a key. */
  const addProvider = el('form', 'provider-add');
  addProvider.append(el('h4', null, 'Add a provider'));
  addProvider.append(el('p', 'hint', 'For any other service. It must speak the OpenAI API format; you need its address and a key.'));
  const nameLabel = el('input');
  nameLabel.placeholder = 'name (e.g. Atria)';
  nameLabel.autocomplete = 'off';
  nameLabel.required = true;
  nameLabel.maxLength = 40;
  const urlInput = el('input');
  urlInput.placeholder = 'base URL (https://…/v1)';
  urlInput.type = 'url';
  urlInput.required = true;
  const keyInput = el('input');
  keyInput.type = 'password';
  keyInput.placeholder = 'API key';
  keyInput.autocomplete = 'off';
  const addBtn = el('button', 'ghost', 'Add');
  addBtn.type = 'submit';
  nameLabel.setAttribute('aria-label', 'New provider name');
  urlInput.setAttribute('aria-label', 'New provider URL');
  keyInput.setAttribute('aria-label', 'New provider API key');
  addProvider.append(nameLabel, urlInput, keyInput, addBtn);
  addProvider.onsubmit = async (submitEvent) => {
    submitEvent.preventDefault();
    addBtn.disabled = true;
    try {
      await api('POST', '/api/custom-providers', {
        label: nameLabel.value.trim(), base_url: urlInput.value.trim(),
        ...(keyInput.value.trim() ? { key: keyInput.value.trim() } : {}),
      });
    } catch (err) {
      banner(`Provider was not added: ${err.message}`, true);
      addBtn.disabled = false;
      return;
    }
    nameLabel.value = ''; urlInput.value = ''; keyInput.value = '';
    banner('Provider added; discovering its models…');
    await modelCatalog.refresh(true);
    addBtn.disabled = false;
    await renderProviders();
  };
  box.append(addProvider);

  /** A model reachable on a provider that does not list it — vouched for by the person adding it. */
  const addModel = el('form', 'provider-add');
  addModel.append(el('h4', null, 'Add a model'));
  addModel.append(el('p', 'hint', 'Use this only when a provider does not list a model your account can access. Adding it does not verify that a run will work.'));
  const modelProvider = el('select');
  modelProvider.required = true;
  const chooseProvider = el('option', null, 'Choose a provider');
  chooseProvider.value = '';
  chooseProvider.disabled = true;
  chooseProvider.selected = true;
  modelProvider.append(chooseProvider);
  for (const provider of providers) {
    if (provider.oauth) continue;
    const option = el('option', null, provider.label);
    option.value = provider.id;
    modelProvider.append(option);
  }
  const modelId = el('input');
  modelId.setAttribute('aria-label', 'Model ID');
  modelId.placeholder = 'Model ID from this provider';
  modelId.autocomplete = 'off';
  modelId.required = true;
  const modelLabel = el('input');
  modelLabel.setAttribute('aria-label', 'Display name');
  modelLabel.placeholder = 'display name (optional)';
  modelLabel.maxLength = 120;
  const modelKey = el('input');
  modelKey.setAttribute('aria-label', 'Model API key');
  modelKey.type = 'password';
  modelKey.placeholder = 'API key (optional)';
  modelKey.autocomplete = 'off';
  const modelBtn = el('button', 'ghost', 'Add');
  modelBtn.type = 'submit';
  const providerField = el('label', 'provider-field', 'Provider');
  providerField.append(modelProvider);
  addModel.append(providerField, modelId, modelLabel, modelKey, modelBtn);
  addModel.onsubmit = async (submitEvent) => {
    submitEvent.preventDefault();
    modelBtn.disabled = true;
    try {
      await api('POST', '/api/models', {
        provider: modelProvider.value, model: modelId.value.trim(),
        ...(modelLabel.value.trim() ? { label: modelLabel.value.trim() } : {}),
        ...(modelKey.value.trim() ? { key: modelKey.value.trim() } : {}),
      });
    } catch (err) {
      banner(`Model was not added: ${err.message}`, true);
      modelBtn.disabled = false;
      return;
    }
    modelId.value = ''; modelLabel.value = ''; modelKey.value = '';
    banner('Model added; it is selectable in bot settings now.');
    await modelCatalog.refresh(true);
    modelBtn.disabled = false;
    await renderProviders();
  };
  box.append(addModel);
  updateProviderStatuses();
}

$('#toggle-providers').onclick = () => {
  const box = $('#providers');
  box.hidden = !box.hidden;
  $('#toggle-providers').setAttribute('aria-expanded', String(!box.hidden));
  renderProviders();
};

// --------------------------------------------------------------- plugins ---

/**
 * Integrations: MCP servers the agents may use. Presets take a key or a URL;
 * a server that wants a person gets a Sign in button, which opens the vendor
 * in a new tab and lands back on this console. Never shows a key or token.
 */
async function renderPlugins() {
  const box = $('#plugins');
  if (box.hidden) return;
  let data;
  try {
    data = await api('GET', '/api/integrations');
  } catch (err) {
    box.append(el('p', 'hint', err.message));
    return;
  }
  box.replaceChildren();
  const { integrations, presets } = data;
  box.append(el('h3', 'plugin-group-heading', 'Your plugins'));
  if (!integrations.length) box.append(el('p', 'plugin-empty', 'No plugins connected yet. Choose a service below to get started.'));

  const stateChip = (i) => {
    const label = { connected: 'Connected', connecting: 'Connecting…', needs_sign_in: 'Sign-in needed', failed: 'Connection failed', disconnected: 'Disconnected', disabled: 'Disabled' }[i.state] ?? i.state;
    return el('span', `chip ${i.state === 'connected' ? 'agent' : i.state === 'connecting' ? 'automation' : 'inbox'}`, label);
  };

  for (const i of integrations) {
    const row = el('div', 'provider');
    const head = el('div', 'provider-head');
    head.append(el('strong', null, i.name), stateChip(i));
    row.append(head);
    const where = i.transport === 'http' ? i.url : [i.command, ...(i.args ?? [])].join(' ');
    const connection = el('details', 'plugin-tools');
    connection.append(el('summary', null, 'Connection details'), el('p', 'hint', where));
    row.append(connection);
    if (i.error && i.state !== 'connected') row.append(el('p', 'hint', i.error));
    if (i.state === 'connected') {
      const acts = i.tools.filter((t) => !t.read_only).length;
      const tools = el('details', 'plugin-tools');
      tools.append(el('summary', null, `${i.tools.length} tools · ${i.tools.length - acts} read, ${acts} ask first`));
      const list = el('ul');
      for (const t of i.tools) {
        const item = el('li', t.read_only ? 'read' : 'act');
        item.append(el('span', null, `${t.source}: ${t.action}`));
        const details = el('details'); details.append(el('summary', null, 'Review capability'), el('pre', null, JSON.stringify(t.definition, null, 2)));
        const choice = el('select');
        for (const action of ['external.unclassified', 'integration.read', 'external.publish', 'external.pay', 'external.send', 'external.delete', 'external.credentials', 'integration.act']) {
          const option = el('option', null, action); option.value = action; option.selected = action === t.action; choice.append(option);
        }
        const save = el('button', null, 'Save reviewed classification');
        save.onclick = async () => { try { await api('POST', '/api/integrations/review-tool', { name: i.name, tool: t.source, fingerprint: t.fingerprint, action: choice.value }); await renderPlugins(); } catch (error) { banner(error.message, true); } };
        details.append(choice, save); item.append(details); list.append(item);
      }
      tools.append(list);
      row.append(tools);
    }
    const actions = el('div', 'provider-form');
    if (i.state === 'needs_sign_in' || (i.transport === 'http' && i.signed_in)) {
      const signIn = el('button', 'ghost', i.signed_in ? 'Sign out' : 'Sign in');
      signIn.onclick = async () => {
        try {
          if (i.signed_in) { await api('POST', '/api/integrations/sign-out', { name: i.name }); }
          else {
            const { authorize_url } = await api('POST', '/api/integrations/sign-in', { name: i.name });
            window.open(authorize_url, '_blank', 'noopener');
            banner(`Finish signing in to ${i.name} in the new tab; it comes back here.`);
          }
          await renderPlugins();
        } catch (err) { banner(err.message, true); }
      };
      actions.append(signIn);
    }
    const reconnect = el('button', 'ghost', 'Reconnect');
    reconnect.onclick = async () => { try { await api('POST', '/api/integrations/reconnect', { name: i.name }); await renderPlugins(); } catch (err) { banner(err.message, true); } };
    // A preset that takes a key can have it set (or replaced) after the fact:
    // the same add call, same preset and URL, new secret. Reconnect alone only re-dials.
    const preset = presets.find((p) => p.id === i.preset);
    if (preset?.secret) {
      const keyForm = el('form', 'provider-form plugin-add');
      const keyInput = el('input');
      keyInput.type = 'password';
      keyInput.placeholder = i.has_secret ? `Replace ${preset.secret.label}` : preset.secret.label;
      keyInput.title = preset.secret.where ?? '';
      keyInput.autocomplete = 'off';
      const save = el('button', 'ghost', 'Save key');
      save.type = 'submit';
      keyForm.append(keyInput, save);
      keyForm.onsubmit = async (submitEvent) => {
        submitEvent.preventDefault();
        if (!keyInput.value.trim()) return;
        save.disabled = true;
        try {
          const shown = await api('POST', '/api/integrations', { preset: i.preset, name: i.name, url: i.url, key: keyInput.value.trim() });
          banner(shown.state === 'connected' ? `${shown.name}: key saved, ${shown.tools.length} tools` : `${shown.name}: ${shown.state}${shown.error ? ` — ${shown.error}` : ''}`, shown.state === 'failed');
          await renderPlugins();
        } catch (err) { banner(err.message, true); save.disabled = false; }
      };
      row.append(keyForm);
    }
    const remove = el('button', 'ghost', 'Remove');
    remove.onclick = async () => {
      if (!confirm(`Remove ${i.name}? Its tools leave the bots; nothing else changes.`)) return;
      try { await api('DELETE', '/api/integrations', { name: i.name }); banner(`${i.name} removed`); await renderPlugins(); } catch (err) { banner(err.message, true); }
    };
    actions.append(reconnect, remove);
    row.append(actions);
    box.append(row);
  }

  box.append(el('h3', 'plugin-group-heading', 'Explore plugins'));
  // Presets not yet connected, each with exactly the field it needs.
  for (const p of presets.filter((x) => !x.connected_as)) {
    const row = el('div', 'provider');
    const head = el('div', 'provider-head');
    head.append(el('strong', null, p.label), el('span', 'chip', p.transport === 'stdio' ? 'runs here' : p.sign_in ? 'sign in' : p.secret ? 'key' : 'no sign-in'));
    row.append(head);
    row.append(el('p', 'hint', p.note));

    const form = el('form', 'provider-form plugin-add');
    let urlInput = null; let keyInput = null;
    if (p.transport === 'http' && (p.url_editable || !p.url)) {
      urlInput = el('input');
      urlInput.placeholder = p.url ? `URL (default: ${p.url})` : 'URL from your account';
      urlInput.title = p.url_hint ?? '';
      urlInput.autocomplete = 'off';
      form.append(urlInput);
    }
    if (p.secret && !(p.sign_in && p.secret.optional && !urlInput)) {
      keyInput = el('input');
      keyInput.type = 'password';
      keyInput.placeholder = p.secret.label + (p.secret.optional ? ' (optional)' : '');
      keyInput.title = p.secret.where ?? '';
      keyInput.autocomplete = 'off';
      form.append(keyInput);
    }
    const go = el('button', 'ghost', p.sign_in && !p.secret?.optional ? 'Connect & sign in' : 'Connect');
    go.type = 'submit';
    form.append(go);
    form.onsubmit = async (submitEvent) => {
      submitEvent.preventDefault();
      go.disabled = true;
      go.textContent = 'Connecting…';
      try {
        const shown = await api('POST', '/api/integrations', { preset: p.id, url: urlInput?.value.trim() ?? '', key: keyInput?.value.trim() ?? '' });
        if (shown.state === 'connected') banner(`${shown.name}: ${shown.tools.length} tools connected`);
        else if (shown.state === 'needs_sign_in') {
          const { authorize_url } = await api('POST', '/api/integrations/sign-in', { name: shown.name });
          window.open(authorize_url, '_blank', 'noopener');
          banner(`Finish signing in to ${shown.name} in the new tab; it comes back here.`);
        } else banner(`${shown.name}: ${shown.error}`, true);
        await renderPlugins();
      } catch (err) {
        banner(err.message, true);
        go.disabled = false;
        go.textContent = 'Connect';
      }
    };
    const setup = el('details', 'plugin-setup');
    setup.append(el('summary', null, 'Set up connection'));
    if (p.requires) setup.append(el('p', 'hint', `Requires ${p.requires}`));
    setup.append(form);
    row.append(setup);
    box.append(row);
  }

  // Anything else that speaks MCP.
  const custom = el('details', 'provider');
  custom.append(el('summary', null, 'Advanced: add a custom connection'));
  const form = el('form', 'provider-form plugin-add');
  const name = el('input'); name.placeholder = 'name (letters, digits, -)'; name.autocomplete = 'off';
  const target = el('input'); target.placeholder = 'https://…/mcp  or  uvx --from pkg cmd'; target.autocomplete = 'off';
  const key = el('input'); key.type = 'password'; key.placeholder = 'Bearer key (optional)'; key.autocomplete = 'off';
  const ro = el('p', 'hint', 'A command runs on the machine hosting Better Bots. Unreviewed tools ask before every call; reviewing one gives it a standing rule.');
  const go = el('button', 'ghost', 'Connect'); go.type = 'submit';
  form.append(name, target, key, ro, go);
  form.onsubmit = async (submitEvent) => {
    submitEvent.preventDefault();
    const t = target.value.trim();
    const body = { name: name.value.trim(), trust: 'annotations' };
    if (/^https?:\/\//.test(t)) { body.url = t; if (key.value.trim()) body.headers = { Authorization: `Bearer ${key.value.trim()}` }; }
    else {
      const [command, ...args] = t.split(/\s+/);
      // The host starts this program as itself on every connect; say so before it does.
      if (!confirm(`Run “${t}” on the machine hosting Better Bots? It starts now and again on every connect, with the host's own access.`)) return;
      Object.assign(body, { command, args, confirm_command: command });
    }
    try {
      const shown = await api('POST', '/api/integrations', body);
      banner(shown.state === 'connected' ? `${shown.name}: ${shown.tools.length} tools connected` : `${shown.name}: ${shown.state}${shown.error ? ` — ${shown.error}` : ''}`, shown.state === 'failed');
      form.reset();
      await renderPlugins();
    } catch (err) { banner(err.message, true); }
  };
  custom.append(form);
  box.append(custom);
  const noResults = el('p', 'plugin-empty', 'No matching plugins. Try another name or capability.');
  noResults.id = 'plugin-no-results';
  noResults.hidden = true;
  noResults.setAttribute('role', 'status');
  box.append(noResults);
  for (const input of box.querySelectorAll('input')) input.setAttribute('aria-label', input.placeholder);
  filterPlugins();
}

function filterPlugins() {
  const query = $('#plugin-search').value.trim().toLowerCase();
  const cards = [...$('#plugins').querySelectorAll(':scope > .provider')];
  for (const card of cards) card.hidden = !card.textContent.toLowerCase().includes(query);
  const empty = $('#plugin-no-results');
  if (empty) empty.hidden = !query || cards.some(card => !card.hidden);
}
$('#plugin-search').addEventListener('input', filterPlugins);

$('#toggle-plugins').onclick = () => {
  const box = $('#plugins');
  box.hidden = !box.hidden;
  $('#toggle-plugins').setAttribute('aria-expanded', String(!box.hidden));
  renderPlugins();
};

// Coming back from a vendor's sign-in page: refresh the panel so the new state shows.
window.addEventListener('focus', () => { if ($('#app-settings').open && !document.querySelector('[data-settings-section="plugins"]').hidden && !$('#plugins input:focus')) renderPlugins(); });

// ------------------------------------------------------------------- theme ---

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: '◐', light: '☀', dark: '☾' };

/** data-theme is always concrete so the CSS needs one selector, not a media query. */
function applyTheme(pref) {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.dataset.themePref = pref;
  root.dataset.theme = pref === 'system' ? system : pref;
  try { localStorage.setItem('better-bots-theme', pref); } catch { /* private mode */ }
  const button = $('#theme-toggle');
  button.textContent = THEME_LABEL[pref];
  button.title = `Theme: ${pref}`;
}

function agentFace(agent, size, image = null) {
  // Keep the live image until its appearance (or working phase class) changes.
  const sig = JSON.stringify([normalizeShape(agent?.shape), normalizeStyle(agent?.style), normalizeColor(agent?.color), normalizeHair(agent?.hair), agent?.active_run?.phase ?? null]);
  const face = image ?? avatarImage(agent?.shape, agent?.style, agent?.color, { size, phase: agent?.active_run?.phase ?? null, hair: agent?.hair });
  if (image && face.appearanceSig !== sig) avatarImage(agent?.shape, agent?.style, agent?.color, { size, phase: agent?.active_run?.phase ?? null, hair: agent?.hair, image });
  face.appearanceSig = sig;
  face.classList.toggle('pulsing', Boolean(agent?.active_run && !agent.active_run.phase));
  return face;
}

// ------------------------------------------------------------------ roster ---

// Live events update agent rows in place: keep the click target and animated
// image alive even when labels, inbox, selection or phase change.
const rowCache = new Map();   // key -> { sig, node }
function cachedRow(key, sig, make) {
  const hit = rowCache.get(key);
  if (hit && hit.sig === sig) return hit.node;
  const node = make(hit?.node);
  rowCache.set(key, { sig, node });
  return node;
}
function agentSig(agent, inPinned) {
  return JSON.stringify([agent.name, agent.role, agent.shape, agent.style, agent.color, agent.hair, agent.lead, agent.pinned, agent.pin_scope, agent.desk, inPinned,
    Boolean(agent.active_run), agent.active_run?.lane ?? null, agent.active_run?.phase ?? null, agent.inbox ?? 0,
    state.selectedKind === 'agent' && agent.id === state.selected]);
}
function placeRows(list, nodes) {
  // Retain wrappers and never detach unaffected rows (which would lose focus).
  const rows = nodes.map((node) => {
    if (node.tagName === 'LI') return node;
    if (node.parentNode?.tagName === 'LI') return node.parentNode;
    const li = el('li'); li.append(node); return li;
  });
  const wanted = new Set(rows);
  for (const row of [...list.children]) if (!wanted.has(row)) row.remove();
  let next = list.firstChild;
  for (const row of rows) {
    if (row !== next) list.insertBefore(row, next);
    next = row.nextSibling;
  }
}

// Desks: the roster is split into labelled sections, one per desk, in the order
// the desks first appear. Each desk shows its own pinned agents first. A desk
// folds when its divider is clicked, and stays folded across reloads.
const foldedDesks = new Set((() => {
  try { const saved = JSON.parse(localStorage.getItem('desks.folded') ?? '[]'); return Array.isArray(saved) ? saved : []; }
  catch { return []; } // blocked or corrupt storage must not stop the app loading
})());
function deskNames() {
  const seen = [];
  for (const a of state.agents) { const d = a.desk ?? ''; if (!seen.includes(d)) seen.push(d); }
  return seen;
}
function byPinThenName(a, b) {
  if (Boolean(a.pinned_at) !== Boolean(b.pinned_at)) return a.pinned_at ? -1 : 1;
  if (a.pinned_at && b.pinned_at) return a.pinned_at < b.pinned_at ? -1 : a.pinned_at > b.pinned_at ? 1 : 0;
  return 0;   // otherwise keep the host's order
}
const dividerCache = new Map();
function deskDivider(desk, count, foldable = true) {
  const folded = foldable && foldedDesks.has(desk);
  let node = dividerCache.get(desk);
  if (!node) {
    node = el('li');
    const button = el('button', 'desk-toggle');
    button.type = 'button';
    button.append(el('span', 'desk-line'), el('span', 'desk-name'), el('span', 'desk-line'));
    const memory = el('button', 'desk-memory', 'Memory');
    memory.type = 'button';
    node.append(button, memory);
    dividerCache.set(desk, node);
  }
  node.className = `desk-divider${folded ? ' folded' : ''}`;
  const button = node.firstChild;
  button.setAttribute('aria-expanded', String(!folded));
  button.disabled = !foldable;
  button.querySelector('.desk-name').textContent = `${desk || 'General'}${state.desks?.some(d => d.name === desk && d.enabled === false) ? ' · Paused' : ''}${folded ? ` · ${count}` : ''}`;
  button.title = foldable ? (folded ? 'Unfold this desk' : 'Fold this desk') : 'This desk stays open';
  button.onclick = () => {
    if (!foldable) return;
    if (foldedDesks.has(desk)) foldedDesks.delete(desk); else foldedDesks.add(desk);
    try { localStorage.setItem('desks.folded', JSON.stringify([...foldedDesks])); } catch { /* folding still works for this session */ }
    renderAgents();
  };
  const memory = node.children[1];
  memory.setAttribute('aria-label', `Open ${desk || 'General'} desk memory`);
  memory.onclick = () => openDeskMemory(desk);
  return node;
}

function renderAgents() {
  const list = $('#agent-list');
  renderPinned();
  const desks = deskNames();
  const nodes = [];
  for (const desk of desks) {
    if (state.desks?.some(d => d.name === desk && d.hidden)) continue;
    const allMembers = state.agents.filter((a) => (a.desk ?? '') === desk);
    if (allMembers.length === 0) continue;
    const members = allMembers.filter((a) => a.pin_scope !== 'rail');
    nodes.push(deskDivider(desk, allMembers.length, desks.length > 1));
    if (desks.length > 1 && foldedDesks.has(desk)) continue;
    for (const a of [...members].sort(byPinThenName)) nodes.push(cachedRow(`agent:${a.id}`, agentSig(a, false), (button) => agentRow(a, { button })));
  }
  placeRows(list, nodes);
  if (state.agents.length === 0) {
    list.replaceChildren(el('li', 'hint', 'No bots yet.'));
  }
  updateDocumentTitle();
}

// ------------------------------------------------------------ notifications ---
// A bot finishing the turn you asked for, or waiting on you, raises a desktop
// notification when this window is not in front. In the Mac app the native
// shell posts it (WKWebView has no Notification API) and keeps the Dock badge.
let attentionSeen = null;
const announced = new Set();
const nativeShell = () => globalThis.webkit?.messageHandlers?.betterBots ?? null;

function announceAttention() {
  const next = attentionSnapshot(state);
  const changes = attentionChanges(attentionSeen, next, {
    describeApproval: (r) => { const d = describeRequest(r, agentById(r.agent_id)?.name ?? 'This bot'); return d.target ? `${d.headline}: ${d.target}` : d.headline; },
  });
  attentionSeen = next;
  nativeShell()?.postMessage({ type: 'badge', count: next.attention });
  if (!document.hidden && document.hasFocus?.() !== false) return;
  for (const change of changes) {
    if (announced.has(change.key)) continue;
    announced.add(change.key);
    if (nativeShell()) { nativeShell().postMessage({ type: 'notify', ...change }); continue; }
    if (globalThis.Notification?.permission !== 'granted') continue;
    const note = new Notification(change.title, { body: change.body, tag: change.key });
    note.onclick = () => { globalThis.focus?.(); if (change.agent_id) select('agent', change.agent_id); note.close(); };
  }
}

/** Asked on the first send, a click the browser counts as consent to be asked. */
function offerNotifications() {
  if (nativeShell() || globalThis.Notification?.permission !== 'default') return;
  try { Notification.requestPermission().catch(() => {}); } catch { /* best effort, never blocks a send */ }
}

globalThis.document?.addEventListener?.('submit', (e) => { if (e.target?.id === 'composer') offerNotifications(); }, true);

/** The Mac app's notification was clicked: open that bot's conversation. */
globalThis.betterBotsOpenAgent = (id) => { if (agentById(id)) select('agent', id); };

/** What a working agent is doing, in the words the chat and the roster both use. */
function phaseLabel(phase) {
  if (phase === 'approval') return 'Waiting for your approval';
  if (phase === 'typing') return 'Writing';
  if (phase === 'retrying') return 'Provider busy, retrying';
  return 'Thinking';
}

/** A background tab still tells you when something needs you or is running. */
function updateDocumentTitle() {
  const waiting = state.approvals?.length ?? 0;
  const working = state.agents.filter((a) => a.active_run).length;
  const parts = [];
  if (waiting) parts.push(`(${waiting}) ${waiting === 1 ? 'Approval needed' : 'Approvals needed'}`);
  else if (working) parts.push(`● ${working === 1 ? `${state.agents.find((a) => a.active_run).name} is working` : `${working} bots working`}`);
  parts.push('Better Bots');
  const title = parts.join(' · ');
  if (document.title !== title) document.title = title;
}

function roomSig(room, inPinned) {
  return JSON.stringify([room.purpose, room.memory, room.pinned, inPinned,
    state.selectedKind === 'room' && room.id === state.selected,
    room.member_ids.map((id) => { const a = agentById(id); return [id, a?.name, a?.shape, a?.style, a?.color, a?.hair, Boolean(a?.active_run), a?.active_run?.phase]; })]);
}
function renderRooms() {
  placeRows($('#room-list'), state.rooms.filter((r) => !r.pinned).map((r) =>
    cachedRow(`room:${r.id}`, roomSig(r, false), (button) => roomRow(r, { button }))));
}

// ------------------------------------------------------------------ pinned ---
// Pinned agents and groups, in pin order, at the very top of the rail: a pin
// always visibly moves something, even when there is nothing else to outrank.
function renderPinned() {
  const head = $('#pinned-head');
  const list = $('#pinned-list');
  const items = [
    ...state.agents.filter((a) => a.pinned && a.pin_scope === 'rail' && !state.desks?.some(d => d.name === (a.desk ?? '') && d.hidden)).map((a) => ({ at: a.pinned_at ?? '', node: cachedRow(`agent:${a.id}`, agentSig(a, true), (button) => agentRow(a, { inPinned: true, button })) })),
    ...state.rooms.filter((r) => r.pinned).map((r) => ({ at: r.pinned_at ?? '', node: cachedRow(`room:${r.id}`, roomSig(r, true), (button) => roomRow(r, { inPinned: true, button })) })),
  ].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  head.hidden = list.hidden = items.length === 0;
  placeRows(list, items.map((i) => i.node));
}

function agentRow(agent, { inPinned = false, button = el('button', 'agent') } = {}) {
  button.type = 'button';
  button.setAttribute('aria-current', String(state.selectedKind === 'agent' && agent.id === state.selected));
  // A working agent gets a speech bubble by its face, dots ticking, so you can
  // see who is busy from across the room without reading the tags.
  let face = button.querySelector('.face');
  if (!face) {
    face = el('span', 'face');
    face.append(agentFace(agent, 72));
    button.append(face);
  } else agentFace(agent, 72, face.firstChild);
  let bubble = face.querySelector('.working-bubble');
  if (agent.active_run && agent.active_run.phase !== 'approval') {
    if (!bubble) {
      bubble = el('span', 'working-bubble');
      bubble.append(el('i'), el('i'), el('i'));
      face.append(bubble);
    }
    bubble.title = phaseLabel(agent.active_run.phase);
  } else bubble?.remove();
  button.querySelector('.who')?.remove();
  button.querySelector('.pin')?.remove();
  const who = el('div', 'who');
  who.append(el('strong', null, agent.name), el('small', null, agent.role || 'No role yet'));
  // Tags sit under the name, so a lead with a live run and a full inbox still has a name.
  const tags = el('div', 'tags');
  if (agent.lead) tags.append(el('span', 'chip lead', 'lead'));
  if (agent.active_run?.phase === 'approval') tags.append(el('span', 'chip', 'Approval needed'));
  if (agent.active_run) tags.append(el('span', `chip ${agent.active_run.lane}`, agent.active_run.lane));
  if (agent.inbox > 0) { const w = el('span', 'chip waiting', `✉ ${agent.inbox}`); w.title = `${agent.inbox} message${agent.inbox === 1 ? '' : 's'} waiting for its next turn`; tags.append(w); }
  if (tags.childElementCount) who.append(tags);
  button.append(who);
  if (agent.pinned && !inPinned) { const pin = el('span', 'pin', '📌'); pin.title = agent.pin_scope === 'rail' ? 'Pinned to the top of the window' : 'Pinned to the top of its desk'; button.append(pin); }
  button.onclick = () => select('agent', agent.id);
  button.oncontextmenu = (e) => { e.preventDefault(); const current = agentById(agent.id); if (current) openMenu(e, agentMenu(current)); };
  return button;
}

function roomRow(room, { inPinned = false, button = el('button', 'agent') } = {}) {
  button.type = 'button';
  button.setAttribute('aria-current', String(state.selectedKind === 'room' && room.id === state.selected));
  let who = button.querySelector('.who');
  if (!who) {
    who = el('div', 'who');
    who.append(el('strong'), memberFaces(room, 30), el('small'));
    button.append(who);
  } else memberFaces(room, 30, who.querySelector('.members-row'));
  who.querySelector('strong').textContent = room.purpose;
  who.querySelector('small').textContent = `${memberNames(room)} · ${roomMemoryLabel(room.memory)}`;
  button.querySelector('.pin')?.remove();
  if (room.pinned && !inPinned) { const pin = el('span', 'pin', '📌'); pin.title = 'Pinned'; button.append(pin); }
  button.onclick = () => select('room', room.id);
  button.oncontextmenu = (e) => { e.preventDefault(); const current = state.rooms.find((r) => r.id === room.id); if (current) openMenu(e, roomMenu(current)); };
  return button;
}

function roomMemoryLabel(memory, header = false) {
  if (memory === 'members') return header ? 'private to members' : 'private';
  if (memory === 'room') return header ? 'memory stays in this room' : 'room only';
  if (memory === 'none') return 'memory off';
  return 'shared memory (legacy)';
}

// ------------------------------------------------------------ context menu ---
// Right-click an agent or a group in the roster. Everything the header buttons
// do, in one place; destructive items confirm first.
let menuNode = null;
function closeMenu({ restoreFocus = true } = {}) {
  const opener = menuNode?.opener;
  menuNode?.remove();
  menuNode = null;
  if (restoreFocus && opener?.isConnected) opener.focus();
}
function openMenu(e, items, { focus = false, opener = null } = {}) {
  closeMenu();
  const menu = el('div', 'ctx-menu');
  menu.setAttribute('role', 'menu');
  menu.opener = opener;
  for (const item of items) {
    if (item === '-') { menu.append(el('hr')); continue; }
    const b = el('button', `ctx-item${item.danger ? ' danger' : ''}`, item.label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.onclick = async () => { closeMenu({ restoreFocus: false }); try { await item.run(); } catch (err) { banner(err.message, true); } };
    menu.append(b);
  }
  // Arrow keys move through the items; Escape and Tab leave, handing focus back.
  menu.addEventListener?.('keydown', (event) => {
    const buttons = [...menu.querySelectorAll?.('.ctx-item') ?? []];
    const at = buttons.indexOf(document.activeElement);
    const go = (index) => { event.preventDefault(); buttons[(index + buttons.length) % buttons.length]?.focus(); };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(buttons.length - 1);
    else if (event.key === 'Tab') closeMenu();
  });
  document.body.append(menu);
  const { innerWidth: vw, innerHeight: vh } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, vw - rect.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, vh - rect.height - 8)}px`;
  menuNode = menu;
  if (focus) menu.querySelector?.('.ctx-item')?.focus();
}
document.addEventListener('click', (e) => { if (menuNode && !menuNode.contains(e.target) && e.target !== menuNode.opener) closeMenu({ restoreFocus: false }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', () => closeMenu({ restoreFocus: false }));

function agentMenu(agent) {
  return [
    { label: 'Open', run: () => select('agent', agent.id) },
    { label: 'Edit…', run: async () => { if (select('agent', agent.id)) toggleSettings(agentById(agent.id)); } },
    ...(agent.pinned ? [{ label: 'Unpin', run: async () => { await api('POST', '/api/agents/pin', { agent_id: agent.id, pinned: false }); await refresh(); } }] : []),
    ...(agent.pin_scope === 'desk' ? [] : [{ label: 'Pin to top of desk', run: async () => { await api('POST', '/api/agents/pin', { agent_id: agent.id, scope: 'desk' }); await refresh(); } }]),
    ...(agent.pin_scope === 'rail' ? [] : [{ label: 'Pin to top of window', run: async () => { await api('POST', '/api/agents/pin', { agent_id: agent.id, scope: 'rail' }); await refresh(); } }]),
    { label: 'Move to desk…', run: async () => {
      const desk = prompt(`Desk for ${agent.name} (existing: ${deskNames().map((d) => d || 'General').join(', ')})`, agent.desk || '');
      if (desk === null) return;
      await api('PATCH', '/api/agents', { agent_id: agent.id, desk });
      await refresh();
    } },
    ...(agent.lead ? [] : [{ label: 'Make lead', run: async () => { await api('POST', '/api/agents/lead', { agent_id: agent.id }); await refresh(); } }]),
    '-',
    { label: 'Delete…', danger: true, run: async () => {
      if (!confirm(`Delete ${agent.name}? Its transcript and memory files stay on disk; it leaves every room.`)) return;
      const result = await api('DELETE', '/api/agents', { agent_id: agent.id });
      if (state.selected === agent.id) { state.selected = null; }
      await refresh();
      if (!state.selected && state.agents.length) select('agent', state.agents[0].id);
      // Teardown can outlive the registry entry. When the host says cleanup is
      // still pending, say exactly that instead of implying a finished job.
      if (result?.cleanup_pending) banner(result.message ?? `${agent.name} deleted; desktop cleanup is still pending, so its slot stays unavailable.`, true);
      else banner(`${agent.name} deleted`);
    } },
  ];
}

function roomMenu(room) {
  return [
    { label: 'Open', run: () => select('room', room.id) },
    { label: 'Rename…', run: async () => {
      const purpose = prompt('Room name', room.purpose);
      if (purpose === null || !purpose.trim()) return;
      await api('PATCH', '/api/rooms', { room_id: room.id, purpose: purpose.trim() });
      await refresh(); renderHead();
    } },
    { label: room.pinned ? 'Unpin' : 'Pin to top', run: async () => { await api('POST', '/api/rooms/pin', { room_id: room.id, pinned: !room.pinned }); await refresh(); } },
    '-',
    { label: 'Delete…', danger: true, run: () => deleteRoom(room) },
  ];
}

async function deleteRoom(room) {
  if (!confirm(`Delete the room "${room.purpose}"? The members are unaffected.`)) return;
  await api('DELETE', '/api/rooms', { room_id: room.id });
  if (state.selected === room.id) { state.selected = null; state.selectedKind = 'agent'; }
  await refresh();
  if (!state.selected && state.agents.length) select('agent', state.agents[0].id);
  banner('Room deleted');
}

/** The faces of a group's members, overlapping like a small crowd. Unknown ids show as a dot. */
function memberFaces(room, size, row = el('div', 'members-row')) {
  const previous = new Map([...row.children].map((node) => [node.memberId, node]));
  const nodes = room.member_ids.map((id) => {
    const agent = agentById(id), old = previous.get(id);
    const node = agent ? agentFace(agent, size, old?.tagName === 'IMG' ? old : null) : old?.tagName === 'SPAN' ? old : el('span', 'dot');
    node.memberId = id;
    node.title = agent?.name ?? id;
    if (!agent) node.style.setProperty('--c', '#555');
    return node;
  });
  const wanted = new Set(nodes);
  for (const node of [...row.children]) if (!wanted.has(node)) node.remove();
  let next = row.firstChild;
  for (const node of nodes) {
    if (node !== next) row.insertBefore(node, next);
    next = node.nextSibling;
  }
  return row;
}
function memberNames(room) {
  return room.member_ids.map((id) => agentById(id)?.name ?? id.slice(0, 8)).join(', ');
}

function select(kind, id) {
  if (id !== state.selected || kind !== state.selectedKind) {
    if (agentSettingsDirty() && !confirm('Discard unsaved bot settings?')) return false;
    closeSettings(); closeMemory();
  }
  jobs.close(false);
  state.selectedKind = kind;
  state.selected = id;
  renderAgents();
  renderRooms();
  renderHead();
  renderComposer();
  loadTranscript().catch((error) => banner(`Could not load this conversation: ${error.message}`, true));
  showPane('chat');
  return true;
}

// On a narrow screen only one pane is visible; the tab bar and `select` choose
// it. On a wide screen the attribute is set but changes nothing.
function showPane(name) {
  $('.app').dataset.pane = name;
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.setAttribute('aria-current', tab.dataset.pane === name ? 'true' : 'false');
  }
  // The composer measures 0 while its pane is hidden; size it once it is visible.
  if (name === 'chat') requestAnimationFrame(fitComposerInput);
}

const startingRooms = new Set();
// The header is refreshed on every poll and event. Rebuilding its buttons each time
// drops keyboard focus and closes open popups, so an unchanged header is left alone,
// and a changed one hands focus back to the same control.
function renderHead() {
  renderQuickReasoning();
  $('#desktop-viewer').hidden = !state.desktopEnabled;
  if (state.desktopEnabled) desktopViewer.update(state.selectedKind === 'agent' ? agentById(state.selected) : null);
  // `thought` streams while a bot thinks and is not shown in the header.
  const quiet = (a) => a && { ...a, active_run: a.active_run && { ...a.active_run, thought: undefined } };
  const room = state.selectedKind === 'room' ? state.rooms.find((r) => r.id === state.selected) ?? null : null;
  const signature = JSON.stringify([
    state.selectedKind, state.selected, state.live, state.model, modelCatalog.data.providers?.length ?? 0,
    state.selectedKind === 'room'
      ? [room, room?.member_ids?.map((id) => quiet(agentById(id))), state.roomStartEnabled, [...startingRooms]]
      : [quiet(state.selectedKind === 'agent' ? agentById(state.selected) : null), (state.previews ?? []).filter((p) => p.agent_id === state.selected), state.desks],
  ]);
  if (renderHead.lastSignature === signature) return;
  renderHead.lastSignature = signature;
  const meta = $('#chat-meta');
  const focused = meta.contains?.(document.activeElement) ? (document.activeElement.getAttribute?.('aria-label') ?? document.activeElement.textContent) : null;
  renderHeadContents();
  if (focused) {
    const again = Array.from(meta.children).find((node) => (node.getAttribute?.('aria-label') ?? node.textContent) === focused);
    again?.focus?.();
  }
}

function renderHeadContents() {
  const title = $('#chat-title');
  const meta = $('#chat-meta');
  const keepFace = state.selectedKind === 'agent' && state.selected && title.avatarAgentId === state.selected;
  const keepMembers = state.selectedKind === 'room' && state.selected && title.avatarRoomId === state.selected;
  if (!keepFace && !keepMembers) title.replaceChildren();
  title.avatarAgentId = state.selectedKind === 'agent' ? state.selected : null;
  title.avatarRoomId = state.selectedKind === 'room' ? state.selected : null;
  meta.replaceChildren();
  $('#open-settings').disabled = state.selectedKind !== 'agent' || !state.selected;
  $('#open-memory').disabled = state.selectedKind !== 'agent' || !state.selected;
  $('#open-jobs').disabled = state.selectedKind !== 'agent' || !state.selected;

  if (!state.selected) {
    const dot = el('span', 'dot big');
    dot.style.setProperty('--c', '#3f3a52');
    title.append(dot, wrap('No bot selected', 'Create one to begin'));
    return;
  }

  if (state.selectedKind === 'room') {
    const room = state.rooms.find((r) => r.id === state.selected);
    const faces = title.querySelector('.members-row');
    if (room) {
      if (faces) memberFaces(room, 44, faces);
      else title.insertBefore(memberFaces(room, 44), title.firstChild);
    } else faces?.remove();
    if (!title.querySelector('strong')) title.append(wrap('', ''));
    title.querySelector('strong').textContent = room?.purpose ?? 'Room';
    title.querySelector('small').textContent = room ? `${memberNames(room)} · ${roomMemoryLabel(room.memory, true)}` : '';
    meta.append(el('span', 'chip', 'room'));
    if (room) {
      const memorySelect = el('select', 'room-memory-select');
      memorySelect.setAttribute('aria-label', 'Room memory');
      if ((room.memory ?? 'project') === 'project') {
        const legacy = el('option', null, 'Shared memory · choose On or Off');
        legacy.value = 'project';
        legacy.disabled = true;
        memorySelect.append(legacy);
      }
      for (const [value, label] of [
        ['members', 'Memory on · members only'],
        ['room', 'Memory on · this room only'],
        ['none', 'Memory off · fresh each request'],
      ]) {
        const option = el('option', null, label);
        option.value = value;
        memorySelect.append(option);
      }
      memorySelect.value = room.memory ?? 'project';
      memorySelect.disabled = room.discussion?.status === 'active';
      memorySelect.title = memorySelect.disabled
        ? 'Wait for the current room response to finish before changing memory.'
        : 'Changes apply to future requests. The visible transcript and earlier saved memories remain.';
      memorySelect.onchange = async () => {
        memorySelect.disabled = true;
        try {
          await api('PATCH', '/api/rooms', { room_id: room.id, memory: memorySelect.value });
          await refresh();
          banner('Room memory updated for future requests.');
        } catch (err) {
          memorySelect.value = room.memory ?? 'project';
          memorySelect.disabled = false;
          banner(err.message, true);
        }
      };
      if (state.roomStartEnabled) {
        const start = el('button', 'ghost small', startingRooms.has(room.id) ? 'Starting…' : 'Start discussion');
        start.type = 'button';
        start.title = 'Ask room members to discuss the latest peer message. This does not run their tools.';
        start.disabled = startingRooms.has(room.id) || room.discussion?.status === 'active';
        start.onclick = async () => {
          startingRooms.add(room.id);
          renderHead();
          try {
            const result = await api('POST', '/api/rooms/start', { room_id: room.id });
            banner(result.already_started ? 'This message already has a discussion. Send a new message to continue.' : result.dispatch_status === 'queued' ? 'Discussion queued. Check whether the members’ desks are paused.' : 'Discussion finished.');
          } catch (error) { banner(error.message, true); }
          finally { startingRooms.delete(room.id); await refresh(); await loadTranscript(); }
        };
        meta.append(start);
      }
      meta.insertBefore(moreButton(() => roomMenu(state.rooms.find((r) => r.id === room.id) ?? room)), meta.firstChild);
      meta.append(memorySelect);
    }
    return;
  }

  const agent = agentById(state.selected);
  const faceButton = keepFace ? title.firstChild : el('button', 'avatar-button');
  faceButton.type = 'button';
  faceButton.title = 'Change avatar';
  faceButton.setAttribute('aria-label', `Change ${agent?.name ?? 'this bot'}'s avatar`);
  if (keepFace) agentFace(agent, 64, faceButton.firstChild);
  else {
    faceButton.append(agentFace(agent, 64));
    title.append(faceButton, wrap('', ''));
  }
  faceButton.onclick = () => { const current = agentById(state.selected); if (current) toggleSettings(current); };
  const modelName = agent?.model
    ? modelLabel(agent.model, agent.model_provider, modelCatalog.data.providers)
    : (state.live ? state.model : null);
  title.querySelector('strong').textContent = agent?.name ?? '—';
  title.querySelector('small').textContent = [agent?.role, modelName].filter(Boolean).join(' · ');
  $('#thoughts').hidden = true;

  if (state.desks?.some(d => d.name === (agent?.desk ?? '') && d.enabled === false)) {
    const paused = el('button', 'ghost', 'Desk paused');
    paused.title = 'Delegated work and schedules are paused. Open Desks to manage this desk.';
    paused.onclick = () => $('#manage-workflows').click();
    meta.append(paused);
  }
  if (agent?.active_run?.approval_request_id) {
    const review = el('button', 'ghost small', 'Review permission');
    review.type = 'button';
    review.onclick = () => reviewApproval(agent.active_run.approval_request_id);
    meta.append(review);
  }
  if (agent?.active_run) meta.append(el('span', `chip ${agent.active_run.lane}`, `${agent.active_run.lane} lane`));
  for (const run of [agent?.active_run, ...(agent?.queued ?? [])].filter(Boolean)) {
    const stop = el('button', 'ghost small', run.status === 'cancelling' ? 'Stopping…' : run === agent.active_run ? 'Stop run' : 'Cancel queued run');
    stop.type = 'button';
    stop.disabled = run.status === 'cancelling';
    stop.setAttribute('aria-label', `Stop ${run.lane} run ${run.id}`);
    stop.onclick = async () => {
      stop.disabled = true;
      try {
        await api('POST', '/api/runs/cancel', { run_id: run.id });
        await refresh();
        await loadTranscript();
      } catch (error) { banner(error.message, true); stop.disabled = false; }
    };
    meta.append(stop);
  }
  if (agent?.last_cancellation && !agent.active_run) meta.append(el('span', 'chip', {
    cancelling: 'Stopping…', cancelled: 'Run cancelled', recovery_required: 'Stopped · review effects in Attention',
  }[agent.last_cancellation] ?? agent.last_cancellation));
  if (agent?.inbox) meta.append(inboxChip(agent));
  for (const preview of (state.previews ?? []).filter((p) => p.agent_id === agent?.id && p.status === 'running')) {
    const link = el('a', 'chip', 'Open preview');
    link.href = preview.url; link.target = '_blank'; link.rel = 'noopener';
    const stop = el('button', 'ghost small', 'Stop preview'); stop.type = 'button';
    stop.onclick = async () => {
      stop.disabled = true;
      try { await api('POST', '/api/previews/stop', { preview_id: preview.id }); await refresh(); }
      catch (error) { banner(error.message, true); stop.disabled = false; }
    };
    meta.append(link, stop);
  }
  if (agent?.window) {
    if (agent.window.vnc_url?.startsWith('http://127.0.0.1:')) {
      const view = el('a', 'chip', 'View / take over');
      view.href = agent.window.vnc_url; view.target = '_blank'; view.rel = 'noopener';
      meta.append(view);
    }
    // A real monitor has a screenshot to show; a placeholder one is only a label.
    if (agent.window.last_screenshot) {
      const shot = el('a', 'chip', 'Latest screenshot');
      shot.href = `/api/screens/${encodeURIComponent(agent.window.last_screenshot)}`;
      shot.target = '_blank';
      shot.title = `${agent.window.vnc_url} — click for the latest screenshot`;
      meta.append(shot);
    } else if (state.desktopEnabled) {
      const chip = el('span', 'chip', `Desktop ${agent.window.window_index + 1}`);
      chip.title = agent.window.vnc_url;
      meta.append(chip);
    }
  }
  // The agent's own model, not the host's, or the chip lies about a pinned agent.
  const modelChip = el('span', 'chip', state.live ? modelName : 'stand-in replies');
  modelChip.title = modelChip.textContent;
  meta.append(modelChip);
  const u = agent?.usage_24h;
  if (u && u.runs > 0 && u.input_tokens + u.output_tokens > 0) {
    // Provenance travels with the numbers: the chip says where
    // the counts came from, and never implies they are billing figures.
    const label = PROVENANCE_LABELS[u.provenance];
    const chip = el('span', 'chip', `${fmtTokens(u.input_tokens + u.output_tokens)} tok · 24h${label ? ` · ${label}` : ''}`);
    chip.title = `${u.runs} runs in the last 24h: ${u.input_tokens} in, ${u.output_tokens} out, ${u.cache_read_input_tokens} from cache. ${label ?? 'Unlabeled'} token counts — not billing-authoritative data.`;
    meta.append(chip);
  }
  // First in the strip, so it is never scrolled out of sight on a phone.
  if (agent) meta.insertBefore(moreButton(() => agentMenu(agentById(agent.id) ?? agent)), meta.firstChild);
}

/** The same menu as right-click on the roster, reachable by keyboard and touch. */
function moreButton(items) {
  const button = el('button', 'ghost small more', 'More ▾');
  button.type = 'button';
  button.title = 'Pin, make lead, move to a desk, delete';
  button.setAttribute('aria-label', 'More actions');
  button.setAttribute('aria-haspopup', 'menu');
  button.onclick = () => {
    const rect = button.getBoundingClientRect();
    openMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, items(), { focus: true, opener: button });
  };
  return button;
}

function wrap(strong, small) {
  const div = el('div');
  div.append(el('strong', null, strong), el('small', null, small));
  return div;
}

// -------------------------------------------------------------- transcript ---

let transcriptRequest = 0;
let transcriptSnapshot = '';
let transcriptPage = { owner: null, before: null };

function followTranscript() {
  const view = $('#transcript');
  if (view.dataset.stick !== '0') view.scrollTop = view.scrollHeight;
}

async function loadTranscript() {
  const view = $('#transcript');
  if (!state.selected) return;
  const selected = state.selected;
  const kind = state.selectedKind;
  const owner = `${kind}:${selected}`;
  if (transcriptPage.owner !== owner) transcriptPage = { owner, before: null };
  const before = transcriptPage.before;
  const request = ++transcriptRequest;
  const query = kind === 'room'
    ? `room_id=${encodeURIComponent(selected)}`
    : `agent_id=${encodeURIComponent(selected)}`;
  const page = await api('GET', `/api/transcript?${query}&limit=150${before ? `&before=${encodeURIComponent(before)}` : ''}`);
  const { entries: raw, active_run: rawActiveRun } = page;
  const activeRun = before ? null : withApprovalStatus(rawActiveRun, state.approvals);
  if (request !== transcriptRequest || selected !== state.selected || kind !== state.selectedKind) return;
  // In a group, the host's "Request: …" note right after your message just repeats it.
  const entries = presentChatEntries(raw.filter((e, i) => !(e.kind === 'room_message' && e.system && raw[i - 1]?.sender_id === 'user' && e.text.endsWith(`Request: ${raw[i - 1].text}`))), activeRun);

  if (activeRun?.thought) entries.push({kind:'reasoning', run_id:activeRun.id, turn_id:activeRun.turn_id, text:activeRun.thought, stream_id:activeRun.thought_key, live:activeRun.phase !== 'approval'});
  // Persisted chunks and the current streaming tail form one expandable block.
  for (let i = entries.length - 1; i > 0; i--) {
    const current = entries[i], previous = entries[i - 1];
    if (current.kind === 'reasoning' && previous.kind === 'reasoning' && current.stream_id === previous.stream_id) {
      previous.text += current.text; previous.live ||= current.live; entries.splice(i, 1);
    }
  }
  for (const entry of entries) if (entry.kind === 'reasoning' && entry.stream_id === activeRun?.thought_key && activeRun?.phase === 'thinking') entry.live = true;
  if (activeRun && !entries.at(-1)?.live) entries.push({kind:'reasoning', run_id:activeRun.id, turn_id:activeRun.turn_id, text:'', stream_id:`${activeRun.id}:status`, live:true, phase:activeRun.phase});

  // A transcript read may have started before the newest pushed delta arrived.
  for (const entry of entries) if (entry.kind === 'reasoning') {
    const current = [...document.querySelectorAll('.reasoning-block')].find(node => node.dataset.reasoningKey === entry.stream_id);
    const text = current?.querySelector('.reasoning-text')?.textContent;
    if (text?.length > entry.text.length && text.startsWith(entry.text)) entry.text = text;
  }

  // A live run re-renders this every few seconds. Follow the bottom only when the
  // reader wants it: "stuck" is set by their own scrolling (see below), not by
  // measuring at render time — the header's live thinking box changes this
  // element's height while an agent types, which made every measurement lie.
  const sameView = view.dataset.owner === owner;
  const atBottom = !sameView || view.dataset.stick !== '0';
  const keep = view.scrollTop;
  const agent = agentById(selected);
  const roomStatus = kind === 'room' ? roomProgress(state.rooms.find(room => room.id === selected), state.agents, state.approvals, state.desks) : null;
  const snapshot = JSON.stringify([entries, Boolean(activeRun), roomStatus, before, page.has_more]);
  if (sameView && snapshot === transcriptSnapshot) { followTranscript(); return; }
  transcriptSnapshot = snapshot;
  view.dataset.owner = owner;
  if (!sameView) view.dataset.stick = '1';

  const content = $('#transcript-content');
  const fragment = document.createDocumentFragment();
  if (page.has_more || before) {
    const navigation = el('div', 'row transcript-pages');
    const jump = cursor => {
      transcriptPage.before = cursor;
      view.dataset.stick = cursor ? '0' : '1';
      void loadTranscript().then(() => { if (cursor) view.scrollTop = 0; })
        .catch(error => banner(error.message, true));
    };
    if (page.has_more) {
      const older = el('button', 'ghost small', 'Older messages');
      older.type = 'button'; older.onclick = () => jump(page.before); navigation.append(older);
    }
    if (before) {
      const latest = el('button', 'ghost small', 'Latest messages');
      latest.type = 'button'; latest.onclick = () => jump(null); navigation.append(latest);
    }
    fragment.append(navigation);
  }
  if (entries.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('h2', null, 'Nothing here yet'), el('p', null, 'Send the first message below.'));
    fragment.append(empty);
  }
  // Tool calls and results are the work, not the conversation. Each run of them
  // folds under one "Working" line, collapsed unless it is still happening.
  const groups = groupChatActivity(entries);
  groups.forEach((group, i) => {
    if (!group.work) {
      for (const entry of group.entries) { const node = renderEntry(entry); if (node) fragment.append(node); }
      return;
    }
    // Tool work is folded by default, live or not; the summary says "Working"
    // while it is still happening. Click to open, and it stays open.
    const live = Boolean(activeRun) && group.run === (activeRun.turn_id ?? activeRun.id);
    if (!live && !hasVisibleWork(group.entries)) return;
    fragment.append(workingGroup(group.entries, { live }));
  });
  if (activeRun?.approval_request_id) {
    const waiting = el('div', 'card approval-wait');
    waiting.append(el('p', null, 'Waiting for your approval. Later messages are queued behind this request.'));
    const review = el('button', 'primary', 'Review permission');
    review.type = 'button';
    review.onclick = () => reviewApproval(activeRun.approval_request_id);
    waiting.append(review);
    fragment.append(waiting);
  }
  if (roomStatus) {
    const progress = el('div', 'card room-progress');
    progress.append(el('p', null, roomStatus.text));
    if (roomStatus.approval_request_id) {
      const review = el('button', 'primary', 'Review permission');
      review.type = 'button';
      review.onclick = () => reviewApproval(roomStatus.approval_request_id);
      progress.append(review);
    }
    fragment.append(progress);
  }
  content.replaceChildren(fragment);
  view.scrollTop = atBottom ? view.scrollHeight : keep;
  requestAnimationFrame(followTranscript);
}

// Only user input can release the bottom lock. Layout and programmatic scroll
// events must not be mistaken for someone scrolling up to read older messages.
{
  const view = $('#transcript');
  let intent = null;
  let dragging = false;
  let touchY = 0;
  let intentTimer;
  const scrollIntent = (direction) => {
    intent = direction;
    clearTimeout(intentTimer);
    intentTimer = setTimeout(() => { intent = null; }, 250);
    if (direction === 'up') view.dataset.stick = '0';
  };
  view.dataset.stick = '1';
  view.addEventListener('wheel', (event) => {
    if (event.deltaY) scrollIntent(event.deltaY < 0 ? 'up' : 'down');
  }, { passive: true });
  view.addEventListener('touchstart', (event) => { touchY = event.touches[0].clientY; }, { passive: true });
  view.addEventListener('touchmove', (event) => {
    const y = event.touches[0].clientY;
    if (y !== touchY) scrollIntent(y > touchY ? 'up' : 'down');
    touchY = y;
  }, { passive: true });
  view.addEventListener('pointerdown', (event) => {
    // Only grabbing the scrollbar changes reading intent; clicking a message doesn't.
    dragging = event.clientX >= view.getBoundingClientRect().left + view.clientWidth;
  });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointercancel', () => { dragging = false; });
  view.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) scrollIntent('up');
    if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) scrollIntent('down');
  });
  view.addEventListener('scroll', () => {
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
    if (intent || dragging) view.dataset.stick = atBottom ? '1' : '0';
    else if (atBottom) view.dataset.stick = '1';
    // Keep intent through the wheel/touch momentum sequence. Do not scroll
    // inside a scroll callback: that fights native scrolling and resize events.
  }, { passive: true });
  const resize = new ResizeObserver(followTranscript);
  resize.observe(view);
  resize.observe($('#transcript-content'));
}

// Re-rendering must not close what you opened: groups are remembered by their first entry.
const openedWork = new Set();
const reasoningExpanded = new Map();
function workingGroup(entries, { live = false } = {}) {
  const key = entries[0].turn_id ?? entries[0].run_id ?? entries[0].stream_id?.split(':')[0] ?? entries[0].id ?? entries[0].at;
  const thoughts = entries.filter(e => e.kind === 'reasoning');
  const current = thoughts.findLast(e => e.live);
  const thought = current ?? {kind:'reasoning', stream_id:`${key}:history`, text:thoughts.map(e=>e.text).filter(Boolean).join('\n\n'), live};
  const details = renderEntry(thought);
  details.classList.add('working', 'turn-activity');
  details.open = openedWork.has(key);
  const heading = details.querySelector('summary');
  heading.addEventListener('click', () => { if (details.open) openedWork.delete(key); else openedWork.add(key); });
  const calls = entries.filter(e=>e.kind==='tool_call');
  const results = entries.filter(e=>e.kind==='tool_result');
  const count = `${calls.length} tool call${calls.length===1?'':'s'}`;
  // A finished turn with no thoughts is named by what it did, not as empty reasoning.
  if (!current && !thought.text) {
    const did = calls.length ? count : results.length ? `${results.length} tool result${results.length===1?'':'s'}` : 'Worked';
    heading.querySelector('.reasoning-caption > span').textContent = `${agentById(state.selected)?.name ?? 'Bot'} · ${did}`;
  } else if (calls.length) heading.querySelector('.reasoning-caption').append(el('span','working-count',count));
  const body = el('div','working-body');
  if (current) {
    const history = thoughts.filter(e=>e!==current).map(e=>e.text).filter(Boolean).join('\n\n');
    if (history) body.append(el('div','reasoning-history',history));
  }
  body.append(details.querySelector('.reasoning-text'));
  // One inspector: no per-step updates or nested reasoning dropdowns.
  for (const entry of entries.filter(e=>['tool_call','tool_result','approval_pending','system_note'].includes(e.kind))) {
    const node = renderEntry(entry); if (node) body.append(node);
  }
  details.append(body);
  return details;
}

function renderEntry(e) {
  const agent = agentById(state.selected);

  switch (e.kind) {
    case 'reasoning': {
      const block = el('details', 'reasoning-block');
      const key = e.stream_id ?? e.id;
      block.dataset.reasoningKey = key;
      block.open = reasoningExpanded.get(key) ?? false;
      const heading = el('summary', 'reasoning-heading');
      const face = el('span', 'reasoning-face');
      if (agent && e.live) face.append(agentFace(agent, 44));
      if (e.live && e.phase !== 'approval') {
        const dots = el('span', 'working-bubble');
        dots.setAttribute('aria-hidden', 'true');
        dots.append(el('i'), el('i'), el('i')); face.append(dots);
      }
      const caption = el('span', 'reasoning-caption');
      caption.append(el('span', null, `${agent?.name ?? 'Bot'} · ${e.live ? phaseLabel(e.phase) : 'Reasoning'}`));
      if (e.live && e.text) {
        const preview = el('span', 'reasoning-preview', e.text.trimEnd());
        caption.append(preview);
        requestAnimationFrame(() => { if (preview.isConnected) preview.scrollTop = preview.scrollHeight; });
      }
      if (e.live) heading.append(face);
      heading.append(caption);
      block.append(heading);
      block.append(el('div', 'reasoning-text', e.text));
      heading.addEventListener('click', () => { reasoningExpanded.set(key, !block.open); });
      return block;
    }

    case 'user_message': return bubble('from-user', 'You', e.text, null, e.attachments);

    case 'agent_text': {
      const node = bubble('from-agent', e.model ? `${agent?.name ?? 'Bot'} · ${modelLabel(e.model, e.model_provider, modelCatalog.data.providers)}` : (agent?.name ?? 'Bot'), e.text, agent ? agentFace(agent, 44) : null, [], { markdown: true });
      node.querySelector('.body').style.setProperty('--c', agent?.color ?? '#8b5cf6');
      return node;
    }

    case 'room_message': {
      if (e.sender_id === 'user') return bubble('from-user', 'You', e.text, null, e.attachments);
      const from = agentById(e.sender_id);
      if (e.system) return event('note', 'ROOM', e.text);
      const name = from?.name ?? e.sender_id;
      const node = bubble('from-agent', e.model && e.model_provider ? `${name} · ${modelLabel(e.model, e.model_provider, modelCatalog.data.providers)}` : name, e.text, from ? agentFace(from, 44) : null, [], { markdown: true });
      node.querySelector('.body').style.setProperty('--c', from?.color ?? '#8b5cf6');
      return node;
    }

    // Peer traffic reads as who → whom: both faces on one line, the text folded
    // underneath. The transcript owner is always one of the two.
    case 'peer_message_out': return peerLine(agent, agentById(e.target_id), e, 'sent');
    case 'peer_message_in': return peerLine(agentById(e.sender_id), agent, e, 'received');

    case 'tool_call': return event('', 'TOOL', `${e.name} ${compact(e.input)}`, true);

    case 'tool_result': {
      if (e.blocked) return event('blocked', 'BLOCKED', `${e.name} — ${e.basis}`);
      const ok = e.result?.ok !== false;
      return event(ok ? '' : 'blocked', ok ? 'RESULT' : 'FAILED', `${e.name} ${compact(e.result)}`, true);
    }

    case 'approval_pending':
      return event('pending', 'ASKING', `${e.name} needs your approval for ${e.action} on ${e.target}`);

    case 'system_note': {
      if (!e.room_id) return event('note', 'NOTE', e.text);
      const room = state.rooms.find(r => r.id === e.room_id);
      return event('note', 'ROOM', room ? `Took part in “${room.purpose}”.` : 'Took part in a room that has since been deleted.');
    }

    case 'run_failed': return event('blocked', 'FAILED', `The turn did not run${e.model ? ` (${modelLabel(e.model, e.model_provider, modelCatalog.data.providers)})` : ''}: ${e.error}`);

    default: return null;
  }
}

/** The header's "N waiting" chip opens to show what is waiting: who sent it and what it says. */
function inboxChip(agent) {
  const details = el('details', 'inbox-peek');
  const summary = el('summary', 'chip waiting', `✉ ${agent.inbox} waiting`);
  summary.title = 'Peer messages queued for this bot\'s next turn';
  details.append(summary);
  const list = el('div', 'inbox-list');
  details.append(list);
  details.addEventListener('toggle', async () => {
    if (!details.open) return;
    list.replaceChildren(el('p', 'hint', 'Loading…'));
    try {
      const { messages } = await api('GET', `/api/inbox?agent_id=${encodeURIComponent(agent.id)}`);
      list.replaceChildren();
      if (!messages.length) list.append(el('p', 'hint', 'Delivered — nothing waiting now.'));
      for (const m of messages) {
        const from = agentById(m.sender_id);
        const row = el('div', 'inbox-item');
        if (from) row.append(agentFace(from, 28));
        const body = el('div', 'inbox-body');
        body.append(el('strong', null, from?.name ?? m.sender_id), el('span', null, m.text));
        if (m.priority) body.prepend(el('span', 'badge', m.priority_reason));
        row.append(body);
        list.append(row);
      }
      list.append(el('p', 'hint', 'These are handed over together when the bot\'s next turn starts.'));
    } catch (err) { list.replaceChildren(el('p', 'hint', err.message)); }
  });
  return details;
}

function peerLine(from, to, e, verb) {
  const details = el('details', `peer ${verb}${e.priority ? ' priority' : ''}`);
  const summary = el('summary');
  const face = (a, id) => (a ? agentFace(a, 28) : el('span', 'dot big'));
  // A room is a peer too: a bot posts to one, and the room's outcome comes back.
  const name = (a, id) => a?.name ?? state.rooms?.find((r) => r.id === id)?.purpose ?? id;
  summary.append(face(from), el('span', 'peer-name', name(from, e.sender_id)));
  summary.append(el('span', 'tag', verb === 'sent' ? '→ sent to' : '→ received by'));
  summary.append(face(to), el('span', 'peer-name', name(to, e.target_id)));
  if (e.priority) summary.append(el('span', 'badge', e.priority_reason));
  summary.append(el('span', 'peer-preview', e.text || `${e.attachments?.length ?? 0} image${e.attachments?.length === 1 ? '' : 's'}`));
  const body = el('div', 'peer-body');
  if (e.text) body.append(el('div', 'peer-text', e.text));
  if (e.attachments?.length) body.append(renderAttachmentGallery(e.attachments));
  details.append(summary, body);
  return details;
}

function bubble(cls, by, text, face = null, attachments = [], { markdown = false } = {}) {
  const node = el('div', `msg ${cls}`);
  const label = el('div', 'by');
  if (face) label.append(face);
  label.append(el('span', null, by));
  let body;
  if (markdown && text) {
    body = el('div', 'body md');
    body.append(renderMarkdown(document, text, { onCopyCode: copyText }));
    // The whole reply, exactly as saved — not the rendered text.
    const copy = el('button', 'ghost small msg-copy', 'Copy');
    copy.type = 'button';
    copy.title = 'Copy this reply';
    copy.setAttribute('aria-label', `Copy reply from ${by}`);
    copy.onclick = () => copyText(text, copy);
    label.append(copy);
  } else body = el('div', 'body', text ?? '');
  if (attachments?.length) body.append(renderAttachmentGallery(attachments));
  node.append(label, body);
  return node;
}

/** Clipboard with a fallback for plain-HTTP consoles, where navigator.clipboard is absent. */
async function copyText(text, button = null) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch {
    const area = el('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area); area.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
  }
  if (!button) return ok;
  const before = button.dataset.label ?? button.textContent;
  button.dataset.label = before;
  button.textContent = ok ? 'Copied' : 'Copy failed';
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => { button.textContent = before; }, 1500);
  return ok;
}

function event(cls, tag, text, mono = false) {
  const node = el('div', `event ${cls}`.trim());
  node.append(el('span', 'tag', tag));
  node.append(mono ? el('code', null, text) : el('span', null, text));
  return node;
}

function compact(value) {
  if (value == null) return '';
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

// --------------------------------------------------------------- approvals ---

let approvalsSnapshot = null;
let approvalSaving = false;
function reviewApproval(requestId) {
  showPane('activity');
  requestAnimationFrame(() => [...document.querySelectorAll('#approvals .card')].find(card => card.dataset.requestId === requestId)?.scrollIntoView({ block: 'center' }));
}
function renderApprovals() {
  const snapshot = JSON.stringify([state.approvals, state.blocked, state.reconciliation, state.logCorruption, (state.agents ?? []).map(a => [a.id, a.name]), (state.rooms ?? []).map(r => [r.id, r.name, r.purpose])]);
  if (approvalSaving || snapshot === approvalsSnapshot) return;
  approvalsSnapshot = snapshot;
  const box = $('#approvals');
  box.replaceChildren();
  const blocked = state.blocked ?? [];
  // Cards live in a pane a phone may not be showing; the tab says how many wait.
  const waiting = (state.reconciliation?.length ?? 0) + state.approvals.length + blocked.length + (state.logCorruption?.length ? 1 : 0);
  const count = $('#approvals-count');
  if (count) { count.hidden = waiting === 0; count.textContent = waiting; }
  const badge = $('#tab-badge');
  badge.hidden = waiting === 0;
  badge.textContent = waiting;
  if (waiting === 0) {
    box.append(el('p', 'hint', 'Nothing is waiting on you.'));
    return;
  }
  // Stuck agents first: a CAPTCHA or login is only ever cleared by a person.
  if (state.logCorruption?.length) {
    const card = el('div', 'card blocked');
    card.append(el('h2', null, 'Stored history needs reconciliation'));
    card.append(el('p', null, 'Valid records remain available. Damaged bytes are preserved; missing evidence does not mean an action never happened.'));
    for (const issue of state.logCorruption) card.append(el('p', null, `${issue.source}, line ${issue.line}: ${issue.error}. Report: ${issue.report_file}`));
    box.append(card);
  }
  const clearItems = async (items, reports, button) => {
    button.disabled = true;
    const errors = [];
    for (const item of items) {
      try {
        await api('POST', '/api/reconciliation', {
          kind: item.kind, id: item.id, expected_revision: item.revision,
          outcome: 'abandoned', evidence: 'User cleared this interrupted task from Approvals. Preserve evidence; do not retry.',
          request_id: crypto.randomUUID(),
        });
      } catch (error) { errors.push(error.message); }
    }
    for (const report of reports) {
      try { await api('POST', '/api/blocked/resolve', { report_id: report.id }); }
      catch (error) { errors.push(error.message); }
    }
    try { await refresh(); }
    catch (error) { errors.push(error.message); }
    finally { button.disabled = false; }
    if (errors.length) banner(errors.join('; '), true);
  };
  if (state.reconciliation?.length || blocked.length) {
    const clearAll = el('button', null, 'Clear all tasks and reports');
    clearAll.onclick = () => clearItems([...(state.reconciliation ?? [])], [...blocked], clearAll);
    box.append(clearAll, el('p', 'hint', 'Clears interrupted tasks and blocker reports. History is kept; nothing is retried or approved.'));
  }
  for (const item of state.reconciliation ?? []) {
    const card = el('div', 'card blocked');
    const memory = item.kind === 'memory';
    card.append(el('h2', null, memory ? 'Memory save interrupted' : 'Task interrupted'));
    card.append(el('p', null, memory ? 'The app could not confirm whether this memory was saved. Dismiss this notice to leave it alone, or review the details before retrying.' : 'The app could not confirm whether this task finished. Review it before retrying to avoid repeating an action.'));
    const details = el('details'); details.append(el('summary', null, 'Technical details'), el('code', 'target', `Reference: ${item.id}`), el('pre', null, JSON.stringify(item.record, null, 2))); card.append(details);
    const outcome = el('select');
    for (const [value,label] of [['unresolved','Leave paused'],['confirmed_complete','It finished — mark done'],['confirmed_not_executed','It did not run — retry'],['abandoned','Dismiss without retrying']]) {
      const option = el('option', null, label); option.value = value; outcome.append(option);
    }
    const evidence = el('textarea'); evidence.placeholder = 'What did you check before choosing this action?';
    const save = el('button', null, 'Apply decision');
    const requestId = crypto.randomUUID();
    save.onclick = async () => {
      save.disabled = true;
      try { await api('POST', '/api/reconciliation', { kind: item.kind, id: item.id, expected_revision: item.revision, outcome: outcome.value, evidence: evidence.value, request_id: requestId }); await refresh(); }
      catch (error) { banner(error.message, true); save.disabled = false; }
    };
    const clear = el('button', null, 'Dismiss without retrying');
    clear.onclick = () => clearItems([item], [], clear);
    details.append(outcome, evidence, save);
    card.append(clear); box.append(card);
  }
  for (const report of blocked) {
    const agent = agentById(report.agent_id);
    const card = el('div', 'card blocked');
    const publicRead = report.detail?.startsWith('WebReadPublic (');
    card.append(el('h2', null, publicRead ? `${agent?.name ?? report.agent_id} couldn’t read a public page` : `${agent?.name ?? report.agent_id} is stuck: ${report.reason.replace(/_/g, ' ')}`));
    card.append(el('p', null, report.detail));
    if (report.ladder?.length) {
      const tried = el('ol', 'hint');
      for (const rung of report.ladder) tried.append(el('li', null, rung));
      card.append(el('p', 'hint', 'Already tried:'), tried);
    }
    if (publicRead) card.append(el('p', 'hint', 'This notice does not pause the bot. Dismissing it does not retry the page.'));
    if (!publicRead && report.screenshot) {
      const img = el('img', 'shot');
      img.src = `/api/screens/${encodeURIComponent(report.screenshot)}`;
      img.alt = `${agent?.name ?? 'bot'} screen`;
      card.append(img);
    }
    if (!publicRead && report.view) card.append(el('code', 'target', `Take over: ${report.view}`));
    const row = el('div', 'row');
    const done = el('button', 'primary', publicRead ? 'Dismiss notice' : 'Cleared it');
    done.type = 'button';
    done.onclick = () => clearItems([], [report], done);
    row.append(done);
    card.append(row);
    box.append(card);
  }
  for (const request of state.approvals) {
    const agent = agentById(request.agent_id);
    const card = el('div', 'card approval-card');
    card.dataset.requestId = request.id;
    const coordination = request.action.startsWith('coordination.');
    const words = describeRequest(request, agent?.name ?? 'This bot');
    const head = el('h2', null, words.headline);
    if (words.highRisk) { const chip = el('span', 'chip risk', 'High risk'); chip.title = 'Take extra care with this one.'; head.append(chip); }
    card.append(head);
    if (coordination) {
      let target;
      try { target = JSON.parse(request.target); } catch { target = { target_id: request.target }; }
      const name = id => agentById(id)?.name ?? state.rooms.find(r => r.id === id)?.purpose ?? id;
      const recipient = target?.target_id ?? request.target;
      card.append(el('p', 'approval-recipient', `To: ${name(recipient)}`));
      if (target?.recipients?.length > 1) card.append(el('p', 'hint', `Members: ${target.recipients.map(name).join(', ')}`));
    } else if (words.target) {
      const what = el('div', 'approval-what');
      what.append(el('span', 'approval-label', `${words.targetLabel}:`), el('code', 'target', words.target));
      card.append(what);
    }
    if (words.tool) card.append(el('p', 'hint', `Tool: ${words.tool}`));
    if (words.risk) card.append(el('p', 'approval-risk', words.risk));
    // The raw request, for anyone who wants to check it, stays one click away.
    const callDetails = el('details', 'approval-technical');
    callDetails.append(el('summary', null, 'Technical details'), el('code', 'target', `${request.action}${request.tool ? ` · ${request.tool}` : ''}\n${request.target ?? '(no target)'}`));
    if (request.parameters) callDetails.append(el('pre', 'target', JSON.stringify(request.parameters, null, 2)));
    card.append(callDetails);
    // Decide on evidence: the agent's screen at the moment it asked.
    if (!coordination && request.evidence?.screenshot) {
      const img = el('img', 'shot');
      img.src = `/api/screens/${encodeURIComponent(request.evidence.screenshot)}`;
      img.alt = 'screen when asking';
      card.append(img);
    }
    if (!coordination && request.evidence?.view) card.append(el('code', 'target', `Look yourself: ${request.evidence.view}`));
    card.append(el('p', 'hint', `If you don’t answer by ${new Date(request.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, this counts as a no.`));

    const row = el('div', 'row approval-answers');
    const standing = el('div', 'row approval-standing');
    const answers = [
      ['allow_once', 'Allow once', 'primary', row, 'Let this one action happen. You’ll be asked again next time.'],
      ['deny', 'Don’t allow', 'ghost deny', row, 'Say no to this one action.'],
      ['always', `Always allow`, 'ghost', standing, `Standing rule: never ask again for ${words.covers}.`],
      ['never', `Always block`, 'ghost deny', standing, `Standing rule: never allow ${words.covers}, and stop asking.`],
    ];
    for (const [resolution, label, cls, target, help] of answers) {
      const button = el('button', cls, label);
      button.type = 'button';
      button.dataset.resolution = resolution;
      button.title = help;
      const blockedAlways = resolution === 'always' && request.ceiling !== 'always';
      button.disabled = blockedAlways || (resolution === 'allow_once' && request.effective_mode === 'never');
      if (blockedAlways) button.title = 'An administrator limit stops you from choosing this.';
      button.onclick = async () => {
        approvalSaving = true;
        button.textContent = `${label} — saving…`;
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          const result = await api('POST', '/api/approve', { request_id: request.id, resolution });
          banner(result.ok ? OUTCOME_TOAST[resolution] : `That didn’t go through: ${result.reason}`, !result.ok);
        } catch (err) {
          banner(err.message, true);
        }
        approvalSaving = false;
        approvalsSnapshot = null;
        await refresh();
        renderApprovals();
        loadTranscript();
      };
      target.append(button);
    }
    card.append(row);
    // A standing rule reaches every bot, so say so right where it is offered.
    card.append(el('p', 'hint approval-standing-note', coordination ? 'Allow once covers this recipient for this task. A different recipient needs its own OK.' : `Or set a standing rule for “${words.category}”:`));
    if (!coordination) { card.append(standing); card.append(el('p', 'hint', standingRuleHelp(words.zone))); }
    box.append(card);
  }
}

// ------------------------------------------------------------ permissions ---

// Standing modes are the trust boundary, and changing one is a
// user-only decision. Approval cards set them as a side effect of answering;
// this panel is where an Always or a Never is inspected and reversed to Ask.
const MODE_RANK = { never: 0, ask: 1, always: 2 };

let permissionsSnapshot = null;
let permissionsSaving = 0;
function renderPermissions() {
  const snapshot = JSON.stringify([state.standing, state.ceilings, state.explicitPermissions]);
  if (permissionsSaving || snapshot === permissionsSnapshot) return;
  permissionsSnapshot = snapshot;
  const box = $('#permissions');
  const zones = Object.keys(state.standing ?? {});
  if (!zones.length) {
    box.replaceChildren(el('p', 'hint', 'The host did not report permission zones yet.'));
    return;
  }
  box.replaceChildren();
  for (const zone of zones) {
    const standing = state.standing[zone] ?? 'ask';
    const ceiling = state.ceilings[zone] ?? 'ask';
    const chosen = Boolean(state.explicitPermissions?.[zone]);

    const card = el('div', 'card');
    const head = el('h2', null, zoneTitle(zone));
    card.dataset.zone = zone;
    // A zone nobody chose follows the built-in default: bots work without asking.
    const eff = el('span', 'chip', chosen ? 'Your choice' : 'Built-in default');
    eff.title = chosen
      ? `You chose: ${MODE_COPY[standing]?.label ?? standing}.`
      : 'You haven’t chosen yet: bots work without asking.';
    head.append(eff);
    card.append(head);
    card.append(el('p', 'hint', ZONE_COPY[zone]?.note ?? ''));
    card.append(el('p', 'permission-current', chosen ? `Right now: ${MODE_COPY[standing]?.label ?? standing}.` : 'Right now: built-in default — bots work without asking.'));
    if (ceiling !== 'always') card.append(el('p', 'hint', `An administrator limit means the most you can allow here is “${MODE_COPY[ceiling]?.label ?? ceiling}”.`));
    if (standing === 'always' && chosen && zone === 'external') card.append(el('p', 'hint', 'Every connected tool will run without asking, including ones you add later.'));

    const row = el('div', 'row');
    for (const mode of ['ask', 'always', 'never']) {
      const button = el('button', mode === 'never' ? 'ghost deny' : 'ghost', MODE_COPY[mode].label);
      button.type = 'button';
      button.dataset.mode = mode;
      const selected = mode === standing && chosen;
      button.setAttribute('aria-pressed', String(selected));
      if (selected) button.classList.add('selected');
      if (MODE_RANK[mode] > MODE_RANK[ceiling]) {
        button.disabled = true;
        button.title = `An administrator limit of “${MODE_COPY[ceiling]?.label ?? ceiling}” stops you choosing this.`;
      } else {
        button.title = selected ? `${MODE_COPY[mode].label} is on.` : `Set “${zoneTitle(zone)}” to “${MODE_COPY[mode].label}”.`;
        button.onclick = async () => {
          permissionsSaving++;
          for (const b of row.querySelectorAll('button')) {
            b.disabled = true;
            b.classList.toggle('selected', b === button);
            b.setAttribute('aria-pressed', String(b === button));
          }
          button.textContent = `${MODE_COPY[mode].label} — saving…`;
          try {
            const saved = await api('POST', '/api/permissions', { zone, mode });
            ++refreshSerial; // discard state reads that started before this saved choice
            state.standing[zone] = saved.mode;
            (state.explicitPermissions ??= {})[zone] = true;
            banner(`${zoneTitle(zone)}: ${MODE_COPY[mode].label}.`);
          } catch (err) {
            banner(`Not applied: ${err.message}`, true);
          } finally {
            permissionsSaving--;
            permissionsSnapshot = null;
            renderPermissions();
          }
          await refresh();
        };
      }
      row.append(button);
    }
    card.append(row);
    box.append(card);
  }
}

// ---------------------------------------------------------------- activity ---

const INTERESTING = /^(run\.|message\.|permission\.|room\.|tool\.|computer\.|memory\.remembered|agent\.|workflow\.)/;
const HOT = /interrupt|priority|superseded|asked|pending/;
const BAD = /blocked|failed|denied|expired|theft|exceeded/;
// The payload fields that say what actually happened, per event family.
const DETAIL_FIELDS = ['action', 'target', 'basis', 'resolution', 'zone', 'mode', 'actor', 'lane', 'reason'];
// Identifiers read better in prose, but targets must stay verbatim: an exact
// path, URL, or address is the fact a permission decision turns on.
const PROSE_FIELDS = new Set(['action', 'basis', 'resolution', 'lane']);
// Structured targets survive as JSON — String(object) would only say '[object Object]'.
function formatDetail(field, value) {
  if (PROSE_FIELDS.has(field)) return String(value).replace(/[._]/g, ' ');
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value).slice(0, 300); } catch { return String(value); }
}

const activityIds = new Set();
function pushActivity(event) {
  if (!INTERESTING.test(event.type) || activityIds.has(event.id)) return;
  if (event.id) activityIds.add(event.id);
  if (activityIds.size > 500) activityIds.delete(activityIds.values().next().value);
  const list = $('#activity');
  const li = el('li');
  if (BAD.test(event.type)) li.classList.add('bad');
  else if (HOT.test(event.type)) li.classList.add('hot');

  const time = el('time', null, new Date(event.at).toLocaleTimeString([], { hour12: false }));
  const label = event.type.replace(/^[a-z]+\./, '');
  const who = event.agent_id ? agentById(event.agent_id)?.name : null;
  li.append(time, el('span', 't', who ? `${label} · ${who}` : label));

  const details = DETAIL_FIELDS
    .filter((f) => event[f] != null && event[f] !== '')
    .map((f) => formatDetail(f, event[f]));
  if (details.length) li.append(el('span', 't detail', details.join(' · ')));

  // Every row opens its record: run-linked rows get the full run drilldown,
  // and permission changes without a run still show actor, mode, and evidence.
  li.classList.add('linked');
  li.title = event.run_id ? 'View run details' : 'View event details';
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  const open = () => (event.run_id ? openExplain(event.run_id) : openEventDetails(event));
  li.onclick = open;
  li.onkeydown = (keyboardEvent) => {
    if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
    keyboardEvent.preventDefault();
    open();
  };

  list.prepend(li);
  while (list.children.length > 200) list.lastElementChild.remove();
}

// ----------------------------------------------------------- run drilldown ---

const PROVENANCE_LABELS = {
  provider_reported: 'provider-reported',
  estimated: 'estimated',
  mixed: 'mixed',
  unknown: 'unknown',
};

async function openExplain(runId) {
  const dialog = $('#explain-dialog');
  dialog.replaceChildren(el('p', 'hint', 'Loading run details…'));
  dialog.showModal();
  try {
    const { run, audit, result } = await api('GET', `/api/explain?run_id=${encodeURIComponent(runId)}`);
    dialog.replaceChildren(...explainNodes(dialog, run ?? {}, audit, result));
  } catch (err) {
    dialog.close();
    banner(`Run details unavailable: ${err.message}`, true);
  }
}

// Permission changes carry no run id, but the person still gets the record:
// every field the host logged, plus any saved approval screenshot.
function openEventDetails(event) {
  const dialog = $('#explain-dialog');
  dialog.replaceChildren(...eventNodes(dialog, event));
  dialog.showModal();
}

function eventNodes(dialog, event) {
  const nodes = [];
  const head = el('div');
  head.append(el('h2', null, `Event ${event.type ?? ''}`.trim()));
  head.append(el('p', 'hint', event.at ? new Date(event.at).toLocaleString() : ''));
  const close = el('button', 'ghost', 'Close');
  close.type = 'button';
  close.onclick = () => dialog.close();
  head.append(close);
  nodes.push(head);
  if (event.screenshot) {
    const img = el('img', 'shot');
    img.src = `/api/screens/${encodeURIComponent(event.screenshot)}`;
    img.alt = 'saved approval evidence';
    nodes.push(img);
  }
  nodes.push(el('h3', null, 'Recorded fields'));
  const list = el('ul', 'explain-list');
  for (const [key, value] of Object.entries(event)) {
    if (value == null || value === '' || key === 'at' || key === 'type' || key === 'screenshot') continue;
    list.append(el('li', null, `${key}: ${formatDetail(key, value)}`));
  }
  nodes.push(list);
  return nodes;
}

function explainNodes(dialog, run, audit = [], result = null) {
  const nodes = [];
  const head = el('div');
  head.append(el('h2', null, `Run ${run.id ?? 'details'}`));
  head.append(el('p', 'hint', [
    run.status, run.lane, run.model, run.model_provider,
    run.error ? `error: ${run.error}` : null,
    run.interrupt_reason ? `stopped: ${run.interrupt_reason}` : null,
  ].filter(Boolean).join(' · ')));
  const close = el('button', 'ghost', 'Close');
  close.type = 'button';
  close.onclick = () => dialog.close();
  head.append(close);
  nodes.push(head);

  if (audit.length) {
    nodes.push(el('h3', null, 'Authorization trail'));
    const list = el('ul', 'explain-list');
    for (const entry of audit.slice(-80)) {
      const li = el('li');
      const outcome = entry.result && typeof entry.result === 'object' && 'ok' in entry.result
        ? (entry.result.ok ? 'result: ok' : 'result: failed') : null;
      // Thrown failures carry a top-level error; returned failures nest it in
      // the result (host.js tool.executed). Both are the reason it went wrong.
      const reason = entry.error ?? entry.result?.error ?? null;
      const bits = [
        new Date(entry.at).toLocaleTimeString([], { hour12: false }),
        entry.type,
        entry.agent_id ? agentById(entry.agent_id)?.name ?? entry.agent_id : null,
        entry.action ? String(entry.action).replace(/[._]/g, ' ') : null,
        entry.target ? `→ ${formatDetail('target', entry.target)}` : null,
        entry.actor ? `by ${entry.actor}` : null,
        entry.resolution ? String(entry.resolution).replace(/[._]/g, ' ') : null,
        entry.basis ? String(entry.basis).replace(/[._]/g, ' ') : null,
        entry.tool ?? entry.name ?? null,
        entry.call_id ? `call ${entry.call_id}` : null,
        entry.request_id ? `request ${entry.request_id}` : null,
        outcome,
        reason ? `error: ${reason}` : null,
      ].filter(Boolean);
      li.append(el('span', 't', bits.join(' · ')));
      list.append(li);
    }
    nodes.push(list);
    // Retained approval evidence: the card is gone; the screenshot remains,
    // served under the same authorization as the approval card used.
    for (const entry of audit.slice(-80)) {
      if (!entry.screenshot) continue;
      const img = el('img', 'shot');
      img.src = `/api/screens/${encodeURIComponent(entry.screenshot)}`;
      img.alt = `saved approval evidence for ${entry.request_id ?? 'this request'}`;
      nodes.push(img);
    }
  } else {
    nodes.push(el('p', 'hint', 'No authorization events were recorded for this run.'));
  }

  const outcome = el('div');
  outcome.append(el('h3', null, 'Outcome'));
  const text = result?.text ?? result?.output;
  if (text) outcome.append(el('p', null, String(text).slice(0, 2000)));
  if (result?.usage) {
    const u = result.usage;
    const label = PROVENANCE_LABELS[u.provenance] ?? 'unlabeled';
    outcome.append(el('p', 'hint', `Usage: ${u.input_tokens ?? 0} in, ${u.output_tokens ?? 0} out — ${label} token counts, not billing-authoritative data.`));
  }
  if (!text && !result?.usage) outcome.append(el('p', 'hint', 'No visible output was recorded for this run.'));
  nodes.push(outcome);
  return nodes;
}

// ---------------------------------------------------------------- composer ---

function mode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

// Keep drafts (including failed sends and uploading previews) in their original
// conversation for this page's lifetime. A completion must never edit another
// recipient's draft, even after switching away and back or changing peer sender.
const composerDrafts = new Map();
const savedDrafts = draftStore({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key),
});
function persistDraft(draft) {
  if (draft && !savedDrafts.save(draft.key, draft.text, draft.images.items.length > 0 || draft.reselect))
    banner('This draft could not be saved on this device. Keep the window open or copy your text.', true);
}
window.addEventListener('pagehide', () => {
  if (activeComposerDraft) { activeComposerDraft.text = $('#input').value; persistDraft(activeComposerDraft); }
});
const pendingRoomSends = new Set();
let activeComposerDraft;
let imageDraft;

function syncComposerDraft() {
  const isRoom = state.selectedKind === 'room';
  const sendMode = isRoom ? 'room' : mode();
  const key = JSON.stringify([state.selectedKind, state.selected, sendMode, sendMode === 'peer' ? $('#peer-from').value : '']);
  let draft = composerDrafts.get(key);
  if (draft && draft === activeComposerDraft) return;
  const input = $('#input');
  if (activeComposerDraft) { activeComposerDraft.text = input.value; persistDraft(activeComposerDraft); }
  if (!draft) {
    const saved = savedDrafts.read(key);
    draft = { key, text: saved.text, reselect: saved.attachments, images: new ImageAttachmentDraft({
      upload: uploadImage,
      createObjectURL: (file) => URL.createObjectURL(file),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
      onChange: () => {
        persistDraft(draft);
        if (draft === activeComposerDraft) { renderImageDraft(); renderComposer(); }
      },
    }) };
    composerDrafts.set(key, draft);
  }
  activeComposerDraft = draft;
  imageDraft = draft.images;
  input.value = draft.text;
  fitComposerInput();
  renderImageDraft();
}

function renderImageDraft() {
  const box = $('#attachment-previews');
  box.replaceChildren();
  box.hidden = imageDraft.items.length === 0 && !activeComposerDraft?.reselect;
  if (activeComposerDraft?.reselect) {
    const note = el('p', 'attachment-queue-note', 'Your text draft was restored. Please reattach any images you still want to send.');
    const dismiss = el('button', 'ghost small', 'Dismiss');
    dismiss.type = 'button'; dismiss.onclick = () => { activeComposerDraft.reselect = false; persistDraft(activeComposerDraft); renderImageDraft(); };
    note.append(dismiss); box.append(note);
  }
  const readyCount = imageDraft.readyCount();
  if (readyCount > 4) {
    box.append(el('p', 'attachment-queue-note', attachmentQueueNote(readyCount)));
  }
  for (const item of imageDraft.items) {
    const preview = el('figure', `attachment-preview ${item.status}`);
    const image = el('img');
    image.src = item.preview_url;
    image.alt = item.file.name;
    const caption = el('figcaption');
    caption.append(el('strong', null, item.file.name));
    const status = item.status === 'uploaded' ? 'Ready' : item.status === 'submitting' ? 'Sending…' : item.status === 'error' ? item.error : 'Uploading…';
    caption.append(el('span', item.status === 'error' ? 'attachment-error' : null, status));
    const actions = el('div', 'attachment-actions');
    if (item.status === 'error') {
      const retry = el('button', 'ghost small', 'Retry');
      retry.type = 'button';
      retry.onclick = () => { imageDraft.retry(item.key); };
      actions.append(retry);
    }
    if (item.status !== 'submitting') {
      const remove = el('button', 'ghost small', 'Remove');
      remove.type = 'button';
      remove.onclick = () => { imageDraft.remove(item.key); };
      actions.append(remove);
    }
    preview.append(image, caption, actions);
    box.append(preview);
  }
}

async function addImageFiles(files) {
  if (!state.selected) {
    banner('Select a bot or room before attaching images.', true);
    return;
  }
  const result = await imageDraft.addFiles(files);
  if (result.errors.length) banner(result.errors.join(' '), true);
}

const stoppingAgents = new Set();
async function stopSelectedAgent() {
  const selected = state.selected;
  if (!selected || stoppingAgents.has(selected)) return;
  const isRoom = state.selectedKind === 'room';
  const agent = agentById(selected);
  const runs = [...new Set([agent?.active_run, ...(agent?.queued ?? [])].filter(Boolean).map(run => run.id))];
  stoppingAgents.add(selected);
  renderComposer();
  try {
    const results = await Promise.allSettled(isRoom
      ? [api('POST', '/api/rooms/stop', {room_id:selected})]
      : state.agentStopEnabled
        ? [api('POST', '/api/agents/stop', {agent_id:selected})]
        : runs.map(run_id => api('POST', '/api/runs/cancel', {run_id})));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new Error(failures.map(result => result.reason.message).join('; '));
    banner('Stop requested. Active and queued work is being cancelled.');
  } catch (error) { banner(`Could not stop: ${error.message}`, true); }
  finally { stoppingAgents.delete(selected); await refresh(); renderComposer(); await loadTranscript(); }
}

function renderComposer() {
  const input = $('#input');
  const button = $('#composer button[type="submit"]');
  const attach = $('#attach-images');
  const from = $('#peer-from');
  const priority = $('#peer-priority');
  const isRoom = state.selectedKind === 'room';
  const peer = mode() === 'peer';

  from.hidden = !peer || isRoom;
  priority.hidden = !peer || isRoom;
  $('.composer-modes').hidden = isRoom;

  const priorSender = from.value;
  let senderStillAvailable = false;
  from.replaceChildren();
  for (const agent of state.agents) {
    if (agent.id === state.selected) continue;
    const option = el('option', null, agent.name);
    option.value = agent.id;
    from.append(option);
    if (agent.id === priorSender) senderStillAvailable = true;
  }
  if (senderStillAvailable) from.value = priorSender;
  syncComposerDraft();

  // Only agent follow-ups are queued by the host. Rooms allow one round at a
  // time, but typing the next draft and sending to other recipients stay free.
  const ready = Boolean(state.selected);
  input.disabled = !ready;
  button.disabled = !ready || imageDraft.hasPending() || (isRoom && pendingRoomSends.has(state.selected));
  attach.disabled = !ready || imageDraft.availableCount() >= 4;

  const target = agentById(state.selected);
  const stop = $('#stop-agent');
  const stopping = stoppingAgents.has(state.selected) || target?.active_run?.status === 'cancelling';
  stop.textContent = stopping ? 'Stopping…' : '■ Stop';
  const room = isRoom ? state.rooms.find((r) => r.id === state.selected) : null;
  // A room has something to stop only while a discussion or a member's room turn is running.
  const roomBusy = Boolean(room && (room.discussion?.status === 'active' || state.agents.some((a) => a.active_run?.payload?.room_id === room.id)));
  stop.disabled = stopping || (isRoom ? !roomBusy : (!target?.active_run && !target?.queued?.length)) || !state.selected;
  stop.title = isRoom ? 'Stop this room’s discussion' : 'Stop this bot and cancel its queued work';
  stop.onclick = stopSelectedAgent;
  input.placeholder = isRoom
    ? `Say something to ${room?.purpose ?? 'the room'}…`
    : peer
      ? `Message ${target?.name ?? 'the bot'} as a teammate…`
      : `Ask ${target?.name ?? 'the bot'} to do something…`;

  $('#lane-note').textContent = isRoom
    ? 'Members answer in one bounded round each time you speak (up to 3 rounds, 10 messages).'
    : peer
      ? 'Peer messages are fire-and-forget. Priority can supersede background work, never a user turn.'
      : 'A user turn runs in the protected user lane and cannot be interrupted by any bot.';
}

// Set up the initial draft and disabled controls before network state arrives.
renderComposer();

$('#composer').addEventListener('submit', async (submitEvent) => {
  submitEvent.preventDefault();
  const input = $('#input');
  const text = input.value.trim();
  const attachmentIds = imageDraft.attachmentIds();
  if ((!text && attachmentIds.length === 0) || !state.selected || imageDraft.hasPending()) return;

  const submission = captureComposerSubmission({
    selectedKind: state.selectedKind,
    selectedId: state.selected,
    mode: mode(),
    senderId: $('#peer-from').value,
    priorityReason: $('#peer-priority').value || null,
    text,
    attachmentIds,
  });
  if (submission.selectedKind !== 'room' && submission.mode === 'peer' && !submission.senderId) {
    banner('Add a second bot to send peer messages.', true);
    return;
  }
  const isRoom = submission.selectedKind === 'room';
  if (isRoom && pendingRoomSends.has(submission.selectedId)) return;
  const draft = activeComposerDraft;
  if (transcriptPage.owner === `${submission.selectedKind}:${submission.selectedId}`) transcriptPage.before = null;
  const request = requestForSubmission(submission);
  const attachments = draft.images.items
    .filter((item) => item.attachment?.id && attachmentIds.includes(item.attachment.id))
    .map((item) => item.attachment);
  if (isRoom) pendingRoomSends.add(submission.selectedId);

  try {
    input.value = draft.text = '';
    fitComposerInput();
    draft.reselect = false;
    persistDraft(draft);
    draft.images.claim(submission.attachmentIds);
    renderComposer();
    banner(state.live ? 'Thinking… (paid request)' : 'Running…');
    if (isRoom) {
      const view = $('#transcript');
      transcriptSnapshot = '';
      $('#transcript-content').append(renderEntry({ kind: 'room_message', sender_id: 'user', text, attachments }));
      view.dataset.stick = '1';
      view.scrollTop = view.scrollHeight;
      banner(state.live ? 'The room is talking… (paid requests)' : 'The room is talking…');
      const { result } = await api('POST', request.route, request.body);
      banner(`Round over: ${result.stop_reason.replace(/_/g, ' ')} · ${result.total_messages} messages`);
    } else if (submission.mode === 'peer') {
      await api('POST', request.route, request.body);
    } else {
      // The host records the message before the model runs, so show it now
      // instead of when the answer lands.
      const view = $('#transcript');
      transcriptSnapshot = '';
      $('#transcript-content').append(renderEntry({ kind: 'user_message', text, attachments }));
      view.dataset.stick = '1';
      view.scrollTop = view.scrollHeight;
      const asking = api('POST', request.route, request.body);
      setTimeout(() => { loadTranscript(); refresh(); }, 250);
      await asking;
    }
    draft.images.clearSent(submission.attachmentIds);
    persistDraft(draft);
    $('#banner').hidden = true;
  } catch (err) {
    draft.images.restoreClaim(submission.attachmentIds);
    draft.text = restoreFailedText(submission.text, draft === activeComposerDraft ? input.value : draft.text);
    if (draft === activeComposerDraft) input.value = draft.text;
    persistDraft(draft);
    banner(err.message, true);
  } finally {
    if (isRoom) pendingRoomSends.delete(submission.selectedId);
    renderComposer();
  }
  await refresh();
  await loadTranscript();
  input.focus();
});

$('#attach-images').addEventListener('click', () => { $('#image-picker').click(); });
$('#image-picker').addEventListener('change', async (event) => {
  await addImageFiles(event.target.files);
  event.target.value = '';
});
$('#input').addEventListener('paste', (event) => {
  const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  addImageFiles(images);
});
{
  const composer = $('#composer');
  composer.addEventListener('dragover', (event) => {
    if (!Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file')) return;
    event.preventDefault();
    composer.classList.add('dragging-images');
  });
  composer.addEventListener('dragleave', (event) => {
    if (!composer.contains(event.relatedTarget)) composer.classList.remove('dragging-images');
  });
  composer.addEventListener('drop', (event) => {
    // Let the textarea take dropped text natively; only file drops are ours.
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    composer.classList.remove('dragging-images');
    addImageFiles(event.dataTransfer?.files ?? []);
  });
}

function fitComposerInput() {
  const input = $('#input');
  input.style.height = 'auto';
  // A hidden pane (a phone showing another tab) measures 0; leave it to the stylesheet then.
  if (input.scrollHeight > 0) input.style.height = `${input.scrollHeight}px`;
}
$('#input').addEventListener('keydown', (keyEvent) => {
  if (keyEvent.key === 'Enter' && !keyEvent.shiftKey && !keyEvent.isComposing && keyEvent.keyCode !== 229) {
    keyEvent.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#input').addEventListener('input', (inputEvent) => {
  if (activeComposerDraft) { activeComposerDraft.text = inputEvent.target.value; persistDraft(activeComposerDraft); }
  fitComposerInput();
});
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', renderComposer);
}
$('#peer-from').addEventListener('change', renderComposer);

// -------------------------------------------------------------------- forms --

function toggleForm(buttonSel, formSel, onOpen) {
  const button = $(buttonSel);
  const form = $(formSel);
  button.onclick = () => {
    form.hidden = !form.hidden;
    button.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) {
      onOpen?.();
      form.querySelector('input')?.focus();
    }
  };
  form.querySelector('[data-cancel]').onclick = () => {
    form.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
}

function resetCreateTools() { renderToolPicker('create', toolCatalog ? defaultTools() : []); }
toggleForm('#new-agent', '#agent-form', () => {
  fillDeskList(); refreshModels(); resetCreateTools();
  if (!toolCatalog) fetchToolCatalog().then(resetCreateTools);
});
toggleForm('#new-room', '#room-form', () => {
  const box = $('#room-members');
  box.replaceChildren(el('legend', null, 'Members (at least one)'));
  for (const agent of state.agents) {
    const label = el('label');
    const check = el('input');
    check.type = 'checkbox';
    check.value = agent.id;
    label.append(check, document.createTextNode(agent.name));
    box.append(label);
  }
});

$('#agent-form').addEventListener('submit', async (formEvent) => {
  formEvent.preventDefault();
  const data = new FormData(formEvent.target);
  try {
    const agent = await api('POST', '/api/agents', {
      name: data.get('name').trim(),
      role: data.get('role').trim(),
      desk: data.get('desk'),
      prompt: data.get('prompt'),
      ...decodeModelChoice(data.get('model')),
      reasoning_effort: data.get('reasoning_effort') || null,
      color: data.get('create-color'),
      shape: data.get('create-shape'),
      style: data.get('create-style'),
      hair: data.get('create-hair'),
      // Without the catalog, the server applies the same safe default.
      ...(toolCatalog ? { allowed_tools: chosenTools('create') } : {}),
    });
    formEvent.target.reset();
    formEvent.target.hidden = true;
    buildPicker($('#create-avatar'), 'create');
    buildModelSelect($('#create-model'), '');
    $('#new-agent').setAttribute('aria-expanded', 'false');
    await refresh();
    select('agent', agent.id);
    banner(`${agent.profile.name} joined`);
  } catch (err) {
    banner(err.message, true);
  }
});

function fillDeskList() {
  const list = $('#desk-names');
  list.replaceChildren(...deskNames().filter(Boolean).map((d) => { const o = el('option'); o.value = d; return o; }));
}


let quickReasoningSnapshot = null;
let quickReasoningSaving = false;
function renderQuickReasoning() {
  const agent = state.selectedKind === 'agent' ? agentById(state.selected) : null;
  const options = agent ? reasoningOptions(agent.model_provider ?? state.modelProvider, agent.model ?? state.model) : [];
  const snapshot = JSON.stringify([agent?.id, agent?.reasoning_effort, options]);
  if (quickReasoningSaving || snapshot === quickReasoningSnapshot) return;
  quickReasoningSnapshot = snapshot;
  const select = $('#quick-reasoning');
  select.replaceChildren();
  for (const value of ['', ...options]) {
    const option = el('option', null, value ? (EFFORT_LABELS[value] ?? value) : 'Provider default');
    option.value = value; select.append(option);
  }
  select.value = agent?.reasoning_effort ?? '';
  select.disabled = !options.length;
  $('#quick-reasoning-note').textContent = !agent ? 'Select a bot to adjust its reasoning.' : options.length ? `${agent.name} · saves immediately for the next request.` : 'This model uses its provider’s default reasoning.';
}
$('#quick-reasoning').onchange = async () => {
  const agentId = state.selected;
  const effort = $('#quick-reasoning').value || null;
  quickReasoningSaving = true;
  $('#quick-reasoning').disabled = true;
  try {
    await api('PATCH', '/api/agents', {agent_id: agentId, reasoning_effort: effort});
    ++refreshSerial;
    const agent = agentById(agentId);
    if (agent) agent.reasoning_effort = effort;
    banner('Reasoning level saved');
  } catch (error) { banner(error.message, true); }
  finally { quickReasoningSaving = false; quickReasoningSnapshot = null; renderQuickReasoning(); }
  await refresh();
};
function showSettingsPage(name) {
  for (const section of document.querySelectorAll('[data-settings-section]')) section.hidden = section.dataset.settingsSection !== name;
  for (const button of document.querySelectorAll('[data-settings-page]')) {
    if (button.dataset.settingsPage === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('.settings-content').scrollTop = 0;
  if (name === 'plugins') renderPlugins();
  if (name === 'providers') renderProviders();
}
for (const button of document.querySelectorAll('[data-settings-page]')) button.onclick = () => showSettingsPage(button.dataset.settingsPage);
let settingsOpenedBefore = false;
$('#open-app-settings').onclick = () => {
  $('#app-settings').showModal();
  // With no AI provider connected yet, that is the only thing worth showing first.
  const first = !settingsOpenedBefore && state.live === false;
  settingsOpenedBefore = true;
  showSettingsPage(first ? 'providers' : document.querySelector('[data-settings-page][aria-current]').dataset.settingsPage);
};
$('#connect-provider').onclick = () => {
  $('#app-settings').showModal();
  settingsOpenedBefore = true;
  showSettingsPage('providers');
};
$('#close-app-settings').onclick = () => $('#app-settings').close();
$('#close-app-settings-footer').onclick = () => $('#app-settings').close();

// Bots work without asking, so the first open says so before anything else.
// Escape cannot skip it; only accepting closes it.
let autonomyAccepted = false;
function showAutonomyNotice(acknowledged) {
  const dialog = $('#autonomy-notice');
  if (acknowledged !== false || autonomyAccepted || dialog.open) return;
  dialog.showModal();
}
$('#autonomy-notice').addEventListener('cancel', event => event.preventDefault());
$('#accept-autonomy').onclick = async () => {
  const button = $('#accept-autonomy');
  button.disabled = true;
  try {
    await api('POST', '/api/permissions/acknowledge', {});
    autonomyAccepted = true;
    $('#autonomy-notice').close();
  } catch (err) {
    banner(`Not saved: ${err.message}`, true);
  } finally {
    button.disabled = false;
  }
};
// A backdrop click dismisses the dialog; dragging from an input never does.
let settingsBackdropDown = false;
$('#app-settings').addEventListener('pointerdown', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  settingsBackdropDown = event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
});
$('#app-settings').addEventListener('click', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  if (settingsBackdropDown && event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) event.currentTarget.close();
  settingsBackdropDown = false;
});

function renderReasoning(selected = null) {
  const choice = decodeModelChoice($('#edit-model').value);
  const options = reasoningOptions(choice.model_provider ?? state.modelProvider, choice.model ?? state.model);
  const select = $('#edit-reasoning');
  select.replaceChildren();
  for (const value of ['', ...options]) {
    const option = el('option', null, value ? (EFFORT_LABELS[value] ?? value) : 'Default');
    option.value = value; select.append(option);
  }
  select.value = options.includes(selected) ? selected : '';
  select.disabled = !options.length;
  $('#edit-reasoning-note').textContent = options.length ? 'Applies to this bot’s next model request. Lower is faster and cheaper; higher thinks longer.' : 'This model currently uses its provider’s default reasoning settings.';
}
$('#edit-model').addEventListener('change', () => renderReasoning());

let agentSettingsSnapshot = null;
let agentSettingsSaving = false;
function settingsSnapshot() {
  return JSON.stringify([...new FormData($('#settings-form')).entries()]);
}
function agentSettingsDirty() {
  return !$('#settings-form').hidden && agentSettingsSnapshot !== null && settingsSnapshot() !== agentSettingsSnapshot;
}
function updateSettingsChangeNote() {
  if (agentSettingsSaving) return;
  const dirty = agentSettingsDirty();
  $('#settings-change-note').textContent = dirty
    ? 'Unsaved changes — Save to use them for new requests.'
    : 'Changes take effect on the next turn after Save. A running turn keeps its original model.';
  $('#settings-change-note').classList.toggle('dirty', dirty);
}
$('#settings-form').addEventListener('input', updateSettingsChangeNote);
$('#settings-form').addEventListener('change', updateSettingsChangeNote);

function toggleSettings(agent) {
  if (!agent) return;
  jobs.close(false);
  const form = $('#settings-form');
  if (!form.hidden && agentSettingsDirty() && !confirm('Discard unsaved bot settings?')) return;
  // Clicking a different agent's face re-targets the open panel rather than closing it.
  const reopen = form.hidden || form.dataset.agentId !== agent.id;
  form.dataset.agentId = agent.id;
  $('#edit-lead').disabled = Boolean(agent.lead);
  $('#edit-lead').textContent = agent.lead ? 'Desk lead' : 'Make lead';
  $('#edit-lead-note').textContent = `One lead per desk · ${agent.desk || 'General'}`;
  form.elements.name.value = agent.name ?? '';
  form.elements.role.value = agent.role ?? '';
  form.elements.desk.value = agent.desk ?? '';
  fillDeskList();
  form.elements.prompt.value = agent.prompt ?? '';
  buildModelSelect($('#edit-model'), encodeModelChoice(agent.model, agent.model_provider));
  renderReasoning(agent.reasoning_effort);
  buildPicker($('#edit-avatar'), 'edit', { color: agent.color, shape: agent.shape, style: agent.style, hair: agent.hair });
  renderToolPicker('edit', agent.allowed_tools);
  form.hidden = !reopen;
  $('#open-settings').setAttribute('aria-expanded', String(!form.hidden));
  agentSettingsSnapshot = form.hidden ? null : settingsSnapshot();
  updateSettingsChangeNote();
  if (reopen) refreshModels();
  if (reopen && !toolCatalog) loadToolCatalog(agent);
}

// Per-agent tool scoping: no list means every tool; a list means only those.
let toolCatalog = null;
async function fetchToolCatalog() {
  try { toolCatalog = (await api('GET', '/api/tools')).tools; } catch {}
  return toolCatalog;
}
async function loadToolCatalog(agent) {
  if (!await fetchToolCatalog()) return;
  const form = $('#settings-form');
  if (form.hidden || form.dataset.agentId !== agent.id || agentSettingsDirty()) return;
  renderToolPicker('edit', agent.allowed_tools);
  agentSettingsSnapshot = settingsSnapshot();
}
/** What a new bot starts with: everything except tools that reach the host machine. */
const defaultTools = () => (toolCatalog ?? []).filter((tool) => tool.default).map((tool) => tool.name);
const chosenTools = (prefix) => $(`#${prefix}-tools-all`).checked ? null
  : [...$(`#${prefix}-tools-list`).querySelectorAll('input:checked')].map((box) => box.value);
/** "SandboxReadFile" reads as "Sandbox read file"; connected tools keep their own names. */
const toolLabel = (name) => /^[A-Z][A-Za-z]+$/.test(name)
  ? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ ([A-Z])(?=[a-z])/g, (_, c) => ` ${c.toLowerCase()}`).replace(/\bjson\b/i, 'JSON').replace(/\bPDF\b|\bPdf\b/, 'PDF').replace(/\bagent\b/, 'bot')
  : name;
function renderToolPicker(prefix, allowed) {
  const all = !Array.isArray(allowed);
  $(`#${prefix}-tools-all`).checked = all;
  const list = $(`#${prefix}-tools-list`);
  list.replaceChildren();
  const names = new Set((toolCatalog ?? []).map((tool) => tool.name));
  // Keep a saved tool whose integration is offline so a save never drops it silently.
  const tools = [...(toolCatalog ?? []), ...(all ? [] : allowed.filter((name) => !names.has(name)).map((name) => ({ name, description: 'Not currently connected.' })))];
  for (const tool of tools) {
    const label = document.createElement('label');
    label.title = [tool.name, tool.description].filter(Boolean).join(' — ');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'tool';
    box.value = tool.name;
    box.checked = all || tool.always_on || allowed.includes(tool.name);
    box.disabled = all || tool.always_on;
    label.append(box, ` ${toolLabel(tool.name)}${tool.default === false ? ' (this machine, outside the sandbox)' : ''}`);
    list.append(label);
  }
  if (!toolCatalog) list.textContent = 'Loading tools…';
}
for (const prefix of ['edit', 'create']) {
  $(`#${prefix}-tools-all`).addEventListener('change', (event) => {
    for (const box of $(`#${prefix}-tools-list`).querySelectorAll('input')) {
      const alwaysOn = toolCatalog?.find((tool) => tool.name === box.value)?.always_on;
      box.disabled = event.target.checked || Boolean(alwaysOn);
      if (event.target.checked) box.checked = true;
    }
  });
}

$('#edit-lead').onclick = async () => {
  const form = $('#settings-form');
  const agentId = form.dataset.agentId;
  const button = $('#edit-lead');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await api('POST', '/api/agents/lead', { agent_id: agentId });
    ++refreshSerial;
    await refresh();
    banner(`${agentById(agentId)?.name ?? 'Bot'} is now the desk lead`);
  } catch (error) { banner(error.message, true); }
  finally {
    const lead = Boolean(agentById(form.dataset.agentId)?.lead);
    button.disabled = lead;
    button.textContent = lead ? 'Desk lead' : 'Make lead';
  }
};

function closeSettings() {
  $('#settings-form').hidden = true;
  agentSettingsSnapshot = null;
  $('#open-settings').setAttribute('aria-expanded', 'false');
}

$('#settings-form').addEventListener('submit', async (formEvent) => {
  formEvent.preventDefault();
  if (agentSettingsSaving) return;
  const form = formEvent.target;
  const data = new FormData(form);
  const agentId = form.dataset.agentId;
  const submittedSnapshot = settingsSnapshot();
  const save = form.querySelector('button[type="submit"]');
  agentSettingsSaving = true;
  save.disabled = true;
  save.textContent = 'Saving…';
  $('#settings-change-note').textContent = 'Saving settings…';
  try {
    await api('PATCH', '/api/agents', {
      agent_id: agentId,
      name: data.get('name'),
      role: data.get('role'),
      desk: data.get('desk'),
      prompt: data.get('prompt'),
      ...decodeModelChoice(data.get('model')),
      reasoning_effort: data.get('reasoning_effort') || null,
      color: data.get('edit-color'),
      shape: data.get('edit-shape'),
      style: data.get('edit-style'),
      hair: data.get('edit-hair'),
      ...(toolCatalog ? { allowed_tools: chosenTools('edit') } : {}),
    });
    ++refreshSerial;
    if (form.dataset.agentId === agentId && settingsSnapshot() === submittedSnapshot) closeSettings();
    await refresh();
    banner('Settings saved');
  } catch (err) {
    banner(err.message, true);
    // A refused model still saves the other fields; show what is now stored.
    if (err.status === 400) { ++refreshSerial; await refresh().catch(() => {}); }
  } finally {
    agentSettingsSaving = false;
    save.disabled = false;
    save.textContent = 'Save';
    updateSettingsChangeNote();
  }
});

$('#settings-form').querySelector('[data-cancel]').onclick = closeSettings;

// ------------------------------------------------------------------ memory ---

const memoryPanel = $('#memory-panel');
let memoryDesk = null;
let memoryAgentId = null;
let memoryReadSerial = 0;
function openDeskMemory(desk) {
  const members = state.agents.filter((a) => (a.desk ?? '') === desk);
  if (!members.length) return;
  const selected = state.selectedKind === 'agent' ? agentById(state.selected) : null;
  memoryDesk = desk;
  memoryAgentId = selected && (selected.desk ?? '') === desk ? selected.id : members[0].id;
  showPane('chat');
  openMemory();
}
function mdToText(md) { return String(md).replace(/^#+\s*/gm, '').replace(/\*\*/g, ''); }
function factItem(f) {
  const li = el('li');
  // Tiers and scopes in words: a standing fact is always in mind, a note comes up when relevant.
  const tier = { profile: 'standing', log: 'note' }[f.tier] ?? f.tier;
  const scope = { project: 'project', user: 'about you', room: 'room' }[f.scope] ?? f.scope;
  li.append(el('span', 'chip', f.scope === 'agent' ? tier : `${scope} · ${tier}`));
  li.append(document.createTextNode(f.text));
  if (f.when) li.append(el('small', 'hint', ` · ${f.when.slice(0, 10)}`));
  return li;
}
async function openMemory() {
  const agent = agentById(memoryAgentId ?? state.selected);
  if (!agent) return;
  const serial = ++memoryReadSerial;
  memoryAgentId = agent.id;
  jobs.close(false);
  memoryPanel.hidden = false;
  $('#open-memory').setAttribute('aria-expanded', 'true');
  $('#memory-name').textContent = agent.name;
  const agentRow = $('#memory-agent-row');
  agentRow.hidden = memoryDesk === null;
  if (memoryDesk !== null) {
    $('#memory-desk-name').textContent = `${memoryDesk || 'General'} desk · bot`;
    const select = $('#memory-agent');
    select.replaceChildren(...state.agents.filter((a) => (a.desk ?? '') === memoryDesk).map((a) => {
      const option = el('option', null, a.name);
      option.value = a.id;
      return option;
    }));
    select.value = agent.id;
  }
  $('#memory-counts').textContent = '';
  $('#memory-results').replaceChildren();
  $('#memory-standing').replaceChildren(el('p', 'hint', 'Reading…'));
  try {
    const m = await api('GET', `/api/memory?agent_id=${encodeURIComponent(agent.id)}`);
    if (serial !== memoryReadSerial) return;
    const retention = m.retention?.counts ?? {};
    const pending = (retention.prepared ?? 0) + (retention.pending ?? 0) + (retention.processing ?? 0) + (retention.retryable ?? 0) + (retention.awaiting_confirmation ?? 0);
    // Plain words for the common case; queue detail only when something needs a person.
    const hindsight = String(m.engine ?? '').includes('hindsight');
    const notes = [`${m.counts.own} about itself · ${m.counts.project} about the project · ${m.counts.user} about you · stored ${hindsight ? 'in Hindsight' : 'on this machine'}.`];
    if (hindsight && pending > 0) notes.push(`${pending} still being saved.`);
    const stuck = (retention.blocked ?? 0) + (retention.reconciliation_required ?? 0);
    if (stuck > 0) notes.push(`${stuck} could not be saved; see Activity in App settings.`);
    if (retention.held > 0) notes.push(`${retention.held} waiting from an earlier memory setup; run \`better-bots memory release-held\` to save them.`);
    $('#memory-counts').textContent = notes.join(' ');
    const standing = $('#memory-standing');
    standing.replaceChildren();
    const titles = { agent: 'Itself and its work', user: 'The person it works for', project: 'The shared project' };
    for (const k of m.standing) { standing.append(el('h3', null, titles[k.scope] ?? k.scope)); standing.append(el('p', null, mdToText(k.text))); }
    if (m.standing.length === 0) standing.append(el('p', 'hint', hindsight
      ? 'No settled knowledge yet. It forms after the nightly consolidation.'
      : 'No settled knowledge yet. It builds up as this bot works; use Correct below to fix anything it has wrong.'));
    const list = $('#memory-results');
    for (const f of m.facts) list.append(factItem(f));
  } catch (err) {
    if (serial !== memoryReadSerial) return;
    $('#memory-standing').replaceChildren(el('p', 'hint', err.message));
  }
}
function closeMemory() {
  ++memoryReadSerial;
  memoryDesk = null;
  memoryAgentId = null;
  memoryPanel.hidden = true;
  $('#open-memory').setAttribute('aria-expanded', 'false');
}
$('#open-memory').onclick = () => {
  if (!memoryPanel.hidden) return closeMemory();
  memoryDesk = null;
  memoryAgentId = state.selected;
  openMemory();
};
memoryPanel.querySelector('[data-cancel]').onclick = closeMemory;
$('#memory-agent').addEventListener('change', (event) => {
  const agent = agentById(event.target.value);
  if (memoryDesk === null || !agent || (agent.desk ?? '') !== memoryDesk) return;
  memoryAgentId = agent.id;
  openMemory();
});
$('#memory-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = new FormData(e.target).get('q').trim();
  const agentId = memoryAgentId;
  if (!q || !agentId) return;
  const serial = memoryReadSerial;
  const list = $('#memory-results');
  list.replaceChildren(el('li', 'hint', 'Searching…'));
  try {
    const { results } = await api('POST', '/api/memory/search', { agent_id: agentId, query: q });
    if (serial !== memoryReadSerial) return;
    list.replaceChildren(...(results.length ? results.map(factItem) : [el('li', 'hint', 'Nothing matched.')]));
  } catch (err) { if (serial === memoryReadSerial) list.replaceChildren(el('li', 'hint', err.message)); }
});
$('#memory-correct').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const text = data.get('text').trim();
  const agentId = memoryAgentId;
  if (!text || !agentId) return;
  try {
    await api('POST', '/api/memory/correct', { agent_id: agentId, text, scope: data.get('scope') });
    e.target.reset();
    banner('Correction kept. It outranks the old fact on the next recall.');
    if (memoryAgentId === agentId) openMemory();
  } catch (err) { banner(err.message, true); }
});
$('#open-settings').onclick = () => toggleSettings(agentById(state.selected));

$('#theme-toggle').onclick = () => {
  const current = document.documentElement.dataset.themePref ?? 'system';
  applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
};
// Following the OS only means anything if it keeps following it.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if ((document.documentElement.dataset.themePref ?? 'system') === 'system') applyTheme('system');
});
applyTheme(document.documentElement.dataset.themePref ?? 'system');

buildPicker($('#create-avatar'), 'create');
renderModelPickers();
for (const prefix of ['create', 'edit']) $(`#${prefix}-model-refresh`).onclick = () => refreshModels(true);

$('#room-form').addEventListener('submit', async (formEvent) => {
  formEvent.preventDefault();
  const purpose = new FormData(formEvent.target).get('purpose').trim();
  const members = [...$('#room-members').querySelectorAll('input:checked')].map((i) => i.value);
  if (!members.length) return banner('Choose at least one member for the room.', true);

  formEvent.target.hidden = true;
  try {
    const memory = new FormData(formEvent.target).get('memory') || 'members';
    const { room } = await api('POST', '/api/rooms', { purpose, member_ids: members, memory });
    formEvent.target.reset();
    await refresh();
    select('room', room.id);
    banner(`Room created. Say something to it below.`);
  } catch (err) {
    banner(err.message, true);
  }
});

$('#clear-activity').onclick = () => $('#activity').replaceChildren();

for (const tab of document.querySelectorAll('.tabs button')) tab.onclick = () => showPane(tab.dataset.pane);
showPane('agents');

// ------------------------------------------------------------- rails fold ---
// Either side rail folds to a strip, and the activity feed folds on its own.
// Remembered per browser, so the layout you set is the layout you get back.
const layout = (() => { try { return JSON.parse(localStorage.getItem('better-bots-layout') ?? '{}'); } catch { return {}; } })();
function saveLayout() { try { localStorage.setItem('better-bots-layout', JSON.stringify(layout)); } catch { /* private mode */ } }
function applyRails() {
  for (const side of ['left', 'right']) {
    const collapsed = layout[side] === 'collapsed';
    const rail = $(`.rail-${side}`);
    rail.classList.toggle('collapsed', collapsed);
    $('.app').dataset[side] = collapsed ? 'collapsed' : 'open';
    const toggle = rail.querySelector('.rail-toggle');
    toggle.textContent = side === 'left' ? (collapsed ? '››' : '‹‹') : (collapsed ? '‹‹' : '››');
    toggle.title = collapsed ? 'Expand' : 'Collapse';
  }
  const feedCollapsed = layout.activity === 'collapsed';
  $('#activity').classList.toggle('collapsed', feedCollapsed);
  $('#toggle-activity').textContent = feedCollapsed ? '▸' : '▾';
  $('#toggle-activity').setAttribute('aria-expanded', String(!feedCollapsed));
  $('#toggle-activity').title = feedCollapsed ? 'Expand the feed' : 'Collapse the feed';
}
for (const toggle of document.querySelectorAll('.rail-toggle')) {
  toggle.onclick = () => { const side = toggle.dataset.rail; layout[side] = layout[side] === 'collapsed' ? 'open' : 'collapsed'; saveLayout(); applyRails(); };
}
$('#toggle-activity').onclick = () => { layout.activity = layout.activity === 'collapsed' ? 'open' : 'collapsed'; saveLayout(); applyRails(); };
applyRails();

// -------------------------------------------------------------- shortcuts ---
// "/" jumps to the message box; Alt+↑/↓ steps through the roster. Neither fires
// while you are typing (Option+arrows edit text there) or inside a dialog.
{
  const typing = (target) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || typing(event.target) || document.querySelector('dialog[open]')) return;
    if (event.key === '/' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const input = $('#input');
      if (input.disabled || input.offsetParent === null) return;
      event.preventDefault();
      input.focus();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const rows = [...document.querySelectorAll('#pinned-list button.agent, #agent-list button.agent, #room-list button.agent')].filter((row) => row.offsetParent !== null);
      if (!rows.length) return;
      event.preventDefault();
      const at = rows.findIndex((row) => row.getAttribute('aria-current') === 'true');
      const next = rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
      next.click();
      next.focus({ preventScroll: false });
    }
  });
  $('#input').title = 'Enter sends · Shift+Enter adds a line · press / anywhere to come back here';
}

// ----------------------------------------------------------- jump to latest ---
// Scrolled up (or paged back) to read? One click returns to the newest message.
// It watches the transcript itself, so the follow-the-bottom logic is untouched.
{
  const view = $('#transcript');
  const content = $('#transcript-content');
  const jump = $('#jump-latest');
  let lastHeight = content.scrollHeight;
  const sync = ({ fresh = false } = {}) => {
    const away = view.dataset.stick === '0' && (Boolean(transcriptPage.before) || view.scrollHeight - view.scrollTop - view.clientHeight >= 48);
    if (fresh && away) jump.dataset.fresh = '1';
    if (!away) delete jump.dataset.fresh;
    jump.textContent = jump.dataset.fresh ? '↓ New messages' : '↓ Jump to latest';
    jump.hidden = !away || view.hidden;
  };
  view.addEventListener('scroll', () => sync(), { passive: true });
  new ResizeObserver(() => {
    const grew = content.scrollHeight > lastHeight + 4;
    lastHeight = content.scrollHeight;
    sync({ fresh: grew && !transcriptPage.before });
  }).observe(content);
  jump.onclick = () => {
    view.dataset.stick = '1';
    jump.hidden = true; delete jump.dataset.fresh;
    if (transcriptPage.before) {
      // Reading an older page: the newest messages are on the first page.
      transcriptPage.before = null;
      loadTranscript().catch((error) => banner(error.message, true));
    } else view.scrollTo({ top: view.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
}

// --------------------------------------------------------------------- live --

await loginFromLink();
await retryRead(async () => {
  try { await refresh(); }
  catch (err) {
    if (err.status !== 401) throw err;
    await unlock();
    await refresh();
  }
}, { onError: () => banner('Connecting to your bots… Retrying automatically.', true) });

// Discovery is independent of boot, and the server's one-hour cache bounds upstream calls.
modelsReady = true;
refreshModels();
window.addEventListener('focus', () => { if (!document.hidden) refreshModels(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshModels(); });
setInterval(() => { if (!document.hidden) refreshModels(); }, 60000);

// Prime the feed with what already happened, oldest first, so the panel is not
// blank on a store that has history.
try {
  const { events } = await api('GET', '/api/activity?limit=80');
  for (const event of events) pushActivity(event);
} catch { /* an empty feed is not worth a failure */ }

const stream = new EventSource('/api/events');
let settle;
let reasoningRefresh = null;
function pushReasoning(event) {
  if (state.selectedKind !== 'agent' || state.selected !== event.agent_id) return;
  const block = [...document.querySelectorAll('.reasoning-block')].find(node => node.dataset.reasoningKey === event.stream_id);
  const full = block?.querySelector('.reasoning-text');
  if (!full || full.textContent.length < event.start) {
    reasoningRefresh ??= loadTranscript().catch(() => {}).finally(() => { reasoningRefresh = null; });
    return;
  }
  const length = full.textContent.length;
  if (event.start + event.text.length <= length) return;
  full.textContent += event.text.slice(length - event.start);
  const preview = block.querySelector('.reasoning-preview');
  if (preview) preview.textContent = full.textContent.trimEnd();
  requestAnimationFrame(() => { if (preview?.isConnected) preview.scrollTop = preview.scrollHeight; followTranscript(); });
}
stream.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (event.type === 'reasoning.delta') { pushReasoning(event); return; }
  pushActivity(event);
  // The host is the source of truth; re-read it shortly after anything happens.
  clearTimeout(settle);
  settle = setTimeout(async () => {
    try { await refresh(); await loadTranscript(); }
    catch (error) { banner(`Could not refresh conversation: ${error.message}`, true); }
  }, 180);
};
// EventSource reconnects by itself; a restart is a blip, not a loss. Only say
// something if it is still down after a few seconds.
let streamDown;
stream.onerror = () => {
  clearTimeout(streamDown);
  // A non-200 reply (an expired session, say) closes the stream for good; the
  // browser will not retry it, so waiting for it to come back is pointless.
  if (stream.readyState === EventSource.CLOSED) {
    banner('Live updates stopped — your session may have expired. Reload the page to reconnect.', true);
    return;
  }
  streamDown = setTimeout(() => {
    if (stream.readyState !== EventSource.OPEN) banner('Lost the activity stream — is the server still running?', true);
  }, 6000);
};
let reconnecting = null;
stream.onopen = () => {
  clearTimeout(streamDown);
  if (reconnecting) return;
  reconnecting = retryRead(async () => {
    await refresh();
    await loadTranscript();
    const { events } = await api('GET', '/api/activity?limit=80');
    for (const event of events) pushActivity(event);
  }, { onError: () => banner('Reconnecting and refreshing your conversation…', true) })
    .then(() => { $('#banner').hidden = true; }).finally(() => { reconnecting = null; });
};

if (state.agents.length) select('agent', state.agents[0].id);

function fmtTokens(n) {
  return n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
