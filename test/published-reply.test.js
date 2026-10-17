import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';
import { call, isToolFollowUp, say, tmpDir } from './helpers.js';

const answer = 'The funnel needs qualification.\n\nEvidence\n- Three discoveries need checking.\n\nRemaining risks\n- Compensation is unconfirmed.';
const publication = { conclusion: 'The funnel needs qualification.', evidence: ['Three discoveries need checking.'], risks: ['Compensation is unconfirmed.'] };

function leadHost(script, dir = tmpDir()) {
  const adapter = new ScriptedAdapter(script);
  const host = new Host({ dir, adapter, clock: fixedClock() });
  if (!host.registry.has('agt_lead')) host.registry.create({ id: 'agt_lead', profile: { name: 'Lead', lead: true } });
  return { host, adapter, dir };
}

test('a tool-only publication becomes the conversation answer, turn result, and next model context', async () => {
  const { host, adapter } = leadHost((ctx) => isToolFollowUp(ctx) ? [] : [call('AssembleResult', publication)]);
  const run = host.userRequest({ agent_id: 'agt_lead', text: 'Why are there no leads?' });
  await host.drain();
  const packet = host.visibleResults().find((entry) => entry.kind === 'lead_result');
  const transcript = host.transcripts.all('agent', 'agt_lead');
  const replies = transcript.filter((entry) => entry.kind === 'agent_text');
  assert.equal(replies.length, 1, 'a successful published answer must be visible outside tool traces');
  assert.equal(replies[0].text, answer);
  assert.equal(replies[0].result_id, packet.id);
  assert.equal(replies[0].run_id, run.id);
  assert.equal(host.turnResult(run.id).text, answer);
  assert.ok(transcript.some((entry) => entry.kind === 'tool_result' && entry.result?.result_id === packet.id && entry.result.ok));
  assert.equal(host.audit.where((entry) => entry.type === 'result.published').length, 1);
  assert.ok(host.memory.factsIn('agent', 'agt_lead').some((fact) => fact.ref?.run_id === run.id && fact.text.includes('answered: The funnel needs qualification.')));

  adapter.script = () => [say('I will check those discoveries.')];
  host.userRequest({ agent_id: 'agt_lead', text: 'What needs checking?' });
  await host.drain();
  assert.ok(adapter.calls.at(-1).messages.some((message) => message.role === 'assistant' && message.content === answer));
});

test('publication is terminal so a model cannot repeat the same answer in a follow-up', async () => {
  const { host } = leadHost((ctx) => isToolFollowUp(ctx) ? [say(answer)] : [call('AssembleResult', publication)]);
  const run = host.userRequest({ agent_id: 'agt_lead', text: 'Publish the answer.' });
  await host.drain();
  assert.equal(host.turnResult(run.id).text, answer);
  assert.equal(host.transcripts.all('agent', 'agt_lead').filter((entry) => entry.kind === 'agent_text').length, 1);
  assert.equal(host.turnResult(run.id).usage.calls, 1, 'the host should stop once the final publication commits');
});

test('reopening backfills only committed answers in their original conversation position, once', async () => {
  const { host, dir } = leadHost(() => []);
  host.registry.create({ id: 'agt_other', profile: { name: 'Other' } });
  host.transcripts.append('agent', 'agt_lead', { kind: 'user_message', text: 'Original request' });
  host.transcripts.append('agent', 'agt_lead', { kind: 'tool_call', name: 'AssembleResult', input: publication });
  const receipt = host.transcripts.append('agent', 'agt_lead', {
    kind: 'tool_result', name: 'AssembleResult', result: { ok: true, result_id: 'res_old', published_at: '2026-09-09T10:00:00.000Z' },
  });
  const later = host.transcripts.append('agent', 'agt_lead', { kind: 'user_message', text: 'A later request' });
  host.transcripts.append('agent', 'agt_lead', { kind: 'tool_call', name: 'AssembleResult', input: { conclusion: 'Uncommitted input must stay a trace.' } });
  host.transcripts.append('agent', 'agt_lead', { kind: 'tool_result', name: 'AssembleResult', result: { ok: false, error: 'tool_error' } });
  host.results.append({ id: 'res_old', kind: 'lead_result', lead_agent_id: 'agt_lead', run_id: 'run_old', ...publication, remaining_risks: publication.risks, at: '2026-09-09T10:00:00.000Z' });
  host.results.append({ run_id: 'run_old', agent_id: 'agt_lead', status: 'completed', text: '', at: '2026-09-09T10:00:01.000Z' });

  const { host: reopened, adapter } = leadHost(() => [say('Understood.')], dir);
  reopened.recover();
  reopened.recover();
  const entries = reopened.transcripts.all('agent', 'agt_lead');
  assert.equal(entries.filter((entry) => entry.kind === 'agent_text').length, 1);
  const recovered = entries.find((entry) => entry.result_id === 'res_old');
  assert.equal(recovered.text, answer);
  assert.equal(recovered.run_id, 'run_old');
  assert.equal(entries.indexOf(recovered), entries.findIndex((entry) => entry.id === receipt.id) + 1);
  assert.ok(entries.indexOf(recovered) < entries.findIndex((entry) => entry.id === later.id));
  assert.equal(reopened.turnResult('run_old').text, answer);
  assert.equal(reopened.transcripts.all('agent', 'agt_other').length, 0);
  assert.deepEqual(reopened.transcripts.all('agent', 'agt_lead'), entries, 'reads do not create duplicate messages');
  assert.equal(reopened.transcripts.tail('agent', 'agt_lead', 3).some((entry) => entry.result_id === 'res_old'), false, 'tail uses conversational ordering');

  reopened.userRequest({ agent_id: 'agt_lead', text: 'Continue from that result.' });
  await reopened.drain();
  assert.ok(adapter.calls[0].messages.some((message) => message.role === 'assistant' && message.content === answer));
  reopened.userRequest({ agent_id: 'agt_other', text: 'What do you know?' });
  await reopened.drain();
  assert.equal(adapter.calls.at(-1).messages.some((message) => message.content === answer), false, 'another agent never inherits the private reply');
});

test('a refused AssembleResult call never becomes a published chat answer', async () => {
  const { host } = leadHost((ctx) => isToolFollowUp(ctx) ? [] : [call('AssembleResult', publication)]);
  host.registry.updateProfile('agt_lead', { lead: false });
  const run = host.userRequest({ agent_id: 'agt_lead', text: 'Publish.' });
  await host.drain();
  host.recover();
  assert.equal(host.turnResult(run.id).text, '');
  assert.equal(host.transcripts.all('agent', 'agt_lead').some((entry) => entry.kind === 'agent_text'), false);
});

test('recovery keeps complete model prose without duplicating the committed answer', () => {
  const { host, dir } = leadHost(() => []);
  host.transcripts.append('agent', 'agt_lead', { kind: 'agent_text', run_id: 'run_spoken', text: answer });
  host.results.append({ id: 'res_spoken', kind: 'lead_result', lead_agent_id: 'agt_lead', run_id: 'run_spoken', ...publication, remaining_risks: publication.risks, at: fixedClock().iso() });
  host.results.append({ run_id: 'run_spoken', agent_id: 'agt_lead', status: 'completed', text: answer });
  const { host: reopened } = leadHost(() => [], dir);
  reopened.recover();
  assert.deepEqual(reopened.transcripts.all('agent', 'agt_lead').map((entry) => entry.text), [answer]);
  assert.equal(reopened.turnResult('run_spoken').text, answer);
});

test('a crash after committing several packets does not lose any recovered answer', () => {
  const { host, dir } = leadHost(() => []);
  host.transcripts.append('agent', 'agt_lead', { kind: 'user_message', text: 'Summarize.' });
  // The committed packets survived, but the process died before tool receipts.
  for (const [id, conclusion] of [['res_first', 'First committed answer.'], ['res_second', 'Second committed answer.']]) {
    host.results.append({ id, kind: 'lead_result', lead_agent_id: 'agt_lead', run_id: 'run_crashed', conclusion, at: fixedClock().iso() });
  }
  const { host: reopened } = leadHost(() => [], dir);
  reopened.recover();
  assert.deepEqual(reopened.transcripts.all('agent', 'agt_lead').filter((entry) => entry.kind === 'agent_text').map((entry) => entry.text), ['First committed answer.', 'Second committed answer.']);
});

test('structured evidence and risks publish as readable text instead of object coercion', async () => {
  const { host } = leadHost(() => [call('AssembleResult', {
    conclusion: 'Check compensation.', evidence: [{ source: 'listing', observation: 'Budget is missing.' }, 'Keep this string.'],
    risks: [{ risk: 'Payment is unconfirmed.' }],
  })]);
  const run = host.userRequest({ agent_id: 'agt_lead', text: 'Summarize.' });
  await host.drain();
  assert.equal(host.turnResult(run.id).text, 'Check compensation.\n\nEvidence\n- Source: listing; Observation: Budget is missing.\n- Keep this string.\n\nRemaining risks\n- Risk: Payment is unconfirmed.');
  assert.equal(host.visibleResults().find((entry) => entry.kind === 'lead_result').evidence[0], 'Source: listing; Observation: Budget is missing.');
});

test('recovery corrects already materialized object coercion only from its matching successful call, append-only', () => {
  const { host, dir } = leadHost(() => []);
  const input = { conclusion: 'Check compensation.', evidence: [{ source: 'listing', observation: 'Budget is missing.' }], risks: [{ risk: 'Payment is unconfirmed.' }] };
  host.transcripts.append('agent', 'agt_lead', { kind: 'tool_call', name: 'AssembleResult', input });
  const receipt = host.transcripts.append('agent', 'agt_lead', { kind: 'tool_result', name: 'AssembleResult', result: { ok: true, result_id: 'res_object' } });
  const oldText = 'Check compensation.\n\nEvidence\n- [object Object]\n\nRemaining risks\n- [object Object]';
  const original = host.transcripts.append('agent', 'agt_lead', { kind: 'agent_text', text: oldText, result_id: 'res_object', run_id: 'run_object', after_id: receipt.id });
  host.transcripts.append('agent', 'agt_lead', { kind: 'user_message', text: 'Next question.' });
  host.results.append({ kind: 'lead_result', id: 'res_object', lead_agent_id: 'agt_lead', run_id: 'run_object', conclusion: input.conclusion, evidence: ['[object Object]'], remaining_risks: ['[object Object]'], at: fixedClock().iso() });
  host.results.append({ run_id: 'run_object', agent_id: 'agt_lead', text: oldText, status: 'completed' });
  const file = path.join(dir, 'agents', 'agt_lead', 'transcript.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  const { host: reopened } = leadHost(() => [], dir);
  const expected = 'Check compensation.\n\nEvidence\n- Source: listing; Observation: Budget is missing.\n\nRemaining risks\n- Risk: Payment is unconfirmed.';
  assert.equal(reopened.transcripts.all('agent', 'agt_lead').find((entry) => entry.id === original.id).text, expected);
  assert.equal(reopened.turnResult('run_object').text, expected);
  const repaired = fs.readFileSync(file, 'utf8');
  assert.ok(repaired.startsWith(before), 'original log bytes remain untouched');
  assert.equal(repaired.slice(before.length).trim().split('\n').length, 1, 'one correction record repairs the existing bubble');
  reopened.recover();
  leadHost(() => [], dir);
  assert.equal(fs.readFileSync(file, 'utf8'), repaired, 'repeated recovery never appends the same correction');
  assert.equal(reopened.transcripts.all('agent', 'agt_lead').filter((entry) => entry.kind === 'agent_text').length, 1);
});

test('recovery never substitutes evidence from failed, unmatched, or changed calls', () => {
  for (const mismatch of ['failed', 'different_result', 'different_conclusion', 'different_evidence']) {
    const { host, dir } = leadHost(() => []);
    const input = { conclusion: mismatch === 'different_conclusion' ? 'Different answer.' : 'Committed answer.', evidence: [{ observation: 'Unchecked assertion.' }] };
    host.transcripts.append('agent', 'agt_lead', { kind: 'tool_call', name: 'AssembleResult', input });
    host.transcripts.append('agent', 'agt_lead', { kind: 'tool_result', name: 'AssembleResult', result: { ok: mismatch !== 'failed', result_id: mismatch === 'different_result' ? 'res_other' : 'res_unmatched' } });
    host.results.append({ kind: 'lead_result', id: 'res_unmatched', lead_agent_id: 'agt_lead', conclusion: 'Committed answer.', evidence: mismatch === 'different_evidence' ? ['Known fact.'] : ['[object Object]'], remaining_risks: [], at: fixedClock().iso() });
    const { host: reopened } = leadHost(() => [], dir);
    assert.equal(reopened.transcripts.all('agent', 'agt_lead').some((entry) => entry.kind === 'agent_text' && entry.text.includes('Unchecked assertion.')), false, mismatch);
  }
});
