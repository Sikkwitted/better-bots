// Jobs are scheduled prompts in the host, never OS cron or a run-now action.
export function jobPayload(values, agents, now = Date.now()) {
  if (!values.consent) throw new Error('Confirm consent to potentially paid automatic work.');
  if (!agents.some((agent) => agent.id === values.agent_id)) throw new Error('Choose an available bot.');
  if (typeof values.text !== 'string' || !values.text.trim()) throw new Error('Enter a nonblank prompt.');
  if (typeof values.name !== 'string' || !values.name.trim()) throw new Error('Enter a routine name.');
  const payload = { agent_id: values.agent_id, name: values.name.trim(), text: values.text.trim() };
  if (values.schedule === 'cron') {
    const cron = values.cron.trim();
    if (cron.split(/\s+/).length !== 5) throw new Error('Cron requires five fields.');
    const timezone = values.timezone.trim();
    try {
      if (!timezone) throw new Error();
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format(now);
    } catch { throw new Error('Enter a valid time zone, such as UTC or America/Chicago.'); }
    // The host validates cron ranges/names and computes the next matching minute.
    return { ...payload, cron, timezone };
  }
  if (!['once', 'interval'].includes(values.schedule)) throw new Error('Choose a schedule type.');
  const start = values.due_at;
  const due = typeof start === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(start) ? Date.parse(`${start}:00Z`) : NaN;
  if (!Number.isFinite(due) || due <= now || new Date(due).toISOString().slice(0, 16) !== start) {
    throw new Error('Choose an explicit, valid future start date and time in UTC.');
  }
  payload.due_at = new Date(due).toISOString();
  if (values.schedule === 'interval') {
    const every = Number(values.minutes) * 60_000;
    if (!Number.isSafeInteger(every) || every < 60_000) throw new Error('The interval must be at least one minute.');
    payload.every_ms = every;
  }
  return payload;
}

function nextRun(job) {
  if (job.enabled === false) return 'Disabled';
  if (job.fired) return 'None — one-shot already fired';
  if (!Number.isFinite(Date.parse(job.due_at))) return 'Unavailable — invalid start';
  const timezone = job.timezone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(job.due_at)) + ` (${timezone})`;
  } catch { return String(job.due_at); }
}

export function createJobsPanel({ panel, api, getAgents, onVisibilityChange = () => {}, confirm = (text) => window.confirm(text), now = Date.now }) {
  const doc = panel.ownerDocument;
  const $ = (id) => panel.querySelector(`#${id}`);
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const form = $('jobs-form');
  const fields = form.elements;
  const list = $('jobs-list');
  let agents = getAgents();
  let items = [];
  let cancellations = [];
  let filter = null;
  let opener = null;
  let revision = 0;
  let saving = false;
  let loaded = false;
  let agentOptions = '';
  const cards = new Map();
  const removing = new Set();

  function error(id, message = '') {
    $(id).textContent = message;
    $(id).hidden = !message;
  }
  function status(message) {
    const stopped = cancellations.reduce((n, c) => n + c.cancelled_runs.length, 0);
    const stopping = cancellations.reduce((n, c) => n + c.stopping_runs.length, 0);
    const uncertain = cancellations.reduce((n, c) => n + c.reconciliation_required.length, 0);
    $('jobs-status').textContent = message + (cancellations.length ? ` Cancellation: ${stopped} runs cancelled; ${stopping} still stopping; ${uncertain} actions need reconciliation.` : '');
  }
  function renderAgents() {
    const select = fields.agent_id;
    const signature = JSON.stringify(agents.map((a) => [a.id, a.name]));
    if (signature === agentOptions) return;
    agentOptions = signature;
    const chosen = select.value;
    const options = [el('option', null, 'Choose a bot')];
    options[0].value = '';
    for (const agent of agents) {
      const option = el('option', null, agent.name || agent.id);
      option.value = agent.id;
      options.push(option);
    }
    if (chosen && !agents.some((a) => a.id === chosen)) {
      const option = el('option', null, `Unavailable bot (${chosen})`);
      option.value = chosen;
      option.disabled = true;
      options.push(option);
    }
    select.replaceChildren(...options);
    select.value = chosen;
  }
  function scheduleFields() {
    const cron = fields.schedule.value === 'cron';
    const interval = fields.schedule.value === 'interval';
    $('jobs-once-fields').hidden = cron;
    $('jobs-interval-fields').hidden = !interval;
    $('jobs-cron-fields').hidden = !cron;
    fields.due_at.disabled = saving || cron;
    fields.minutes.disabled = saving || !interval;
    fields.cron.disabled = saving || !cron;
    fields.timezone.disabled = saving || !cron;
  }
  function setSaving(value) {
    saving = value;
    for (const control of form.querySelectorAll('input, select, textarea, button')) control.disabled = value;
    $('jobs-save').disabled = value;
    $('jobs-cancel').disabled = value;
    $('jobs-save').textContent = value ? 'Saving…' : 'Create routine';
    form.setAttribute('aria-busy', String(value));
    $('jobs-new').disabled = value || !agents.length;
    scheduleFields();
  }
  function render() {
    renderAgents();
    $('jobs-heading').textContent = filter ? `Routines · ${agents.find((a) => a.id === filter)?.name || `Unavailable bot (${filter})`}` : 'All routines';
    $('jobs-new').disabled = saving || !agents.length;
    const focused = doc.activeElement;
    const hadListFocus = list.contains(focused);
    const visible = items.filter((job) => !filter || job.agent_id === filter);
    const nodes = visible.map((job) => {
      const agent = agents.find((a) => a.id === job.agent_id);
      let card = cards.get(job.id);
      if (!card) {
        const node = el('article', 'job-card');
        const remove = el('button', 'ghost deny', 'Remove');
        remove.type = 'button';
        card = { node, remove };
        cards.set(job.id, card);
      }
      const { node, remove } = card;
      remove.disabled = removing.has(job.id);
      remove.textContent = remove.disabled ? 'Removing…' : 'Remove';
      remove.setAttribute('aria-label', `Remove ${job.name || 'unnamed routine'}`);
      remove.onclick = () => removeJob(job, remove);
      const head = el('div', 'job-card-header');
      head.append(el('h3', null, job.name || 'Unnamed routine'));
      const states = el('div');
      if (!agent) states.append(el('span', 'job-state is-unavailable', 'Unavailable bot'));
      states.append(el('span', `job-state${job.fired ? ' is-fired' : ''}`, job.fired ? 'Fired one-shot' : 'Scheduled'));
      head.append(states);
      const meta = el('dl', 'job-meta');
      const entries = [
        ['Schedule', job.cron ? `Cron · ${job.cron}` : job.every_ms ? `Interval · every ${job.every_ms / 60_000} minutes` : 'Once'],
        ['Time zone', job.timezone || 'UTC'],
        ['Next run', nextRun(job)],
        ['Dispatch count', String(job.fires ?? 0)],
      ];
      for (const [label, value] of entries) meta.append(el('dt', null, label), el('dd', null, value));
      const actions = el('div', 'job-actions');
      actions.append(remove);
      node.replaceChildren(head, el('p', 'job-agent', agent?.name || `Unavailable bot (${job.agent_id})`), el('p', 'job-prompt', job.text ?? ''), meta, actions);
      return node;
    });
    list.replaceChildren(...(nodes.length ? nodes : [el('p', 'jobs-empty', loaded ? (filter ? 'No routines for this bot.' : 'No routines yet.') : 'Loading routines…')]));
    for (const id of cards.keys()) if (!items.some((job) => job.id === id)) cards.delete(id);
    // Reusing the remove control preserves its identity; reparenting may still
    // blur it in browsers. Never move focus away from a draft on refresh.
    if (hadListFocus && !panel.hidden) (list.contains(focused) ? focused : $('jobs-new').disabled ? $('jobs-close') : $('jobs-new')).focus();
  }

  async function refresh({ created = false, removed = false } = {}) {
    const request = ++revision;
    const notice = created ? 'Routine created. ' : removed ? 'Routine cancelled. ' : '';
    status(`${notice}Loading routines…`);
    error('jobs-error');
    list.setAttribute('aria-busy', 'true');
    try {
      const data = await api('GET', '/api/automations');
      if (request !== revision) return;
      if (!Array.isArray(data.automations)) throw new Error('Invalid routines response. Try Refresh.');
      items = data.automations;
      cancellations = data.automation_cancellations ?? [];
      agents = getAgents();
      loaded = true;
      render();
      status(`${notice}${items.filter((job) => !filter || job.agent_id === filter).length} routines`);
    } catch (err) {
      if (request === revision) { error('jobs-error', `Could not load routines: ${err.message}. Use Refresh to retry.`); status(`${notice}Routines could not be refreshed.`); }
    } finally {
      if (request === revision) list.setAttribute('aria-busy', 'false');
    }
  }

  // A state request captures revision before its GET. Reject snapshots started
  // before a more recent Jobs GET, mutation, close, or accepted state snapshot.
  function update(data, expectedRevision = revision) {
    if (expectedRevision !== revision) return false;
    revision += 1;
    agents = data.agents ?? getAgents();
    items = data.automations ?? [];
    cancellations = data.automation_cancellations ?? [];
    loaded = true;
    list.setAttribute('aria-busy', 'false');
    error('jobs-error');
    render();
    status(`${items.filter((job) => !filter || job.agent_id === filter).length} routines`);
    return true;
  }

  async function removeJob(job, button) {
    if (removing.has(job.id)) return;
    if (!confirm(`Remove “${job.name || 'Unnamed routine'}”? This stops future scheduling and cancels queued and active work from this routine. Actions already performed are preserved.`)) return;
    removing.add(job.id);
    revision += 1;
    list.setAttribute('aria-busy', 'false');
    status('Removing routine…');
    const restoreFocus = doc.activeElement === button;
    button.disabled = true;
    button.textContent = 'Removing…';
    error('jobs-error');
    try {
      const result = await api('DELETE', '/api/automations', { automation_id: job.id });
      if (result?.cancellation) cancellations = [...cancellations.filter((c) => c.automation_id !== job.id), result.cancellation];
      revision += 1;
      list.setAttribute('aria-busy', 'false');
      items = items.filter((item) => item.id !== job.id);
      render();
      // Every completed mutation reconciles independently: overlapping DELETE
      // acknowledgements can invalidate both the SSE snapshot and its retry.
      await refresh({ removed: true });
    } catch (err) {
      error('jobs-error', `Could not remove routine: ${err.message}`);
      status('Routine could not be removed.');
    } finally {
      removing.delete(job.id);
      button.disabled = false;
      button.textContent = 'Remove';
      if (restoreFocus && !panel.hidden && doc.activeElement === doc.body) {
        (list.contains(button) ? button : $('jobs-new').disabled ? $('jobs-close') : $('jobs-new')).focus();
      }
    }
  }

  function close(returnFocus = true) {
    if (panel.hidden) return;
    revision += 1;
    panel.hidden = true;
    onVisibilityChange(false, filter, returnFocus);
    if (returnFocus && opener?.isConnected && !opener.disabled) opener.focus();
  }
  async function open(agentId = null, trigger = null) {
    filter = agentId;
    opener = trigger;
    agents = getAgents();
    panel.hidden = false;
    onVisibilityChange(true, filter);
    render();
    $('jobs-close').focus();
    return refresh();
  }
  $('jobs-new').onclick = () => {
    if (saving || !agents.length) return;
    if (form.hidden) {
      form.hidden = false;
      fields.agent_id.value = agents.some((a) => a.id === filter) ? filter : '';
      error('jobs-form-error');
    }
    $('jobs-new').setAttribute('aria-expanded', 'true');
    fields.name.focus();
  };
  $('jobs-cancel').onclick = () => {
    if (saving) return;
    form.reset();
    form.hidden = true;
    scheduleFields();
    error('jobs-form-error');
    $('jobs-new').setAttribute('aria-expanded', 'false');
    $('jobs-new').focus();
  };
  fields.schedule.onchange = scheduleFields;
  $('jobs-refresh').onclick = refresh;
  $('jobs-close').onclick = () => close();
  panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    error('jobs-form-error');
    let payload;
    try {
      const values = Object.fromEntries(['agent_id', 'name', 'text', 'schedule', 'due_at', 'minutes', 'cron', 'timezone'].map((key) => [key, fields[key].value]));
      payload = jobPayload({ ...values, consent: fields.consent.checked }, getAgents(), now());
    } catch (err) { error('jobs-form-error', err.message); return; }
    if (!confirm(`Create “${payload.name}” for ${getAgents().find((a) => a.id === payload.agent_id).name}? This authorizes automatic bot work and may incur paid model/tool costs.${payload.cron ? ' The next matching cron minute may be soon.' : ` First run: ${payload.due_at} (UTC).`}`)) return;
    // A confirmation can remain open past the chosen start. Recheck before POST.
    if (payload.due_at && Date.parse(payload.due_at) <= now()) { error('jobs-form-error', 'The start is no longer in the future. Choose a later time.'); return; }
    revision += 1;
    list.setAttribute('aria-busy', 'false');
    status('Saving routine…');
    const focused = doc.activeElement;
    setSaving(true);
    try {
      await api('POST', '/api/automations', payload);
      revision += 1;
      list.setAttribute('aria-busy', 'false');
      // The acknowledgement confirms creation, not current scheduling: SSE may
      // have exposed the job and a removal may already have completed.
      const returnFocus = !panel.hidden && (form.contains(doc.activeElement) || doc.activeElement === $('jobs-save') || doc.activeElement === doc.body);
      form.reset();
      form.hidden = true;
      $('jobs-new').setAttribute('aria-expanded', 'false');
      setSaving(false);
      render();
      if (returnFocus) ($('jobs-new').disabled ? $('jobs-close') : $('jobs-new')).focus();
    } catch (err) {
      error('jobs-form-error', `Could not create routine: ${err.message}. Review before retrying.`);
      status('Creation was not confirmed. Refresh routines before retrying to avoid duplicates.');
      return;
    } finally {
      setSaving(false);
      if (!panel.hidden && !form.hidden && doc.activeElement === doc.body && form.contains(focused)) focused.focus();
    }
    // Reconcile from a guarded, authoritative read, outside the POST failure and
    // saving lifecycle. A read failure must not invite a duplicate submission.
    await refresh({ created: true });
  });
  scheduleFields();
  return { open, close, refresh, update, get revision() { return revision; }, get items() { return items; } };
}
