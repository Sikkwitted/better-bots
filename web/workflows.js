import { CRON_PRESETS, describeCron, describeSchedule, formatWhen, routineState, nextRunText, pauseWarning, removeWarning } from './workflow-copy.js';

/** Desk workflows use host-owned state; hiding never changes execution. */
export function createWorkflowPanel({ dialog, api, getAgents, onVisibility }) {
  const doc = dialog.ownerDocument;
  let desks = [], reveal = false, opener, renderVersion = 0;
  const node = (tag, text, cls) => { const n = doc.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
  const status = node('p', '', 'wf-status'); status.setAttribute('role', 'status');
  const list = node('div', '', 'wf-list');
  // One action button: disabled while it runs, errors reported where the person is looking.
  const button = (text, action, { cls = 'ghost', key = null, title = null, report = status } = {}) => {
    const n = node('button', text, cls); n.type = 'button';
    if (key) n.dataset.key = key;
    if (title) n.title = title;
    n.onclick = async () => { n.disabled = true; try { await action(); } catch (e) { report.textContent = e.message; } finally { n.disabled = false; } };
    return n;
  };
  const showHidden = button('Show hidden', async () => { reveal = !reveal; showHidden.textContent = reveal ? 'Hide hidden' : 'Show hidden'; await render(); }, { key: 'toggle-hidden' });
  const closeButton = button('Close', () => dialog.close(), { cls: 'primary', key: 'close' });
  const header = node('header', '', 'wf-header');
  const titleBox = node('div');
  const title = node('h2', 'Desks'); title.id = 'workflow-title';
  titleBox.append(title, node('p', 'A desk is a set of bots and the routines they run on a schedule. Pausing one stops its automatic work; you can still message its bots directly.', 'hint'));
  const headerActions = node('div', '', 'wf-header-actions'); headerActions.append(showHidden, closeButton);
  header.append(titleBox, headerActions);
  dialog.setAttribute('aria-labelledby', 'workflow-title');
  dialog.append(header, status, list);
  dialog.addEventListener('close', () => { renderVersion++; opener?.focus(); });
  // A labelled control. `hint` is explanatory text under it.
  const field = (form, title, type = 'input', hint = null) => {
    const label = node('label', '', 'wf-field'); label.append(node('span', title, 'wf-field-label'));
    const input = node(type); label.append(input);
    if (hint) label.append(node('span', hint, 'hint'));
    form.append(label); return input;
  };
  function routineForm(desk, card, anchor) {
    card.querySelector('.wf-form')?.remove();
    const form = node('form', '', 'wf-form');
    form.append(node('h4', 'New routine'));
    const failure = node('p', '', 'wf-error'); failure.setAttribute('role', 'alert');
    const name = field(form, 'Name', 'input'); name.required = true; name.placeholder = 'Morning sweep';
    const agent = field(form, 'Which bot runs it', 'select');
    for (const a of getAgents().filter(a => desk.agent_ids.includes(a.id))) { const o = node('option', a.name); o.value = a.id; agent.append(o); }
    const prompt = field(form, 'What should it do?', 'textarea', 'Written like a message to the bot. It gets this each time the routine runs.');
    prompt.required = true; prompt.rows = 3;
    const kind = field(form, 'How often', 'select');
    for (const [value, label] of [['interval', 'Every so often (minutes or hours)'], ['cron', 'On a calendar schedule (like weekdays at 9)'], ['once', 'Just once']]) { const o = node('option', label); o.value = value; kind.append(o); }
    // Every so often
    const every = node('div', '', 'wf-inline'); every.append(node('span', 'Run every'));
    const amount = node('input'); amount.type = 'number'; amount.min = '1'; amount.value = '1'; amount.setAttribute('aria-label', 'Number');
    const unit = node('select'); unit.setAttribute('aria-label', 'Unit');
    for (const [value, label] of [['60000', 'minutes'], ['3600000', 'hours'], ['86400000', 'days']]) { const o = node('option', label); o.value = value; unit.append(o); }
    unit.value = '3600000';
    every.append(amount, unit); form.append(every);
    // Calendar schedule
    const calendar = node('div'); form.append(calendar);
    const preset = field(calendar, 'Schedule', 'select');
    for (const item of CRON_PRESETS) { const o = node('option', item.label); o.value = item.value; preset.append(o); }
    const cron = field(calendar, 'Cron expression', 'input', 'Five fields: minute, hour, day of month, month, day of week.'); cron.placeholder = '0 9 * * 1-5'; cron.value = CRON_PRESETS[0].value;
    const zone = field(calendar, 'Time zone', 'input'); zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const meaning = node('p', '', 'wf-meaning'); calendar.append(meaning);
    // First run, for "every so often" and "once"
    const start = field(form, 'First run', 'select');
    for (const [value, label] of [['now', 'Right after I save'], ['later', 'At a set time']]) { const o = node('option', label); o.value = value; start.append(o); }
    const when = field(form, 'Start at (your local time)', 'input'); when.type = 'datetime-local';
    const update = () => {
      const isCron = kind.value === 'cron';
      every.hidden = kind.value !== 'interval'; calendar.hidden = !isCron;
      start.parentElement.hidden = isCron;
      when.parentElement.hidden = isCron || start.value !== 'later';
      when.required = !isCron && start.value === 'later';
      cron.parentElement.hidden = preset.value !== 'custom';
      meaning.textContent = isCron ? describeCron(preset.value === 'custom' ? cron.value : preset.value) : '';
    };
    preset.onchange = () => { if (preset.value !== 'custom') cron.value = preset.value; update(); };
    for (const control of [kind, start, cron]) { control.onchange = update; control.oninput = update; }
    update();
    const save = node('button', 'Add routine', 'primary'); save.type = 'submit';
    const actions = node('div', '', 'wf-actions'); actions.append(save, button('Cancel', () => form.remove(), { report: failure }));
    form.append(failure, actions);
    form.onsubmit = async e => {
      e.preventDefault(); save.disabled = true; failure.textContent = '';
      try {
        const payload = { agent_id: agent.value, name: name.value.trim(), text: prompt.value.trim() };
        if (kind.value === 'cron') { payload.cron = (preset.value === 'custom' ? cron.value : preset.value).trim(); payload.timezone = zone.value.trim() || 'UTC'; }
        else {
          if (start.value === 'later') {
            const time = Date.parse(when.value);
            if (!Number.isFinite(time) || time <= Date.now()) throw Error('Pick a start time in the future, or choose “Right after I save”.');
            payload.due_at = new Date(time).toISOString();
          }
          if (kind.value === 'interval') {
            const minutes = Number(amount.value) * Number(unit.value) / 60000;
            if (!Number.isFinite(minutes) || minutes < 1) throw Error('Choose an interval of at least one minute.');
            payload.every_ms = Math.round(minutes * 60000);
          }
        }
        await api('POST', '/api/automations', payload);
        status.textContent = `Added “${payload.name}”.`;
        await render();
      } catch (error) { failure.textContent = error.message; save.disabled = false; }
    };
    card.insertBefore(form, anchor ?? null); name.focus();
  }
  function routineRow(routine, desk) {
    const state = routineState(routine, desk.enabled);
    const row = node('section', '', `wf-routine wf-${state.key}`);
    const top = node('div', '', 'wf-routine-top');
    top.append(node('h4', routine.name), node('span', state.label, `wf-chip wf-chip-${state.key}`));
    row.append(top, node('p', `${describeSchedule(routine)}${routine.cron && routine.timezone ? ` · ${routine.timezone}` : ''}`, 'wf-schedule'));
    const next = nextRunText(routine, desk.enabled);
    if (next) row.append(node('p', next, 'hint'));
    row.append(node('p', routine.text, 'wf-routine-text'));
    const actions = node('div', '', 'wf-actions');
    const paused = routine.enabled === false;
    actions.append(
      button(paused ? 'Resume' : 'Pause', async () => { await api('PATCH', '/api/automations', { automation_id: routine.id, enabled: paused }); await render(); }, { key: `${desk.name}|${routine.name}|toggle` }),
      button('Remove', async () => { if (!confirm(removeWarning(routine.name))) return; await api('DELETE', '/api/automations', { automation_id: routine.id }); await render(); }, { cls: 'ghost deny', key: `${desk.name}|${routine.name}|remove` }),
    );
    row.append(actions);
    return row;
  }
  async function render() {
    const version = ++renderVersion;
    status.textContent = list.childElementCount ? status.textContent : 'Loading desks…';
    const [data, jobs] = await Promise.all([api('GET', '/api/desks'), api('GET', '/api/automations')]);
    if (!dialog.open || version !== renderVersion) return;
    // A refresh must not throw the person back to the top or lose their place.
    const scroll = dialog.scrollTop;
    const focusKey = doc.activeElement?.dataset?.key ?? null;
    desks = data.desks;
    await onVisibility(desks); list.replaceChildren();
    const shown = desks.filter(d => reveal || !d.hidden);
    if (!desks.length) list.append(node('p', 'No bots yet. Create a bot and give it a desk, and the desk will appear here.', 'wf-empty'));
    else if (!shown.length) list.append(node('p', 'Every desk is hidden. Choose “Show hidden” to see them.', 'wf-empty'));
    for (const desk of shown) {
      const bots = getAgents().filter(a => desk.agent_ids.includes(a.id));
      const card = node('article', '', `workflow-card${desk.enabled ? '' : ' wf-off'}`);
      const head = node('div', '', 'wf-card-head');
      const names = node('div');
      names.append(node('h3', desk.name || 'General'), node('p', bots.map(a => a.name).join(', ') || 'No bots', 'hint'));
      const chips = node('div', '', 'wf-chips');
      chips.append(node('span', desk.enabled ? 'Running' : 'Paused', `wf-chip wf-chip-${desk.enabled ? 'active' : 'paused'}`));
      if (desk.hidden) chips.append(node('span', 'Hidden', 'wf-chip wf-chip-held'));
      head.append(names, chips); card.append(head);
      if (desk.goal) card.append(node('p', desk.goal, 'wf-goal'));
      const change = async patch => { await api('PATCH', '/api/desks', { name: desk.name, ...patch }); await render(); };
      const controls = node('div', '', 'wf-actions');
      controls.append(
        button(desk.enabled ? 'Pause desk' : 'Resume desk', async () => {
          if (desk.enabled && !confirm(pauseWarning(desk.name, bots.map(a => a.name)))) return;
          await change({ enabled: !desk.enabled });
        }, { cls: desk.enabled ? 'ghost' : 'primary', key: `${desk.name}|pause`, title: desk.enabled ? 'Stops automatic work and routines for these bots' : 'Lets these bots’ routines run again' }),
        button(desk.hidden ? 'Show in list' : 'Hide from list', () => change({ hidden: !desk.hidden }), { key: `${desk.name}|hide`, title: 'Hiding only removes it from the bot list. It keeps running.' }),
      );
      card.append(controls);
      const routines = jobs.automations.filter(j => desk.agent_ids.includes(j.agent_id));
      card.append(node('h4', `Routines${routines.length ? ` (${routines.length})` : ''}`, 'wf-section-title'));
      for (const routine of routines) card.append(routineRow(routine, desk));
      if (!routines.length) card.append(node('p', 'No routines yet. A routine sends a bot the same instructions on a schedule.', 'hint'));
      const add = button('Add a routine', () => routineForm(desk, card, null), { cls: 'ghost', key: `${desk.name}|add` });
      card.append(add);
      list.append(card);
    }
    status.textContent = `${desks.filter(d => !d.hidden).length} desk${desks.filter(d => !d.hidden).length === 1 ? '' : 's'}${reveal ? ' · hidden ones shown' : desks.some(d => d.hidden) ? ` · ${desks.filter(d => d.hidden).length} hidden` : ''}`;
    dialog.scrollTop = scroll;
    if (focusKey) [...dialog.querySelectorAll('[data-key]')].find(n => n.dataset.key === focusKey)?.focus();
  }
  return { update(data) { desks = data; }, async open(trigger) { opener = trigger; if (!dialog.open) dialog.showModal(); try { await render(); } catch (e) { status.textContent = e.message; } }, isDeskHidden: name => desks.some(d => d.name === (name || '') && d.hidden) };
}
