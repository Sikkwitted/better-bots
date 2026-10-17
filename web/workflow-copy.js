// Plain-English descriptions of routines for the Workflows panel: what a schedule
// means, when it runs next, and what state it is in. Pure functions, no DOM.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WHOLE = /^\d+$/;

const clock = (hour, minute) => `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;

/** Cron presets offered in the routine form; `custom` lets a person type their own. */
export const CRON_PRESETS = [
  { value: '0 9 * * 1-5', label: 'Every weekday at 9:00 AM' },
  { value: '0 9 * * *', label: 'Every day at 9:00 AM' },
  { value: '0 * * * *', label: 'Every hour, on the hour' },
  { value: '0 9 * * 1', label: 'Every Monday at 9:00 AM' },
  { value: 'custom', label: 'Something else…' },
];

/** "0 9 * * 1-5" -> "Weekdays at 9:00 AM". Anything unusual is shown as given, honestly. */
export function describeCron(expression) {
  const [minute, hour, day, month, weekday] = String(expression ?? '').trim().split(/\s+/);
  if (day === '*' && month === '*') {
    if (WHOLE.test(minute) && WHOLE.test(hour) && +minute < 60 && +hour < 24) {
      const at = clock(+hour, +minute);
      if (weekday === '*') return `Every day at ${at}`;
      if (weekday === '1-5') return `Weekdays at ${at}`;
      if (weekday === '0,6' || weekday === '6,0') return `Weekends at ${at}`;
      if (WHOLE.test(weekday) && +weekday <= 7) return `Every ${DAYS[+weekday % 7]} at ${at}`;
    }
    if (weekday === '*' && hour === '*' && /^\*\/\d+$/.test(minute)) return `Every ${minute.slice(2)} minutes`;
    if (weekday === '*' && hour === '*' && minute === '0') return 'Every hour';
  }
  return `Custom schedule (${expression})`;
}

/** How often a routine runs, in words. */
export function describeSchedule(routine) {
  if (routine.cron) return describeCron(routine.cron);
  if (routine.every_ms) {
    const minutes = Math.round(routine.every_ms / 60_000);
    if (minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
    return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`;
  }
  return 'Runs once';
}

/** A timestamp for people: "Mon, Oct 5, 9:00 AM CDT". The routine's own zone wins for cron. */
export function formatWhen(iso, timeZone = null) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try { return date.toLocaleString([], timeZone ? { ...options, timeZone, timeZoneName: 'short' } : options); }
  catch { return date.toLocaleString(); }
}

/**
 * Where a routine stands. A routine can be switched off itself, finished (a one-off that
 * already ran), or fine but held up because its whole workflow is paused.
 */
export function routineState(routine, workflowOn) {
  if (routine.enabled === false) return { key: 'paused', label: 'Paused', note: 'Switched off. It will not run until you resume it.' };
  if (routine.fired && !routine.cron && !routine.every_ms) return { key: 'done', label: 'Done', note: 'This one-off routine has already run.' };
  if (!workflowOn) return { key: 'held', label: 'Waiting', note: 'Its desk is paused, so it will not run until you resume the desk.' };
  return { key: 'active', label: 'Active', note: '' };
}

/** "Next run: Mon, Oct 5, 9:00 AM CDT", or why there isn't one. */
export function nextRunText(routine, workflowOn) {
  const state = routineState(routine, workflowOn);
  if (state.key !== 'active') return state.note;
  const when = formatWhen(routine.due_at, routine.cron ? routine.timezone : null);
  return when ? `Next run: ${when}` : '';
}

/** The sentence under the Pause button, so nobody is surprised by what it stops. */
export function pauseWarning(deskName, botNames) {
  const bots = botNames.length ? botNames.join(', ') : 'its bots';
  return `Pause “${deskName || 'General'}”?\n\nRunning and waiting automatic work for ${bots} stops now, and their routines won’t start. You can still message them directly. Resume any time.`;
}

export function removeWarning(name) {
  return `Remove the routine “${name}”?\n\nIts schedule is deleted for good. Work that is already running isn’t affected.`;
}
