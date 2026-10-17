#!/usr/bin/env node
// Rebuild the memory engine's banks from the files that are the source of truth.
//
//   node tools/replay-memory.mjs [--dir /var/lib/better-bots] [--dry-run]
//
// The engine is the one the host would use: SQLite in the data folder by default,
// or Hindsight when HINDSIGHT_URL (and HINDSIGHT_API_KEY) are set.
//
// Two sources: every fact in the memory JSONL files (except the turn-log lines,
// which are one-sentence stand-ins for exchanges), and every user exchange in
// each agent's transcript. Each item carries a stable document_id, so running
// this twice replaces rather than duplicates. Safe to run while better-bots is up.

import fs from 'node:fs';
import path from 'node:path';
import { JsonlLog } from '../src/core/store.js';
import { HindsightEngine, engineFromEnv } from '../src/services/memory-engine.js';

const args = process.argv.slice(2);
const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : (process.env.BETTER_BOTS_DIR ?? '/var/lib/better-bots');
const dryRun = args.includes('--dry-run');
const engine = dryRun ? null : engineFromEnv(process.env, { dir });
if (!dryRun && !engine) { console.error('no memory engine: this Node has no node:sqlite and HINDSIGHT_URL is unset'); process.exit(1); }

const registryFile = path.join(dir, 'agents', 'registry.json');
const registry = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : {};
const nameOf = (id) => registry?.agents?.[id]?.profile?.name ?? Object.values(registry?.agents ?? {}).find((a) => a.id === id)?.profile?.name ?? id;

const items = [];

// 1. Facts.
const factFiles = [];
const agentsDir = path.join(dir, 'agents');
if (fs.existsSync(agentsDir)) {
  for (const id of fs.readdirSync(agentsDir)) {
    const f = path.join(agentsDir, id, 'memory.jsonl');
    if (fs.existsSync(f)) factFiles.push(f);
  }
}
const sharedDir = path.join(dir, 'memory');
if (fs.existsSync(sharedDir)) {
  // Only the scope folders: memory/ also holds the journal and the SQLite file.
  for (const scope of fs.readdirSync(sharedDir).filter((name) => ['user', 'project'].includes(name) && fs.statSync(path.join(sharedDir, name)).isDirectory())) {
    for (const owner of fs.readdirSync(path.join(sharedDir, scope))) {
      for (const f of fs.readdirSync(path.join(sharedDir, scope, owner))) {
        if (f.startsWith('shard-') && f.endsWith('.jsonl')) factFiles.push(path.join(sharedDir, scope, owner, f));
      }
    }
  }
}
for (const file of factFiles) {
  for (const fact of new JsonlLog(file).readAll()) {
    if (fact.source === 'turn_log') continue;
    items.push({
      bank: HindsightEngine.bankId(fact.owner_scope, fact.owner_id),
      content: fact.text,
      context: `${fact.owner_scope} memory, ${fact.tier} tier`,
      timestamp: fact.learned_at,
      document_id: `fact-${fact.id}`,
      metadata: {
        fact_id: fact.id, tier: fact.tier, writer_agent_id: fact.writer_agent_id, source: fact.source, owner_scope: fact.owner_scope,
        ...(fact.ref?.run_id ? { run_id: fact.ref.run_id } : {}),
      },
    });
  }
}

// 2. Exchanges: a user message and the agent text that answered it.
if (fs.existsSync(agentsDir)) {
  for (const id of fs.readdirSync(agentsDir)) {
    const f = path.join(agentsDir, id, 'transcript.jsonl');
    if (!fs.existsSync(f)) continue;
    const me = nameOf(id);
    let current = null;
    let n = 0;
    const flush = () => {
      if (current && current.answer.length) {
        n += 1;
        items.push({
          bank: HindsightEngine.bankId('agent', id),
          content: `The user asked ${me}: ${current.ask}\n${me} answered: ${current.answer.join('\n')}`,
          context: 'conversation with the user',
          timestamp: current.at,
          document_id: `exchange-${id}-${n}`,
          metadata: { tier: 'log', writer_agent_id: id, source: 'exchange', owner_scope: 'agent', ...(current.run_id ? { run_id: current.run_id } : {}) },
        });
      }
      current = null;
    };
    for (const e of new JsonlLog(f).readAll()) {
      if (e.kind === 'user_message') { flush(); current = { ask: e.text, answer: [], at: e.at, run_id: null }; }
      else if (e.kind === 'agent_text' && current) { current.answer.push(e.text); current.run_id ??= e.run_id ?? null; }
      else if (e.kind === 'peer_message_in') flush();
    }
    flush();
  }
}

const byBank = items.reduce((m, i) => m.set(i.bank, (m.get(i.bank) ?? 0) + 1), new Map());
console.log(`${items.length} item(s) from ${dir}:`);
for (const [bank, count] of byBank) console.log(`  ${bank}: ${count}`);
if (dryRun) process.exit(0);

let ok = 0;
for (const { bank, ...item } of items) {
  try {
    await engine.retain(bank, item);
    ok += 1;
  } catch (err) {
    console.error(`  failed ${item.document_id}: ${err.message}`);
  }
}
console.log(`retained ${ok}/${items.length}`);
process.exit(ok === items.length ? 0 : 1);
