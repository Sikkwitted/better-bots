// The default memory engine: SQLite built into Node, so a fresh install has
// ranked recall with nothing else to set up. It speaks the same interface as
// HindsightEngine (bankId, ensureBank, retain, recall, health), so MemoryService
// and the retention journal do not know which one they have.
//
// What it does not do is call a model on every retained passage. Hindsight
// extracts facts at write time; here a passage is stored as written and indexed
// for full-text search (BM25, Porter stemming so "renewal" finds "renewing"),
// and the slow work — deciding what is settled — happens in the verified
// consolidation pass (memory-consolidation.js), once per bank per day.
//
// One bank per memory scope, as in Hindsight: every query names exactly one bank,
// and the host decides which banks a caller may name.

import fs from 'node:fs';
import path from 'node:path';

// Words that match almost everything and rank nothing.
const STOP = new Set(('a an and are as at be but by can did do does for from had has have he her his how i if in into is it '
  + 'its me my no not of on or our she so than that the their them then there these they this to too us was we were what '
  + 'when where which who whom why will with you your').split(' '));

// Secrets do not belong in memory. Hindsight's Memory Defense redacts them; this
// does the same for the shapes that turn up in chats.
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,                // OpenAI/Stripe-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,                       // Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                      // GitHub tokens
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,                     // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                                // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,                          // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:bearer|password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S{6,}/gi,
];

export function redactSecrets(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/** A free-text query as an FTS5 expression: quoted terms, ORed, so no input is a syntax error. */
export function ftsQuery(query) {
  const terms = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((t) => t.length > 1 && !STOP.has(t))
    .slice(0, 24);
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}

export class SqliteEngine {
  constructor({ file, DatabaseSync }) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.name = 'sqlite';
    this.supportsAsyncRetention = false;
    this.db = new DatabaseSync(file);
    // The console server and the CLI open the same file; WAL lets them share it.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS passages (
        rowid INTEGER PRIMARY KEY,
        bank TEXT NOT NULL,
        document_id TEXT NOT NULL,
        content TEXT NOT NULL,
        context TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        mentioned_at TEXT,
        UNIQUE (bank, document_id)
      );
      CREATE INDEX IF NOT EXISTS passages_bank ON passages (bank, mentioned_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(content, context, tokenize = 'porter unicode61');
    `);
    this.upsert = this.db.prepare(`INSERT INTO passages (bank, document_id, content, context, metadata, mentioned_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (bank, document_id) DO UPDATE SET content = excluded.content, context = excluded.context,
        metadata = excluded.metadata, mentioned_at = excluded.mentioned_at
      RETURNING rowid`);
    this.dropFts = this.db.prepare('DELETE FROM passages_fts WHERE rowid = ?');
    this.addFts = this.db.prepare('INSERT INTO passages_fts (rowid, content, context) VALUES (?, ?, ?)');
    this.search = this.db.prepare(`SELECT p.rowid AS id, p.content, p.metadata, p.mentioned_at, bm25(passages_fts) AS rank
      FROM passages_fts JOIN passages p ON p.rowid = passages_fts.rowid
      WHERE passages_fts MATCH ? AND p.bank = ? ORDER BY rank LIMIT ?`);
    this.recent = this.db.prepare(`SELECT rowid AS id, content, metadata, mentioned_at FROM passages
      WHERE bank = ? ORDER BY mentioned_at DESC, rowid DESC LIMIT ?`);
  }

  /** Open the engine, or null on a Node without node:sqlite (before 22.13 it needed a flag). */
  static open({ file }) {
    let sqlite;
    try { sqlite = process.getBuiltinModule?.('node:sqlite'); } catch { sqlite = null; }
    if (!sqlite?.DatabaseSync) return null;
    return new SqliteEngine({ file, DatabaseSync: sqlite.DatabaseSync });
  }

  static bankId(scope, ownerId) {
    return `${scope}-${String(ownerId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  }

  async health() {
    this.db.prepare('SELECT 1').get();
    return { status: 'healthy', database: 'connected', engine: 'sqlite' };
  }

  async ensureBank() { return true; }

  /** Idempotent by document_id, like Hindsight: replaying the files never duplicates a passage. */
  async retain(bank, { content, context = null, timestamp = null, metadata = {}, document_id = null }) {
    const clean = redactSecrets(content);
    const meta = Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
    const docId = document_id ?? `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { rowid } = this.upsert.get(bank, docId, clean, context, JSON.stringify(meta), timestamp ?? new Date().toISOString());
      this.dropFts.run(rowid);
      this.addFts.run(rowid, clean, context ?? '');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { success: true, async: false, engine: 'sqlite', document_id: docId };
  }

  /**
   * Ranked passages for a query within a token budget. BM25 decides the order;
   * among near-equal matches the newer one wins. A query with no usable words
   * returns the most recent passages, so recall still has something to show.
   */
  async recall(bank, { query, max_tokens = 600 }) {
    const budget = Math.max(256, max_tokens * 4);
    const expr = ftsQuery(query);
    const rows = expr ? this.search.all(expr, bank, 40) : this.recent.all(bank, 10);
    const out = [];
    let used = 0;
    for (const row of rows) {
      if (used + row.content.length > budget && out.length) break;
      used += row.content.length;
      out.push({ id: String(row.id), text: row.content, type: null, metadata: JSON.parse(row.metadata || '{}'), mentioned_at: row.mentioned_at ?? null, occurred_start: null });
    }
    return out;
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}
