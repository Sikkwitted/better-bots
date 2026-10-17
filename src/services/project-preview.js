import http from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { JsonDoc } from '../core/store.js';
import { HostError, newId } from '../core/util.js';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' };
const LIMIT = 8 * 1024 * 1024;
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some((p) => !p || p === '.' || p === '..')) throw new HostError('invalid_path', 'use a contained relative path');
  return value;
}

/** Static build snapshots: no arbitrary localhost proxy and no child server to orphan. */
export class ProjectPreviewService {
  constructor({ dir, files, scheduler, audit, clock, fetchImpl = fetch }) {
    Object.assign(this, { files, scheduler, audit, clock, fetchImpl });
    this.doc = new JsonDoc(path.join(dir, 'previews.json'), { previews: {} });
    this.live = new Map();
    this.doc.update((state) => {
      for (const item of Object.values(state.previews)) if (['starting', 'running', 'stopping'].includes(item.status)) {
        item.status = 'stopped'; item.stop_reason = 'host_restarted'; item.stopped_at = clock.iso();
      }
      return state;
    });
  }

  assertActive(run) {
    if (run.signal?.aborted || this.scheduler.isRunCancelled(run) || this.scheduler.isAutomationCancelled(run.payload.automation_id)) throw new HostError('run_cancelled', 'cancelled work cannot create a preview or fetch dependencies');
  }

  async fetchDependency({ agent, input, run }) {
    this.assertActive(run);
    const url = new URL(input.url);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.tgz')) throw new HostError('dependency_source_refused', 'only exact HTTPS npm registry tarballs are supported');
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(input.integrity)) throw new HostError('integrity_required', 'supply the package publisher SHA-512 integrity value');
    const destination = `agents/${agent.id}/${relative(input.path)}`;
    const signals = [AbortSignal.timeout(30000), ...(run.signal?.native ? [run.signal.native] : [])];
    const response = await this.fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.any(signals) });
    if (!response.ok) throw new HostError('dependency_fetch_failed', `registry returned HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMIT) throw new HostError('dependency_too_large', 'dependency exceeds 8 MiB');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks), actual = createHash('sha512').update(bytes).digest(), expected = Buffer.from(input.integrity.slice(7), 'base64');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HostError('integrity_mismatch', 'download does not match approved dependency integrity');
    this.assertActive(run);
    const receipt = await this.files.execute(agent.id, { action: 'write', path: destination,
      content: bytes.toString('base64'), operation_id: `dependency_${run.id}_${actual.toString('hex').slice(0, 20)}` });
    if (!receipt.ok) return receipt;
    this.audit.record('dependency.fetched', { run_id: run.id, agent_id: agent.id, url: url.href, integrity: input.integrity, bytes: size, path: destination });
    return { ...receipt, encoding: 'base64', integrity: input.integrity, downloaded_bytes: size,
      note: 'Decode this file with base64 -d inside SandboxRunCommand, then extract/use it inside your agent directory. No package scripts were executed.' };
  }

  async start({ agent, input, run }) {
    this.assertActive(run);
    if (this.live.size >= 4) throw new HostError('preview_capacity', 'four previews are already open; stop one before creating another');
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100 || !input.files.includes('index.html')) throw new HostError('invalid_preview_files', 'list 1–100 static build files including index.html');
    const root = relative(input.directory), snapshot = new Map(); let size = 0;
    for (const file of new Set(input.files)) {
      relative(file);
      const type = TYPES[path.extname(file)];
      if (!type) throw new HostError('unsupported_preview_file', 'preview supports HTML, JS, CSS, SVG, JSON and text assets');
      const result = await this.files.execute(agent.id, { action: 'read', path: `agents/${agent.id}/${root}/${file}`, max_bytes: LIMIT - size });
      if (!result.ok) throw new HostError('preview_read_failed', `${file}: ${result.error}`);
      size += Buffer.byteLength(result.content);
      if (size > LIMIT) throw new HostError('preview_too_large', 'static preview exceeds 8 MiB');
      snapshot.set(file, { content: result.content, type, revision: result.revision });
    }
    this.assertActive(run);
    if (this.live.size >= 4) throw new HostError('preview_capacity', 'four previews are already open; stop one before creating another');
    const id = newId('preview');
    const record = { id, agent_id: agent.id, run_id: run.id, automation_id: run.payload.automation_id ?? null,
      directory: root, files: [...snapshot].map(([name, f]) => ({ name, revision: f.revision })),
      status: 'starting', host_pid: process.pid, created_at: this.clock.iso() };
    this.doc.update((s) => { s.previews[id] = record; return s; });
    const requests = [];
    const server = http.createServer((req, res) => {
      let name;
      try { name = decodeURIComponent(new URL(req.url, 'http://preview.invalid').pathname); } catch { res.writeHead(400).end(); return; }
      const prefix = `/${id}/`;
      const item = name.startsWith(prefix) && snapshot.get(name.slice(prefix.length) || 'index.html');
      const status = item && ['GET', 'HEAD'].includes(req.method) ? 200 : 404;
      requests.push({ path: name.slice(0, 200), status, at: this.clock.iso() }); if (requests.length > 20) requests.shift();
      res.writeHead(status, { 'Content-Type': item?.type ?? 'text/plain', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(req.method === 'HEAD' ? undefined : status === 200 ? item.content : 'Not found');
    });
    this.live.set(id, { server, requests });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      server.unref();
      this.assertActive(run);
      const port = server.address().port;
      Object.assign(record, { status: 'running', url: `http://127.0.0.1:${port}/${id}/`, docker_url: `http://host.docker.internal:${port}/${id}/` });
      this.doc.update((s) => { s.previews[id] = record; return s; });
      this.audit.record('preview.started', { preview_id: id, agent_id: agent.id, run_id: run.id, files: record.files });
      return { ok: true, ...record, note: 'Immutable static build snapshot. Start a new preview after a fix. Stop it explicitly or cancel the originating run. No arbitrary backend server or proxy is exposed.' };
    } catch (error) { await this.stop(id, 'start_failed'); throw error; }
  }

  list() { return Object.values(this.doc.read().previews).map((p) => ({ ...p, requests: this.live.get(p.id)?.requests ?? [] })); }

  stop(id, reason = 'user_stopped', agentId = null) {
    const record = this.doc.read().previews[id];
    if (!record) throw new HostError('preview_not_found', 'unknown preview');
    if (agentId && record.agent_id !== agentId) throw new HostError('preview_not_owned', 'only the owning agent may stop this preview');
    const live = this.live.get(id);
    if (live?.stopping) return live.stopping;
    this.doc.update((s) => { Object.assign(s.previews[id], { status: 'stopped', stop_reason: reason, stopped_at: this.clock.iso() }); return s; });
    const stopped = new Promise((resolve) => {
      if (!live) return resolve();
      live.server.close(() => resolve()); live.server.closeAllConnections();
    }).then(() => {
      this.live.delete(id);
      this.audit.record('preview.stopped', { preview_id: id, agent_id: record.agent_id, run_id: record.run_id, reason });
      return { ok: true, preview_id: id, status: 'stopped' };
    });
    if (live) live.stopping = stopped;
    return stopped;
  }

  stopCancelled() {
    const runs = this.scheduler.durableRuns();
    return Promise.all(this.list().filter((p) => p.status === 'running' || p.status === 'starting').filter((p) => {
      const run = runs.find((r) => r.id === p.run_id);
      return run && (this.scheduler.isRunCancelled(run) || this.scheduler.isAutomationCancelled(run.payload.automation_id));
    }).map((p) => this.stop(p.id, 'work_cancelled')));
  }

  close() { return Promise.all([...this.live.keys()].map((id) => this.stop(id, 'host_shutdown'))); }
}

export function projectTools(service) {
  return [
    { name: 'FetchDependency', description: 'Fetch an exact npm registry tarball with publisher SHA-512 integrity into a base64 file in your agent directory. Requires exact-call approval. Decode and use it through sandbox tools; no install scripts run here.', side_effect: 'Downloads approved public dependency bytes and writes a sandbox file.',
      permission: { action: 'external.fetch_dependency', target: (i) => JSON.stringify(i) },
      input_schema: { type: 'object', required: ['url', 'integrity', 'path'], properties: { url: { type: 'string' }, integrity: { type: 'string' }, path: { type: 'string' } } },
      handler: (ctx) => service.fetchDependency(ctx) },
    { name: 'StartPreview', description: 'Serve an immutable static build snapshot. List HTML/JS/CSS/SVG/JSON/text files including index.html, relative to directory in your own agent folder. Returns loopback and Docker-browser URLs. Survives turns until stopped, cancelled, or host restart.', side_effect: 'Starts a loopback-only static preview server with bounded files and request logs.',
      permission: { action: 'sandbox.run_command', target: (i) => JSON.stringify(i) },
      input_schema: { type: 'object', required: ['directory', 'files'], properties: { directory: { type: 'string' }, files: { type: 'array' } } },
      handler: (ctx) => service.start(ctx) },
    { name: 'StopPreview', description: 'Stop one of your previews and release its listener.', side_effect: 'Closes the owned preview listener.',
      permission: { action: 'sandbox.run_command', target: (i) => i.preview_id },
      input_schema: { type: 'object', required: ['preview_id'], properties: { preview_id: { type: 'string' } } },
      handler: ({ agent, input }) => service.stop(input.preview_id, 'agent_stopped', agent.id) },
  ];
}
