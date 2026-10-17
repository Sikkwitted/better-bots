import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { systemClock } from '../src/core/clock.js';

// The end-to-end example that motivates the design, run for real against the host.
//
//   "Research the best checkout pattern, build it, and review the final page."
//
// A scripted model drives it so the run is deterministic and needs no API key.
// Swapping in AnthropicAdapter changes nothing else — that is the point.

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'demo-data');
fs.rmSync(dir, { recursive: true, force: true });

const log = (step, text) => console.log(`\n\x1b[35m${step}\x1b[0m ${text}`);
const detail = (text) => console.log(`   ${text}`);

// --- 1. The lead agent turns one request into three roles ---------------------
let host;
const gates = { researcherDone: false, builderDone: false };

const script = (ctx) => {
  const { agent_id, payload } = ctx;
  // The host feeds tool results back for another model step. A real model would
  // summarise rather than repeat itself, so this script does the same.
  if (ctx.messages?.at(-1)?.role === 'tool_results') {
    return [{ type: 'text', text: 'Tool results received; the turn is complete.' }];
  }
  // Researcher: browse on its own screen, then send the three facts that matter.
  if (agent_id === 'agt_research' && payload.kind === 'user_request') {
    return [
      { type: 'text', text: 'Opening a browser window and reading three checkout write-ups.' },
      { type: 'tool_call', id: 't1', name: 'OpenScreen', input: {} },
      {
        type: 'tool_call', id: 't2', name: 'SendToAgent',
        input: {
          target_id: 'agt_build',
          message: [
            'Goal: pick the checkout pattern for the new page.',
            'State: three write-ups reviewed.',
            'Evidence: one-page checkout converts best; guest checkout is required; address autofill cuts drop-off.',
            'Constraint: do not add a second step.',
            'Next action: build the one-page form with guest checkout.',
          ].join('\n'),
        },
      },
      { type: 'remember', scope: 'project', tier: 'log', text: 'Chosen checkout pattern: one page, guest checkout, address autofill.' },
    ];
  }

  // Builder: wakes on the handoff, builds, then hands off to the reviewer.
  if (agent_id === 'agt_build' && payload.kind === 'agent_wake' && !gates.builderDone) {
    gates.builderDone = true;
    return [
      { type: 'text', text: 'Received the research handoff on a hidden wake. Building the page.' },
      { type: 'tool_call', id: 't3', name: 'OpenScreen', input: {} },
      { type: 'tool_call', id: 't4', name: 'SandboxWriteFile', input: { path: 'checkout.html', content: '<form id="checkout">one page, guest checkout</form>' } },
      {
        type: 'tool_call', id: 't5', name: 'SendToAgent',
        input: {
          target_id: 'agt_review',
          message: 'Goal: review the rendered checkout page.\nState: checkout.html written.\nNext action: open it and look for failures.',
        },
      },
    ];
  }

  // Builder, after the priority interrupt: it knows it was superseded.
  if (agent_id === 'agt_build' && payload.kind === 'agent_wake') {
    return [{ type: 'text', text: 'Stopping the animation polish. Fixing the checkout failure instead.' }];
  }

  // Builder's low-priority background polish, which the reviewer will supersede.
  if (agent_id === 'agt_build' && payload.kind === 'polish') {
    return (async function* () {
      yield { type: 'text', text: 'Polishing the button animation...' };
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { type: 'text', text: 'This line is never reached; the run is superseded first.' };
    })();
  }

  // Reviewer: inspects on its own screen and raises a priority message.
  if (agent_id === 'agt_review' && payload.kind === 'agent_wake') {
    return [
      { type: 'text', text: 'Opening the running page on a separate screen.' },
      { type: 'tool_call', id: 't6', name: 'OpenScreen', input: {} },
      { type: 'tool_call', id: 't7', name: 'SandboxReadFile', input: { path: 'checkout.html' } },
    ];
  }

  // Room turns: each specialty gives one view, or passes.
  if (payload.kind === 'room_turn') {
    if (agent_id === 'agt_research') return [{ type: 'text', text: 'Evidence still favours one page. Ship after the fix.' }];
    if (agent_id === 'agt_build') return [{ type: 'text', text: 'The submit handler is fixed and the form posts.' }];
    if (agent_id === 'agt_review') return [{ type: 'text', text: '(pass)' }];
  }

  return [{ type: 'text', text: 'Acknowledged.' }];
};

host = new Host({ dir, adapter: new ScriptedAdapter(script), clock: systemClock, window_count: 3 });

const research = host.registry.create({ id: 'agt_research', profile: { name: 'Research', role: 'Finds evidence', avatar_color: '#10b981' } });
const build = host.registry.create({ id: 'agt_build', profile: { name: 'Build', role: 'Writes the product', avatar_color: '#f59e0b' } });
const review = host.registry.create({ id: 'agt_review', profile: { name: 'Review', role: 'Checks the rendered result', avatar_color: '#ef4444' } });
const lead = host.registry.create({ id: 'agt_lead', profile: { name: 'Lead', role: 'Assembles one answer', avatar_color: '#6d28d9' } });

console.log('\x1b[1mBetter Bots — end-to-end example\x1b[0m');
console.log('Request: "Research the best checkout pattern, build it, and review the final page."');

log('1-2.', 'The lead turns one request into three roles, each with its own profile, transcript, memory view, and screen.');
for (const agent of [research, build, review]) detail(`${agent.profile.name.padEnd(9)} ${agent.id}  — ${agent.profile.role}`);

log('3-5.', 'The researcher browses and sends a small handoff. The send returns immediately; the builder wakes later.');
host.userRequest({ agent_id: research.id, text: 'Research the best checkout pattern.' });
await host.drain();
detail(`Handoff acknowledged, not answered: ${host.messages.allEnvelopes()[0].id}`);
detail(`Builder woke on a hidden turn and read ${host.transcripts.all('agent', build.id).filter((e) => e.kind === 'peer_message_in').length} peer message.`);

log('6-7.', 'The builder finishes and messages the reviewer, who opens the page on a separate screen.');
await host.drain();
for (const w of host.computer.assignments()) {
  detail(`${host.registry.get(w.agent_id).profile.name.padEnd(9)} window ${w.window_index} on ${w.computer_id} — ${w.vnc_url}`);
}
detail(host.computer.describe().warning);

log('8.', 'The builder starts low-priority polish. The reviewer finds a failure and sends a priority message.');
host.scheduler.enqueue({ agent_id: build.id, lane: 'background', payload: { kind: 'polish' } });
const running = host.scheduler.pump(build.id);
await new Promise((resolve) => setTimeout(resolve, 5));
const ack = host.deliverPeerMessage({
  sender_id: review.id, target_id: build.id,
  text: 'Stop polishing the animation. Checkout submit is broken.',
  priority: true, priority_reason: 'supersede',
});
detail(`Priority ack: ${ack.interrupt_note}`);
await running;
await host.drain();
const superseded = host.scheduler.runHistory().find((r) => r.payload?.kind === 'polish' && r.event === 'finished');
detail(`Interrupted run ${superseded.id}: reason=${superseded.interrupt_reason}, resume=${superseded.resume_policy}, partial output reusable=${superseded.partial_output_safe}`);

log('8b.', 'A user turn is never preempted, no matter how urgent the peer thinks it is.');
host.userRequest({ agent_id: build.id, text: 'Is the checkout fixed?' });
const userRun = host.scheduler.pump(build.id);
const declined = host.deliverPeerMessage({
  sender_id: review.id, target_id: build.id, text: 'Another urgent note.',
  priority: true, priority_reason: 'stop',
});
detail(`Priority ack: ${declined.interrupt_note}`);
await userRun;
await host.drain();

log('9.', 'Judgment is needed, so the three specialists enter a bounded room.');
const room = host.createRoom({ member_ids: [research.id, build.id, review.id], purpose: 'Go or no-go on shipping checkout' });
const meeting = await host.runRoom(room.id, { request: 'Do we ship the checkout page today?' });
for (const message of meeting.transcript.filter((m) => !m.system)) {
  detail(`${host.registry.get(message.sender_id).profile.name.padEnd(9)} ${message.text}`);
}
detail(`Stopped because: ${meeting.stop_reason} after ${meeting.rounds.length} round(s), ${meeting.total_messages} message(s).`);
detail(`Review passed and its pass was removed from the room instead of cluttering it.`);

log('10.', 'The lead returns one answer with conclusion, evidence, and remaining risks.');
const answer = host.assembleResult({
  lead_agent_id: lead.id,
  conclusion: 'Ship the one-page checkout with guest checkout and address autofill, after the submit fix.',
  evidence: host.memory.factsIn('project', 'default').map((f) => f.text),
  risks: ['The submit fix has not been re-tested on a real browser session.', 'Address autofill is unverified on mobile.'],
});
console.log(`\n   \x1b[1mConclusion\x1b[0m  ${answer.conclusion}`);
for (const e of answer.evidence) console.log(`   Evidence    ${e}`);
for (const r of answer.remaining_risks) console.log(`   Risk        ${r}`);

console.log('\n\x1b[1mWhat the host recorded\x1b[0m');
console.log(`   ${host.audit.all().length} audit events, ${host.scheduler.runHistory().filter((r) => r.event === 'finished').length} finished runs, ${host.messages.allEnvelopes().length} messages, ${host.memory.factsIn('project', 'default').length} project facts.`);
console.log(`   Nothing above lives in a prompt. Reopen ${path.relative(process.cwd(), dir)} and it is all still there.`);
