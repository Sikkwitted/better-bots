import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRequest, standingRuleHelp, zoneTitle, ZONE_COPY, MODE_COPY } from '../web/permission-copy.js';
import { ACTION_POLICY, ZONES } from '../src/services/permission-service.js';

// A person deciding whether to let a bot act has to understand the prompt. These pin
// the wording to plain English and make sure every real action and zone has some.

test('every permission zone has a plain title and description', () => {
  for (const zone of ZONES) {
    assert.ok(ZONE_COPY[zone]?.title, `${zone} has a title`);
    assert.ok(ZONE_COPY[zone]?.note.length > 20, `${zone} is described`);
    assert.doesNotMatch(zoneTitle(zone), /^(local|external|sandbox|coordination)$/);
  }
});

test('every action the host can ask about reads as a sentence, never as an internal id', () => {
  for (const action of Object.keys(ACTION_POLICY).filter((a) => !['policy.change_standing', 'web.read_public', 'sandbox.read_file', 'sandbox.write_file', 'sandbox.run_test', 'sandbox.run_command', 'coordination.handoff', 'integration.read'].includes(a))) {
    const words = describeRequest({ action, target: 'x' }, 'Scout');
    assert.match(words.headline, /^Scout wants to [a-z]/, action);
    assert.doesNotMatch(words.headline, /[._]/, `${action} leaks an internal id: ${words.headline}`);
    assert.ok(words.risk, `${action} says why it matters`);
  }
});

test('an unknown action still produces a readable, honest headline', () => {
  const words = describeRequest({ action: 'future.thing_here' }, 'Ada');
  assert.equal(words.headline, 'Ada wants to do something (future thing here)');
});

test('a browser action is described by what it does, not as JSON', () => {
  const words = describeRequest({ action: 'external.browser', target: JSON.stringify({ window: 2, action: 'click', detail: { x: 10, y: 20 } }) }, 'Scout');
  assert.equal(words.headline, 'Scout wants to use its web browser');
  assert.match(words.target, /^click — x: 10, y: 20$/);
  assert.doesNotMatch(words.target, /[{}"]/);
});

test('a command and a file are labelled for what they are', () => {
  assert.equal(describeRequest({ action: 'local.run_command', target: 'ls -la' }).targetLabel, 'Command');
  assert.equal(describeRequest({ action: 'local.write_file', target: '/tmp/a.txt' }).targetLabel, 'File');
  assert.match(describeRequest({ action: 'local.run_command', target: 'ls' }).risk, /directly on this computer/);
});

test('connected-tool names are shown readably', () => {
  const words = describeRequest({ action: 'external.unclassified', tool: 'github__create_issue', target: '{}' }, 'Scout');
  assert.equal(words.tool, 'github → create_issue');
});

test('the standing-rule help names the category and says it applies to every bot', () => {
  const help = standingRuleHelp('local');
  assert.match(help, /This computer/);
  assert.match(help, /every bot/);
  assert.match(help, /App settings → Permissions/);
});

test('the three standing modes have human labels', () => {
  assert.deepEqual(Object.keys(MODE_COPY).sort(), ['always', 'ask', 'never']);
  for (const mode of Object.values(MODE_COPY)) assert.ok(mode.label.length > 4);
});
