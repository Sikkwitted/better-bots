// Five-field cron, evaluated in a named time zone, no dependencies.
//
//   minute hour day-of-month month day-of-week
//   *  ,  -  /   in each field; names for months and days; 0 or 7 is Sunday.
//
// "0 7 * * 1-5" in America/Chicago fires at 07:00 Chicago time on weekdays,
// across DST, which an interval can never promise. Day-of-month and
// day-of-week combine with OR when both are restricted, as in Vixie cron.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  { name: 'weekday', min: 0, max: 7, names: DAYS },
];

export class CronError extends Error {}

function parseField(text, spec) {
  const values = new Set();
  // As in Vixie cron, a field that starts with `*` (including `*/2`) is not a restriction.
  const restricted = !text.startsWith('*');
  for (const part of text.split(',')) {
    const pieces = part.split('/');
    if (pieces.length > 2) throw new CronError(`bad step in ${spec.name}: ${part}`);
    const [rangeText, stepText] = pieces;
    if (stepText !== undefined && !/^\d+$/.test(stepText)) throw new CronError(`bad step in ${spec.name}: ${part}`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`bad step in ${spec.name}: ${part}`);
    let lo;
    let hi;
    if (rangeText === '*') { lo = spec.min; hi = spec.max; } else {
      const [a, b] = rangeText.split('-');
      lo = named(a, spec);
      hi = b === undefined ? (stepText === undefined ? lo : spec.max) : named(b, spec);
    }
    if (lo > hi) throw new CronError(`bad range in ${spec.name}: ${part}`);
    for (let v = lo; v <= hi; v += step) values.add(spec.name === 'weekday' && v === 7 ? 0 : v);
  }
  return { values, restricted };
}

function named(token, spec) {
  const t = String(token).trim().toLowerCase();
  const idx = spec.names?.indexOf(t.slice(0, 3));
  if (idx !== undefined && idx >= 0) return spec.min + idx;
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw new CronError(`bad value in ${spec.name}: ${token}`);
  return n;
}

export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`a cron expression has five fields, got ${parts.length}: "${expression}"`);
  const fields = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { expression: parts.join(' '), minute: fields[0], hour: fields[1], day: fields[2], month: fields[3], weekday: fields[4] };
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** The wall clock in `tz` for an instant: { minute, hour, day, month, weekday }. */
// Building a formatter is the expensive part; nextCronTime walks minute by minute.
const formatters = new Map();
function wallClock(date, tz) {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', year: 'numeric', weekday: 'short',
    });
    formatters.set(tz, formatter);
  }
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')), minute: Number(get('minute')), hour: Number(get('hour')), day: Number(get('day')), month: Number(get('month')),
    weekday: DAYS.indexOf(get('weekday').toLowerCase()),
  };
}

function matches(cron, wc) {
  if (!cron.minute.values.has(wc.minute) || !cron.hour.values.has(wc.hour) || !cron.month.values.has(wc.month)) return false;
  const dayOk = cron.day.values.has(wc.day);
  const weekdayOk = cron.weekday.values.has(wc.weekday);
  if (cron.day.restricted && cron.weekday.restricted) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

/**
 * The first instant strictly after `after` that matches, as an ISO string, or
 * null if nothing matches within about two years (e.g. "31 Feb").
 */
export function nextCronTime(cron, after, tz = 'UTC') {
  const parsed = typeof cron === 'string' ? parseCron(cron) : cron;
  if (!isValidTimeZone(tz)) throw new CronError(`unknown time zone ${tz}`);
  const start = typeof after === 'number' ? after : Date.parse(after);
  let t = Math.floor(start / 60_000) * 60_000 + 60_000; // the next whole minute
  const limit = t + 2 * 366 * 86_400_000;
  // The wall clock as a count of minutes, for noticing when it jumps (a DST change).
  const wallMinutes = (w) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) / 60_000;
  const sameWall = (a, b) => wallMinutes(a) === wallMinutes(b);
  let prev = null;
  while (t < limit) {
    const wc = wallClock(new Date(t), tz);
    const wm = wallMinutes(wc);
    if (prev) {
      // Spring forward: wall times in the skipped hour never occur. Like Vixie cron, run a job
      // that fell inside the gap as soon as the clock resumes, instead of silently skipping the day.
      const elapsed = (t - prev.t) / 60_000;
      const jump = wm - prev.wm - elapsed;
      if (jump > 0 && jump <= 180) {
        for (let k = prev.wm + elapsed; k < wm; k += 1) {
          const d = new Date(k * 60_000);
          if (matches(parsed, { minute: d.getUTCMinutes(), hour: d.getUTCHours(), day: d.getUTCDate(), month: d.getUTCMonth() + 1, weekday: d.getUTCDay() })) {
            return new Date(t).toISOString();
          }
        }
      }
    }
    prev = { t, wm };
    if (matches(parsed, wc)) {
      // Fall back: the repeated hour shows the same wall time twice. Fire on the first pass only.
      const repeated = [1_800_000, 3_600_000].some((back) => sameWall(wallClock(new Date(t - back), tz), wc));
      if (!repeated) return new Date(t).toISOString();
    }
    // Skip whole hours and days when they cannot match, so a yearly schedule is cheap.
    if (!parsed.hour.values.has(wc.hour) || !parsed.month.values.has(wc.month)) t += (60 - wc.minute) * 60_000;
    else t += 60_000;
  }
  return null;
}
