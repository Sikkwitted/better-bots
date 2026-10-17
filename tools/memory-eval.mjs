#!/usr/bin/env node
// Does memory actually come back? Seed two throwaway banks with known facts, ask
// paraphrased questions that share few or no words with the facts, and score:
//
//   recall@3        the right fact is in the top three for bank A's questions
//   cross-bank hits bank B's questions asked of bank A must find nothing of B's
//
//   HINDSIGHT_URL=http://127.0.0.1:8888 HINDSIGHT_API_KEY=... node tools/memory-eval.mjs
//
// Live only: it costs one extraction call per seeded fact. Cleans up after itself.

import { HindsightEngine } from '../src/services/memory-engine.js';
import { randomUUID } from 'node:crypto';

const engine = new HindsightEngine({ url: process.env.HINDSIGHT_URL, api_key: process.env.HINDSIGHT_API_KEY });
// Never reuse or delete a bank another evaluation or operator might own.
const evaluationId = randomUUID();
const A = `eval-${evaluationId}-a`, B = `eval-${evaluationId}-b`;

// [fact, question, keyword that must appear in the returned text]
const SEED_A = [
  ['Avery decided the mobile launch is Friday, September 4, 2026.', 'when do we ship the phone app?', 'September 4'],
  ['The staging TLS certificate expires on October 14 and Bo owns renewing it.', 'who is on the hook for the HTTPS renewal?', 'Bo'],
  ['Scout submits the app to the store review; the review is Tuesday, September 8.', 'which day is the marketplace listing checked?', 'September 8'],
  ['Avery prefers one-line answers and dislikes being asked the same question twice.', 'how does the boss like replies?', 'one-line'],
  ['The database runs PostgreSQL 16 with pgvector on the VPS.', 'what engine stores our vectors?', 'PostgreSQL'],
  ['Nightly backups run at 04:15 UTC and keep fourteen days.', 'how long do we retain the snapshots?', 'fourteen'],
  ['The deploy unit refuses to start while the test suite is red.', 'why would the service not come up after a bad commit?', 'suite'],
  ['Max is the verifier; Scout is the researcher.', 'who does the fact-checking?', 'Max'],
  ['The console is reached over an SSH tunnel to port 4173.', 'how do I get to the web UI?', '4173'],
  ['Agents are not given payment tools or money.', 'can a bot buy something?', 'payment'],
  ['Rooms are bounded to six members, three rounds, ten messages.', 'what is the cap on a meeting?', 'six'],
  ['The spare VPS at 192.0.2.16 is a cold standby with no job.', 'what is the second server for?', 'standby'],
];
const SEED_B = [
  ['The vault code is kept in the red safe in the hallway.', 'where is the vault code?', 'safe'],
  ['Bo\'s private plan is to refactor the scheduler in October.', 'what is Bo planning privately?', 'scheduler'],
  ['The user\'s home address is on file with the courier.', 'where does the courier deliver?', 'courier'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(bank, rows) {
  await engine.ensureBank(bank, { name: bank });
  let n = 0;
  for (const [fact] of rows) {
    const receipt = await engine.retain(bank, { content: fact, context: 'Synthetic evaluation fixture; not a real user fact', document_id: `seed-${n += 1}` });
    if (receipt?.success !== true || receipt?.async) throw new Error(`No completed retention receipt for ${bank}`);
  }
}

async function ask(bank, question) {
  const results = await engine.recall(bank, { query: question, max_tokens: 400, budget: 'low' });
  return results.slice(0, 3).map((r) => r.text);
}

try {
  console.log(`seeding ${SEED_A.length} + ${SEED_B.length} facts…`);
  await seed(A, SEED_A);
  await seed(B, SEED_B);
  await sleep(2000);

  let hit = 0;
  const misses = [];
  for (const [fact, question, keyword] of SEED_A) {
    const top3 = await ask(A, question);
    const ok = top3.some((t) => t.toLowerCase().includes(keyword.toLowerCase()));
    if (ok) hit += 1; else misses.push({ question, keyword, fact, top3 });
  }
  console.log(`recall@3: ${hit}/${SEED_A.length} (${Math.round((hit / SEED_A.length) * 100)}%)`);
  for (const m of misses) console.log(`  miss: "${m.question}" -> wanted "${m.keyword}"\n        got: ${m.top3.map((t) => t.slice(0, 80)).join(' | ') || '(nothing)'}`);

  let leaks = 0;
  for (const [, question, keyword] of SEED_B) {
    const top3 = await ask(A, question);
    if (top3.some((t) => t.toLowerCase().includes(keyword.toLowerCase()))) { leaks += 1; console.log(`  LEAK: bank ${A} answered "${question}"`); }
  }
  console.log(`cross-bank hits: ${leaks}/${SEED_B.length} (must be 0)`);

  const pass = leaks === 0 && hit / SEED_A.length >= 0.75;
  console.log(pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  for (const bank of [A, B]) {
    try {
      const response = await fetch(`${engine.url}/v1/default/banks/${bank}`, {
        method: 'DELETE', signal: AbortSignal.timeout(4_000),
        headers: { authorization: `Bearer ${engine.api_key}` },
      });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error(`Could not remove evaluation bank ${bank}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
