import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./shared-file-worker.py', import.meta.url));

/** All agent-visible file writes use this host-only transaction process. */
export class SharedFileService {
  constructor({ workspace, state_dir = `${workspace}.transactions`, python = process.env.BETTER_BOTS_PYTHON ?? 'python3', audit = null }) {
    fs.mkdirSync(workspace, { recursive: true });
    this.workspace = fs.realpathSync(workspace);
    fs.mkdirSync(state_dir, { recursive: true, mode: 0o700 });
    this.state_dir = fs.realpathSync(state_dir);
    if (this.state_dir === this.workspace || this.state_dir.startsWith(this.workspace + path.sep)) throw new Error('transaction state must be outside the sandbox workspace');
    for (const created of [this.workspace, this.state_dir]) {
      const fd = fs.openSync(path.dirname(created), 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    this.python = python;
    this.audit = audit;
  }

  execute(actor, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-B', worker], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-1000); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`file transaction interrupted (${code}); retry with the same operation_id`));
        try {
          const result = JSON.parse(output);
          this.audit?.record('file.transaction', { agent_id: actor, action: input.action, path: input.path, operation_id: input.operation_id, ok: result.ok, revision: result.revision, error: result.error, duplicate: result.duplicate });
          delete result.fingerprint;
          resolve(result);
        } catch { reject(new Error(`invalid transaction response: ${error}`)); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ ...input, workspace: this.workspace, state_dir: this.state_dir, actor }));
    });
  }
}
