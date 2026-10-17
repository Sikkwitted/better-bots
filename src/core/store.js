import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Durable operational state belongs in the host, not in a prompt.
// These two primitives are the whole storage engine. Which engine matters far
// less than keeping the stores separate.

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Append-only record log. Used for transcripts, inboxes, memory shards, and audit. */
export class JsonlLog {
  constructor(file, { validate = null } = {}) {
    this.file = path.resolve(file);
    this.validate = validate;
    ensureDir(path.dirname(this.file));
  }

  #bytes() {
    try { return fs.readFileSync(this.file); }
    catch (error) { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; }
  }

  #needsBoundary() {
    let fd;
    try { fd = fs.openSync(this.file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    try {
      const size = fs.fstatSync(fd).size;
      if (!size) return false;
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 10;
    } finally { fs.closeSync(fd); }
  }

  /** A separate atomic document: reporting cannot recurse through a damaged log. */
  #report(bytes, start, line, error, terminated) {
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    const id = createHash('sha256').update(JSON.stringify([this.file, start, fingerprint])).digest('hex');
    const dir = `${this.file}.corruption`;
    const reportFile = path.join(dir, `${id}.json`);
    const report = { id, source: this.file, line, byte_start: start, byte_end: start + bytes.length,
      fingerprint, error, unterminated_when_detected: !terminated, raw_base64: bytes.toString('base64'),
      status: 'reconciliation_required', detected_at: new Date().toISOString() };
    const doc = new JsonDoc(reportFile);
    // Check by reading, so permission/I/O failures never become "not found".
    try {
      const existing = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      if (existing.id !== id || existing.fingerprint !== fingerprint || existing.raw_base64 !== report.raw_base64) throw new Error('Corruption report evidence does not match its source fragment');
    }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      doc.write(report);
      syncDirectory(path.dirname(this.file));
    }
    return { ...report, report_file: reportFile, raw_base64: undefined };
  }

  /** Byte offsets and fatal UTF-8 decoding keep invalid encoding distinguishable. */
  #scan(data, baseOffset = 0, firstLine = 1) {
    const records = [], corruption = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let start = 0, line = firstLine;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline === -1 ? data.length : newline;
      const bytes = data.subarray(start, end);
      let error = null, record;
      try {
        const text = decoder.decode(bytes);
        if (text.trim()) {
          record = JSON.parse(text);
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Log record must be an object');
          if (this.validate && !this.validate(record)) throw new Error('Log record does not match its store schema');
        }
      } catch (err) { error = err instanceof SyntaxError ? 'Malformed JSON record' : err.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? 'Invalid UTF-8 record' : err.message; }
      if (error) corruption.push(this.#report(bytes, baseOffset + start, line, error, newline !== -1));
      else if (record !== undefined) records.push(record);
      start = end + 1; line++;
    }
    return { records, corruption };
  }

  append(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || (this.validate && !this.validate(record))) throw new TypeError('Invalid log record');
    const serialized = JSON.stringify(record);
    let prefix = '';
    if (this.#needsBoundary()) {
      // Preserve an incomplete trailing record before delimiting it. A crash
      // before the delimiter repeats only the report check; after it, no repair
      // is needed. No existing byte is replaced or truncated.
      this.#scan(this.#bytes());
      prefix = '\n';
    }
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeFileSync(fd, `${prefix}${serialized}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(this.file));
    return record;
  }

  readWithDiagnostics() { return this.#scan(this.#bytes()); }
  readAll() { return this.readWithDiagnostics().records; }

  /** Append-only cursor. Maintenance must replace logs atomically, never rewrite their prefix. */
  readIncremental(cursor = null) {
    let fd;
    try { fd = fs.openSync(this.file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return { records: [], cursor: null, reset: true }; throw error; }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      const identity = `${stat.dev}:${stat.ino}`;
      const signature = `${stat.mtimeNs}:${stat.ctimeNs}`;
      const size = Number(stat.size);
      const fingerprint = end => {
        const buffer = Buffer.alloc(Math.min(64 * 1024, end));
        if (fs.readSync(fd, buffer, 0, buffer.length, end - buffer.length) !== buffer.length) throw new Error('Log changed during read');
        return createHash('sha256').update(buffer).digest('hex');
      };
      const reset = !cursor || cursor.identity !== identity || size < cursor.offset
        || (size === cursor.offset && signature !== cursor.signature) || cursor.partial;
      const changedBoundary = !reset && size > cursor.offset && fingerprint(cursor.offset) !== cursor.boundary;
      const reload = reset || changedBoundary;
      const offset = reload ? 0 : cursor.offset;
      const line = reload ? 1 : cursor.line;
      const bytes = Buffer.alloc(size - offset);
      let read = 0;
      while (read < bytes.length) {
        const n = fs.readSync(fd, bytes, read, bytes.length - read, offset + read);
        if (!n) throw new Error('Log changed during read');
        read += n;
      }
      const { records, corruption } = this.#scan(bytes, offset, line);
      let lines = 0;
      for (const byte of bytes) if (byte === 10) lines++;
      return { records, corruption, reset: reload, cursor: { identity, signature, offset: size, line: line + lines,
        boundary: !bytes.length && !reload ? cursor.boundary : fingerprint(size),
        partial: bytes.length > 0 && bytes.at(-1) !== 10 } };
    } finally { fs.closeSync(fd); }
  }

  tail(n) {
    if (n == null) return this.readAll();
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid log tail size');
    if (!n) return [];
    let fd;
    try { fd = fs.openSync(this.file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    try {
      let offset = fs.fstatSync(fd).size;
      let bytes = Buffer.alloc(0);
      for (;;) {
        const count = Math.min(offset, 64 * 1024);
        offset -= count;
        const chunk = Buffer.alloc(count);
        if (fs.readSync(fd, chunk, 0, count, offset) !== count) return this.readAll().slice(-n);
        bytes = Buffer.concat([chunk, bytes]);
        const start = offset ? bytes.indexOf(10) + 1 : 0;
        if (offset && !start) continue;
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
          const records = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
          if (records.some(record => !record || typeof record !== 'object' || Array.isArray(record)
            || (this.validate && !this.validate(record)))) throw new Error('Invalid record');
          if (records.length >= n || !offset) return records.slice(-n);
        } catch {
          // A damaged suffix uses the full scanner so its exact line/byte evidence survives.
          return this.readAll().slice(-n);
        }
      }
    } finally { fs.closeSync(fd); }
  }
}

// Only diagnostics are cached, not records or source bytes. Metadata changes
// invalidate a scan; repeated UI refreshes need not parse every private history.
const diagnosticScans = new Map();

/** Inspect only host-owned logs, never agent workspace files or symlink targets. */
export function logDiagnostics(root) {
  const files = [];
  const reports = new Set();
  const visit = (entry) => {
    let stat;
    try { stat = fs.lstatSync(entry); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (entry.endsWith('.jsonl.corruption')) { reports.add(entry); return; }
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
    } else if (entry.endsWith('.jsonl')) files.push(entry);
  };
  for (const owned of ['audit.jsonl', 'audit.jsonl.corruption', 'results.jsonl', 'results.jsonl.corruption', 'agents', 'rooms', 'runs', 'messages', 'memory']) visit(path.join(root, owned));
  const found = new Map();
  for (const file of files) {
    const stat = fs.statSync(file, { bigint: true });
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    let scan = diagnosticScans.get(file);
    if (scan?.signature !== signature) {
      const update = new JsonlLog(file).readIncremental(scan?.cursor);
      scan = { signature, cursor: update.cursor,
        issues: [...(update.reset ? [] : scan?.issues ?? []), ...(update.corruption ?? [])] };
      if (diagnosticScans.size >= 512) diagnosticScans.delete(diagnosticScans.keys().next().value);
      diagnosticScans.set(file, scan);
    }
    for (const issue of scan.issues) found.set(issue.id, issue);
    reports.add(`${file}.corruption`);
  }
  for (const dir of reports) {
    let names;
    try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const report_file = path.join(dir, name);
      const { raw_base64, ...issue } = JSON.parse(fs.readFileSync(report_file, 'utf8'));
      found.set(issue.id, { ...issue, report_file });
    }
  }
  return [...found.values()];
}

/** Mutable JSON document with atomic replace, for indexes and service state. */
export class JsonDoc {
  constructor(file, initial = {}, { mode = 0o666 } = {}) {
    this.file = file;
    this.initial = initial;
    this.mode = mode;
    ensureDir(path.dirname(file));
  }

  read() {
    if (!fs.existsSync(this.file)) return structuredClone(this.initial);
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  write(value) {
    // A name per write: the CLI and the server may write one document at once.
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', this.mode);
      try {
        fs.writeFileSync(fd, JSON.stringify(value, null, 2));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw error;
    }
    syncDirectory(path.dirname(this.file));
    return value;
  }

  update(fn) {
    const current = this.read();
    const next = fn(current) ?? current;
    return this.write(next);
  }
}
