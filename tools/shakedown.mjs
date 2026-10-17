#!/usr/bin/env node
// A set of acceptance checks, run against a LIVE host with a real
// model — the test suite proves these with a scripted adapter; this proves the
// model actually behaves inside the contracts. Costs a handful of turns.
//
//   BETTER_BOTS_TOKEN=<console token> node tools/shakedown.mjs [--url http://127.0.0.1:4173]
//
// The token is the one in <data dir>/console-token (or the one the host was
// started with). Creates two throwaway agents (Shake-A, Shake-B), drives: a user
// turn, a peer chain, a room, an approval card (denied), a stuck-agent report,
// and a lead result. Every check is an observable outcome in state, transcripts,
// or audit. Cleans up the agents at the end. Exit 0 only if every check passed.

const url = (process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:4173').replace(/\/$/, '');
const TIMEOUT = 180_000;
const token = process.env.BETTER_BOTS_TOKEN;
if (!token) { console.error('Set BETTER_BOTS_TOKEN to the console token; the host refuses requests without it.'); process.exit(2); }

async function api(method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transcript = async (id) => (await api('GET', `/api/transcript?agent_id=${id}`)).entries;
async function until(fn, { tries = 40, every = 1500, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i += 1) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}

let A, B;
try {
  const state0 = await api('GET', '/api/state');
  console.log(`host: ${url} | live: ${state0.live} | model: ${state0.model}`);
  if (!state0.live) { console.log('not live: this needs a real model'); process.exit(2); }

  A = await api('POST', '/api/agents', { name: 'Shake-A', role: 'coordinator', prompt: 'You coordinate. Keep replies to one or two lines. Follow instructions literally.', color: '#51FFCD' });
  B = await api('POST', '/api/agents', { name: 'Shake-B', role: 'worker', prompt: 'You do small tasks. Keep replies to one line.', color: '#37FF5D' });
  console.log(`agents: ${A.id} ${B.id}\n`);

  // 1. A user turn returns a visible result in the user lane.
  const t1 = await api('POST', '/api/ask', { agent_id: A.id, text: 'Say exactly: ready.' });
  check('user turn completes with visible text', t1.result?.status === 'completed' && /ready/i.test(t1.result?.text ?? ''), t1.result?.text?.slice(0, 60));
  check('the run recorded its token usage', (t1.result?.usage?.input_tokens ?? 0) > 0, `${t1.result?.usage?.input_tokens} in / ${t1.result?.usage?.output_tokens} out`);

  // 2. Peer chain: A messages B via the tool; B wakes later; A did not wait.
  const t2 = await api('POST', '/api/ask', { agent_id: A.id, text: `Use SendToAgent to send agent ${B.id} this exact message: "Please reply with the word pong." Then tell me only that you sent it. Do not wait for a reply.` });
  const sent = (t2.result?.tools ?? []).some((t) => t.name === 'SendToAgent');
  check('A called SendToAgent and returned without waiting', sent && t2.result.status === 'completed', t2.result?.text?.slice(0, 80));
  const bIn = await until(async () => (await transcript(B.id)).find((e) => e.kind === 'peer_message_in'), { what: 'B to receive the message' });
  check('B received the message on a later wake (peer_message_in)', Boolean(bIn), bIn?.text?.slice(0, 60));
  const bReply = await until(async () => (await transcript(B.id)).filter((e) => e.kind === 'agent_text').at(-1), { what: 'B to answer' });
  check('B answered in its own agent-lane run', Boolean(bReply), bReply?.text?.slice(0, 60));

  // 3. Room: bounded, both spoke or passed, transcript exists.
  const room = await api('POST', '/api/rooms', { purpose: 'Shakedown group', member_ids: [A.id, B.id], request: 'Decide in one round: cats or dogs? Each of you say one word and stop.' });
  const r = room.result;
  check('room ran and stopped within bounds', r && r.total_messages <= 10 && r.rounds.length <= 3, `${r?.stop_reason}, ${r?.total_messages} msgs, ${r?.rounds?.length} rounds`);
  check('room transcript is separate and non-empty', (r?.transcript?.length ?? 0) > 0);

  // 4. Approval card: local read is 'ask' by default -> a card appears; deny it; the turn completes honestly.
  await api('POST', '/api/permissions', { zone: 'local', mode: 'ask' });
  const askP = api('POST', '/api/ask', { agent_id: B.id, text: 'Use LocalReadFile to read the file /etc/hostname on the user\'s computer and tell me what it says. If you are refused, say so in one line.' });
  const card = await until(async () => (await api('GET', '/api/state')).pending_approvals.find((p) => p.agent_id === B.id), { tries: 30, every: 1000, what: 'an approval card' });
  check('a local action raised an approval card', Boolean(card), `${card?.action} ${card?.target}`);
  await api('POST', '/api/approve', { request_id: card.id, resolution: 'deny' });
  const t4 = await askP;
  const denied = (t4.result?.tools ?? []).some((t) => t.name === 'LocalReadFile' && /den|block/i.test(t.decision));
  check('denying the card blocked the action and the turn still completed', denied && t4.result.status === 'completed', `${t4.result?.tools?.map((t) => `${t.name}:${t.decision}`).join(',')} | ${t4.result?.text?.slice(0, 60)}`);

  // 5. Stuck-agent report.
  await api('POST', '/api/ask', { agent_id: B.id, text: 'Drill: call ReportBlocked with reason "captcha" and detail "shakedown drill" and ladder ["drill rung"]. Then say "reported".' });
  const blocked = await until(async () => (await api('GET', '/api/state')).blocked.find((b) => b.agent_id === B.id), { tries: 10, every: 1000, what: 'a blocked report' });
  check('ReportBlocked raised a stuck-agent card', Boolean(blocked), blocked?.reason);
  if (blocked) await api('POST', '/api/blocked/resolve', { report_id: blocked.id });
  check('resolving clears it', !(await api('GET', '/api/state')).blocked.some((b) => b.agent_id === B.id));

  // 6. Lead result.
  await api('POST', '/api/agents/lead', { agent_id: A.id });
  const t6 = await api('POST', '/api/ask', { agent_id: A.id, text: 'The work is done: the answer to "cats or dogs" was decided in the room. Call AssembleResult now with a one-line conclusion, one piece of evidence, and one risk.' });
  const assembled = (t6.result?.tools ?? []).some((t) => t.name === 'AssembleResult');
  check('the lead called AssembleResult', assembled, t6.result?.tools?.map((t) => t.name).join(','));

  // Behaviour observable from outside.
  const aT = await transcript(A.id);
  check('A\'s transcript never contains B\'s private user turns', !aT.some((e) => e.kind === 'user_message' && /hostname|captcha/i.test(e.text ?? '')));
} catch (err) {
  check(`aborted: ${err.message}`, false);
} finally {
  for (const agent of [A, B]) if (agent) await api('DELETE', '/api/agents', { agent_id: agent.id }).catch(() => {});
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exit(passed === checks.length ? 0 : 1);
}
