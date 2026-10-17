import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHost, reopenHost } from './helpers.js';

// A desk is referenced by its stored name. The console labels the default desk
// ('') "General"; saving that label, or a different capitalization of an
// existing desk, used to create a phantom desk nobody else was on.

test('saving the "General" label puts the agent on the real default desk', () => {
  const { host } = makeHost();
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_k', profile: { name: 'Morgan', desk: 'Review' } });
  for (const label of ['General', 'general', '  GENERAL  ']) {
    host.registry.updateProfile('agt_k', { desk: label });
    assert.equal(host.registry.get('agt_k').profile.desk, '', `"${label}" means the default desk`);
  }
  assert.deepEqual(host.listDesks().map((d) => d.name), [''], 'no second "General" desk appears');
});

test('a desk name that differs only by case or spacing joins the existing desk', () => {
  const { host } = makeHost();
  host.registry.create({ id: 'agt_1', profile: { name: 'One', desk: 'Field Ops' } });
  host.registry.create({ id: 'agt_2', profile: { name: 'Two', desk: 'field  ops ' } });
  host.registry.create({ id: 'agt_3', profile: { name: 'Three' } });
  host.registry.updateProfile('agt_3', { desk: 'FIELD OPS' });
  for (const id of ['agt_2', 'agt_3']) assert.equal(host.registry.get(id).profile.desk, 'Field Ops');
  assert.deepEqual(host.listDesks().map((d) => d.name), ['Field Ops'], 'one desk, not three spellings');
});

test('a desk with saved settings but no members is matched, and a new name still makes a new desk', () => {
  const { host } = makeHost();
  host.deskSettings.update((s) => { s.desks['Prompts for new Bots'] = { enabled: true }; return s; });
  host.registry.create({ id: 'agt_g', profile: { name: 'Riley', desk: 'prompts for new bots' } });
  assert.equal(host.registry.get('agt_g').profile.desk, 'Prompts for new Bots');
  host.registry.updateProfile('agt_g', { desk: 'Research' });
  assert.equal(host.registry.get('agt_g').profile.desk, 'Research');
});

test('lead uniqueness uses the resolved desk', () => {
  const { host } = makeHost();
  host.registry.create({ id: 'agt_x', profile: { name: 'X', lead: true } });
  host.registry.create({ id: 'agt_y', profile: { name: 'Y', desk: 'Ops' } });
  host.registry.updateProfile('agt_y', { desk: 'General', lead: true });
  assert.equal(host.registry.get('agt_x').profile.lead, false, 'the default desk keeps one lead');
  assert.equal(host.registry.get('agt_y').profile.lead, true);
});

test('agents already saved on a phantom "General" desk are moved back once, with an audit record', () => {
  const { host, dir } = makeHost();
  host.registry.create({ id: 'agt_k', profile: { name: 'Morgan' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bee', desk: 'Review' } });
  // Simulate a record written by an earlier version, bypassing resolution.
  host.registry.doc.update((s) => { s.agents.agt_k.profile.desk = 'General'; return s; });
  const file = path.join(dir, 'agents', 'registry.json');
  const reopened = reopenHost({ dir }).host;
  assert.equal(reopened.registry.get('agt_k').profile.desk, '');
  assert.equal(reopened.registry.get('agt_b').profile.desk, 'Review', 'other desks are untouched');
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(audit.filter((e) => e.type === 'agent.desk_repaired').map((e) => [e.agent_id, e.from]), [['agt_k', 'General']]);
  const before = fs.statSync(file).mtimeMs;
  reopenHost({ dir });
  assert.equal(fs.statSync(file).mtimeMs, before, 'a clean registry is not rewritten at startup');
});
