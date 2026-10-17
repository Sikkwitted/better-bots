import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextCronTime, CronError, isValidTimeZone } from '../src/core/cron.js';
import { fixedClock } from '../src/core/clock.js';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { tmpDir, oneStep, say } from './helpers.js';

// "Weekdays at seven, Chicago time" is a promise an interval cannot keep across
// daylight saving. These pin the cron evaluator to wall-clock truth.

test('cron fields parse: lists, ranges, steps, names, and Sunday as 0 or 7', () => {
  const c = parseCron('*/15 9-17 1,15 jan-mar mon-fri');
  assert.deepEqual([...c.minute.values], [0, 15, 30, 45]);
  assert.deepEqual([...c.hour.values], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...c.day.values], [1, 15]);
  assert.deepEqual([...c.month.values], [1, 2, 3]);
  assert.deepEqual([...c.weekday.values], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('0 0 * * 7').weekday.values], [0]);
  assert.throws(() => parseCron('0 7 * *'), CronError);
  assert.throws(() => parseCron('61 7 * * *'), CronError);
  assert.throws(() => parseCron('0 7 * * 1-9'), CronError);
  assert.ok(isValidTimeZone('America/Chicago') && !isValidTimeZone('Mars/Olympus'));
});

test('next fire time honours the zone across daylight saving', () => {
  // 07:00 Chicago is 12:00Z in summer and 13:00Z in winter.
  assert.equal(nextCronTime('0 7 * * *', '2026-07-01T00:00:00Z', 'America/Chicago'), '2026-07-01T12:00:00.000Z');
  assert.equal(nextCronTime('0 7 * * *', '2026-12-01T00:00:00Z', 'America/Chicago'), '2026-12-01T13:00:00.000Z');
  // Weekdays only: from a Friday evening, the next is Monday.
  assert.equal(nextCronTime('0 7 * * 1-5', '2026-09-04T20:00:00Z', 'America/Chicago'), '2026-09-07T12:00:00.000Z');
  // Strictly after: at exactly the match, the next one is tomorrow.
  assert.equal(nextCronTime('0 7 * * *', '2026-09-03T12:00:00Z', 'America/Chicago'), '2026-09-04T12:00:00.000Z');
  // Day-of-month OR day-of-week when both are restricted (Vixie semantics).
  assert.equal(nextCronTime('0 9 13 * fri', '2026-09-01T00:00:00Z', 'UTC'), '2026-09-04T09:00:00.000Z');
  assert.equal(nextCronTime('0 9 13 * fri', '2026-09-05T00:00:00Z', 'UTC'), '2026-09-11T09:00:00.000Z');
  // A date that never comes returns null rather than spinning.
  assert.equal(nextCronTime('0 0 31 2 *', '2026-01-01T00:00:00Z', 'UTC'), null);
});

test('a cron automation is scheduled at its next wall-clock match, fires, and re-arms without replaying missed windows', async () => {
  const clock = fixedClock(Date.parse('2026-09-03T11:00:00Z')); // 06:00 Chicago, a Thursday
  const at = (iso) => clock.advance(Date.parse(iso) - clock.now());
  const host = new Host({ dir: tmpDir(), adapter: new ScriptedAdapter(oneStep(() => [say('morning report')])), clock });
  const agent = host.registry.create({ profile: { name: 'Ada' } });
  const item = host.scheduleAutomation({ agent_id: agent.id, name: 'standup', text: 'post the standup', cron: '0 7 * * 1-5', timezone: 'America/Chicago' });
  assert.equal(item.due_at, '2026-09-03T12:00:00.000Z');
  assert.equal(item.cron, '0 7 * * 1-5');

  assert.equal(host.tickAutomations().length, 0, 'not yet');
  at('2026-09-03T12:00:30Z');
  assert.equal(host.tickAutomations().length, 1, 'fires at seven');
  await host.drain();
  assert.ok(host.transcripts.all('agent', agent.id).some((e) => e.kind === 'agent_text' && /morning report/.test(e.text)));
  let saved = host.listAutomations()[0];
  assert.equal(saved.due_at, '2026-09-04T12:00:00.000Z', 're-armed for Friday');

  // The host was down over the weekend and Monday morning: one fire on wake, not three.
  at('2026-09-08T15:00:00Z'); // Tuesday 10:00 Chicago
  assert.equal(host.tickAutomations().length, 1);
  saved = host.listAutomations()[0];
  assert.equal(saved.fires, 2);
  assert.equal(saved.due_at, '2026-09-09T12:00:00.000Z', 'next is Wednesday, the missed Friday and Monday are not replayed');

  assert.throws(() => host.scheduleAutomation({ agent_id: agent.id, name: 'x', text: 'x', cron: 'nope' }), /bad_cron|five fields/);
  assert.throws(() => host.scheduleAutomation({ agent_id: agent.id, name: 'x', text: 'x', cron: '0 7 * * *', timezone: 'Mars/Olympus' }), /bad_timezone|time zone/);
  assert.throws(() => host.scheduleAutomation({ agent_id: agent.id, name: 'x', text: 'x', cron: '0 7 * * *', every_ms: 60_000 }), /bad_schedule|not both/);
});

test('a job inside the spring-forward gap runs once the clock resumes, not never', () => {
  // 2026-03-08 in Chicago: 02:00 jumps to 03:00 (08:00Z). 02:30 does not exist that day.
  assert.equal(nextCronTime('30 2 * * *', '2026-03-08T00:00:00Z', 'America/Chicago'), '2026-03-08T08:00:00.000Z');
  assert.equal(nextCronTime('30 2 * * *', '2026-03-07T12:00:00Z', 'America/Chicago'), '2026-03-08T08:00:00.000Z');
  // A normal day is unaffected.
  assert.equal(nextCronTime('30 2 * * *', '2026-03-09T00:00:00Z', 'America/Chicago'), '2026-03-09T07:30:00.000Z');
});

test('a job in the repeated fall-back hour fires once, on the first pass', () => {
  // 2026-11-01 in Chicago: 01:30 happens at 06:30Z (CDT) and again at 07:30Z (CST).
  assert.equal(nextCronTime('30 1 * * *', '2026-11-01T00:00:00Z', 'America/Chicago'), '2026-11-01T06:30:00.000Z');
  assert.equal(nextCronTime('30 1 * * *', '2026-11-01T06:30:00Z', 'America/Chicago'), '2026-11-02T07:30:00.000Z');
  assert.equal(nextCronTime('30 1 * * *', '2026-11-01T06:45:00Z', 'America/Chicago'), '2026-11-02T07:30:00.000Z');
});

test('a day-of-month field starting with * does not turn weekday matching into OR', () => {
  // */2 is every second day, still restricted by the weekday: Mondays that fall on odd days only.
  assert.equal(nextCronTime('0 0 */2 * 1', '2026-03-01T00:00:00Z', 'UTC'), '2026-03-09T00:00:00.000Z');
});

test('malformed numbers are rejected rather than coerced', () => {
  for (const bad of ['0x10 * * * *', '1/2/3 * * * *', '*/x * * * *', '1e1 * * * *']) assert.throws(() => parseCron(bad), CronError, bad);
});

test('an impossible date answers quickly with no match', () => {
  const started = Date.now();
  assert.equal(nextCronTime('* * 31 2 *', '2026-01-01T00:00:00Z', 'UTC'), null);
  assert.ok(Date.now() - started < 1500);
});
