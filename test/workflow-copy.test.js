import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCron, describeSchedule, routineState, nextRunText, pauseWarning, removeWarning, CRON_PRESETS, formatWhen } from '../web/workflow-copy.js';
import { parseCron } from '../src/core/cron.js';

// The Desks panel describes schedules and states in words. These pin the words
// to what the schedule really does, so the panel never says something untrue.

test('common cron schedules read as plain English', () => {
  assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 9:00 AM');
  assert.equal(describeCron('30 14 * * *'), 'Every day at 2:30 PM');
  assert.equal(describeCron('0 0 * * *'), 'Every day at 12:00 AM');
  assert.equal(describeCron('0 12 * * 0,6'), 'Weekends at 12:00 PM');
  assert.equal(describeCron('15 8 * * 1'), 'Every Monday at 8:15 AM');
  assert.equal(describeCron('0 8 * * 7'), 'Every Sunday at 8:00 AM');
  assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(describeCron('0 * * * *'), 'Every hour');
});

test('an unusual cron is shown as written, never guessed at', () => {
  assert.equal(describeCron('0 9 1 * *'), 'Custom schedule (0 9 1 * *)');
  assert.equal(describeCron('0 9 * 6 *'), 'Custom schedule (0 9 * 6 *)');
  assert.match(describeCron('99 99 * * *'), /^Custom schedule/);
});

test('every preset offered in the form is valid cron and describes itself', () => {
  for (const preset of CRON_PRESETS.filter((p) => p.value !== 'custom')) {
    assert.doesNotThrow(() => parseCron(preset.value), preset.value);
    assert.doesNotMatch(describeCron(preset.value), /^Custom/, preset.value);
  }
});

test('intervals and one-offs are described by how often they run', () => {
  assert.equal(describeSchedule({ every_ms: 60_000 }), 'Every minute');
  assert.equal(describeSchedule({ every_ms: 30 * 60_000 }), 'Every 30 minutes');
  assert.equal(describeSchedule({ every_ms: 3_600_000 }), 'Every hour');
  assert.equal(describeSchedule({ every_ms: 6 * 3_600_000 }), 'Every 6 hours');
  assert.equal(describeSchedule({ every_ms: 86_400_000 }), 'Every day');
  assert.equal(describeSchedule({ every_ms: 3 * 86_400_000 }), 'Every 3 days');
  assert.equal(describeSchedule({}), 'Runs once');
  assert.equal(describeSchedule({ cron: '0 9 * * 1-5' }), 'Weekdays at 9:00 AM');
});

test('a routine is Active, Paused, Done, or Waiting on its paused desk', () => {
  assert.equal(routineState({ every_ms: 60_000 }, true).label, 'Active');
  assert.equal(routineState({ enabled: false, every_ms: 60_000 }, true).label, 'Paused');
  assert.equal(routineState({ fired: true }, true).label, 'Done');
  assert.equal(routineState({ every_ms: 60_000 }, false).label, 'Waiting');
  // A recurring routine is never "Done" just because it has fired before.
  assert.equal(routineState({ fired: true, every_ms: 60_000 }, true).label, 'Active');
  assert.equal(routineState({ fired: true, cron: '0 9 * * *' }, true).label, 'Active');
  // Switched off wins over everything else.
  assert.equal(routineState({ enabled: false, fired: true }, false).label, 'Paused');
});

test('the next-run line is honest about why a routine is not going to run', () => {
  assert.match(nextRunText({ every_ms: 60_000, due_at: '2026-10-05T14:00:00.000Z' }, true), /^Next run: /);
  assert.match(nextRunText({ enabled: false, due_at: '2026-10-05T14:00:00.000Z' }, true), /Switched off/);
  assert.match(nextRunText({ every_ms: 60_000, due_at: '2026-10-05T14:00:00.000Z' }, false), /desk is paused/);
  assert.match(nextRunText({ fired: true, due_at: '2026-10-05T14:00:00.000Z' }, true), /already run/);
});

test('a cron routine shows its next run in its own time zone', () => {
  const text = nextRunText({ cron: '0 9 * * *', timezone: 'America/Chicago', due_at: '2026-10-05T14:00:00.000Z' }, true);
  assert.match(text, /9:00/);
  assert.match(text, /CDT/);
  assert.equal(formatWhen('not a date'), '');
});

test('the warnings say exactly what will happen', () => {
  assert.match(pauseWarning('Research', ['Scout', 'Analyst']), /Scout, Analyst/);
  assert.match(pauseWarning('Research', ['Scout']), /message them directly/);
  assert.match(pauseWarning('', []), /“General”/);
  assert.match(removeWarning('Morning sweep'), /“Morning sweep”.*deleted for good/s);
  assert.match(removeWarning('x'), /already running isn’t affected/);
});
