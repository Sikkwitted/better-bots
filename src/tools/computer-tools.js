import fs from 'node:fs';
import path from 'node:path';
import { HostError } from '../core/util.js';
import { randomUUID } from 'node:crypto';
import { SharedFileService } from '../services/shared-file-service.js';
import { SCREEN_ACTIONS } from '../services/desktop-backend.js';

// Two computers, two trust questions.
//
//   sandbox.*  -> the agent's own workspace. Allowed within the workspace.
//   local.*    -> the machine running the Better Bots host, outside the sandbox.
//   screen.*   -> a private desktop window on the SHARED sandbox computer.

function insideWorkspace(workspace, target) {
  const resolved = path.resolve(workspace, target);
  const root = path.resolve(workspace);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

/** A path as the file system will see it: through symlinks, and for a file not yet created, through its folder. */
function realTarget(target) {
  const absolute = path.resolve(target);
  return fs.existsSync(absolute) ? fs.realpathSync(absolute) : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
}

/**
 * The host's own data folder holds provider keys, access tokens and every bot's
 * records. Host-machine tools may reach the shared workspace inside it, and
 * nothing else there, whatever the standing permission says.
 */
export function protectedHostPath({ dataDir, workspace }, target) {
  if (!dataDir || !fs.existsSync(dataDir)) return false;
  let resolved;
  try { resolved = realTarget(target); } catch { return false; }
  const within = (root) => resolved === root || resolved.startsWith(root + path.sep);
  const data = fs.realpathSync(dataDir);
  const shared = workspace && fs.existsSync(workspace) ? fs.realpathSync(workspace) : null;
  return within(data) && !(shared && within(shared));
}

const MAX_LOCAL_READ_BYTES = 10 * 1024 * 1024;

const DATA_DIR_REFUSAL = { ok: false, error: 'host_data_protected', message: 'That path is inside Better Bots’ own data folder, which holds keys and records. Host-machine tools cannot read or write it; use the shared workspace instead.' };

// Shared replacements use compare-and-swap. Field patches compare only the
// fields being changed, so independent writers preserve one another's work.
export function sandboxTools({ workspace, files = new SharedFileService({ workspace }) }) {
  return [
    {
      name: 'SandboxReadFile', description: 'Read sandbox text and its revision. For PDFs use SandboxReadPDF. Missing files return revision "missing". Shared updates use the host transaction tools.',
      side_effect: 'Reads sandbox state; reconciles an interrupted committed file transaction if necessary.',
      permission: { action: 'sandbox.read_file', target: (input) => input.path },
      input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      handler: ({ agent, input }) => files.execute(agent.id, { ...input, action: 'read' }),
    },
    {
      name: 'SandboxWriteFile',
      description: 'Atomically write a sandbox file. Shared files require expected_revision from SandboxReadFile ("missing" to create) and a stable operation_id. Stale writes are rejected. Only you may write agents/<your id>/. Retry an uncertain result with the identical operation_id and inputs.',
      side_effect: 'Host-committed durable file replacement, under an OS lock, with revision validation and receipt.',
      permission: { action: 'sandbox.write_file', target: (input) => input.path },
      input_schema: { type: 'object', required: ['path', 'content'], properties: {
        path: { type: 'string' }, content: { type: 'string' }, expected_revision: { type: 'string' }, operation_id: { type: 'string' },
      } },
      handler: ({ agent, input }) => files.execute(agent.id, {
        ...input, action: 'write', operation_id: input.operation_id ?? (input.path.startsWith(`agents/${agent.id}/`) ? randomUUID() : undefined),
      }),
    },
    {
      name: 'SandboxUpdateJson',
      description: 'Apply explicit field changes to shared JSON under one host transaction. Each change has path (object-key array), expected {exists,value}, and value or delete:true. Parent objects must exist. Only matching fields change; conflicts preserve the entire file. Reuse operation_id on uncertain retries. owner_agent_id records belonging to another agent cannot be changed.',
      side_effect: 'Host-committed, atomic, conflict-checked JSON patch; preserves unrelated records.',
      permission: { action: 'sandbox.write_file', target: (input) => input.path },
      input_schema: { type: 'object', required: ['path', 'operation_id', 'changes'], properties: {
        path: { type: 'string' }, operation_id: { type: 'string' }, changes: { type: 'array' },
      } },
      handler: ({ agent, input }) => files.execute(agent.id, { ...input, action: 'patch' }),
    },
  ];
}

export function localTools({ workspace = null, files = null, dataDir = null } = {}) {
  return [
    {
      name: 'LocalReadFile',
      description: "Read an exact file path on the machine running the Better Bots host, outside the sandbox. With a VPS host this reads the VPS, not the user's Mac. Cannot browse directories or read Better Bots’ own data folder (keys and records). For PDFs use HostReadPDF. Uses the saved local permission.",
      side_effect: "Reads host-machine data outside the agent sandbox.",
      permission: { action: 'local.read_file', target: (input) => input.path },
      input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      handler({ input }) {
        if (protectedHostPath({ dataDir, workspace }, input.path)) return DATA_DIR_REFUSAL;
        if (!fs.existsSync(input.path)) return { ok: false, error: 'not_found', path: input.path };
        // Open the checked file once and read that descriptor, so a link swapped
        // in after the check cannot redirect the read into the data folder.
        let fd;
        try {
          fd = fs.openSync(fs.realpathSync(input.path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          if (process.platform === 'linux' && protectedHostPath({ dataDir, workspace }, fs.realpathSync(`/proc/self/fd/${fd}`))) return DATA_DIR_REFUSAL;
          const stat = fs.fstatSync(fd);
          // A device or pipe never ends (/dev/zero) or blocks the host forever.
          if (!stat.isFile()) return { ok: false, error: 'not_a_file', path: input.path };
          if (stat.size > MAX_LOCAL_READ_BYTES) return { ok: false, error: 'file_too_large', path: input.path, message: `LocalReadFile reads files up to ${MAX_LOCAL_READ_BYTES / 1024 / 1024} MB.` };
          return { ok: true, path: input.path, content: fs.readFileSync(fd, 'utf8') };
        } catch (err) {
          return { ok: false, error: 'read_failed', path: input.path, message: err.message };
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      },
    },
    {
      name: 'LocalWriteFile',
      description: "Write an exact file path on the machine running the Better Bots host, outside the sandbox. With a VPS host this writes the VPS, not the user's Mac. Cannot write Better Bots’ own data folder. Uses the saved local permission.",
      side_effect: 'Changes host-machine files outside the sandbox.',
      permission: { action: 'local.write_file', target: (input) => input.path },
      input_schema: {
        type: 'object',
        required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' }, expected_revision: { type: 'string' }, operation_id: { type: 'string' } },
      },
      handler({ agent, input }) {
        const resolved = realTarget(input.path);
        if (files && (resolved === files.state_dir || resolved.startsWith(files.state_dir + path.sep))) return { ok: false, error: 'transaction_state_protected' };
        if (protectedHostPath({ dataDir, workspace }, resolved)) return DATA_DIR_REFUSAL;
        if (files && (resolved === files.workspace || resolved.startsWith(files.workspace + path.sep))) {
          return files.execute(agent.id, { ...input, path: path.relative(files.workspace, resolved), action: 'write' });
        }
        if (fs.existsSync(resolved) && fs.statSync(resolved).nlink > 1) return { ok: false, error: 'unsafe_file_alias' };
        fs.writeFileSync(input.path, input.content);
        return { ok: true, path: input.path, bytes: Buffer.byteLength(input.content) };
      },
    },
  ];
}

export function screenTools({ computer }) {
  return [
    {
      name: 'OpenScreen',
      description:
        'Open your own real web browser: a private desktop window on the shared sandbox computer with a browser ' +
        'you drive through UseScreen. Use it for pages that need JavaScript, sign-in, clicks or forms, or when ' +
        'WebReadPublic comes back empty or blocked. Returns a VNC URL, window_index and owner_token. ' +
        'A private screen is not a private file system.',
      side_effect: 'Consumes one of a finite number of monitors on the shared computer.',
      permission: { action: 'sandbox.run_command', target: () => 'desktop_window' },
      input_schema: { type: 'object', required: [], properties: {} },
      async handler({ agent }) {
        const outcome = await computer.requestWindow(agent.id);
        if (!outcome.ok) {
          // Capacity is real: honest exhaustion, never a pretend success.
          return { ok: false, reason: outcome.reason, detail: outcome.detail, options: outcome.options };
        }
        const ready = await computer.readyWindow(agent.id);
        return { ok: true, ...ready, shared: computer.describe().warning, ...(ready.live ? {} : { note: computer.describe().desktop_note }) };
      },
    },
    {
      name: 'UseScreen',
      description:
        'Drive your browser window from OpenScreen. Start with open_url to load a page. Requires the owner token. Actions: screenshot, ' +
        'open_url {url}, click {x,y,button?}, type {text}, key {key}, move {x,y}. Every action returns ' +
        'a screenshot file name so the record shows what the screen looked like afterwards.',
      side_effect: 'Interacts with a visible desktop surface on the shared computer.',
      permission: { action: (input) => input.action === 'screenshot' ? 'sandbox.read_file' : SCREEN_ACTIONS.includes(input.action) ? 'external.browser' : 'external.unclassified', target: (input) => JSON.stringify({ window: input.window_index, action: input.action, detail: input.detail ?? {} }) },
      input_schema: {
        type: 'object',
        required: ['window_index', 'owner_token', 'action'],
        properties: {
          window_index: { type: 'number' },
          owner_token: { type: 'string' },
          action: { type: 'string', enum: SCREEN_ACTIONS },
          detail: { type: 'object' },
        },
      },
      handler({ agent, input, run }) {
        return computer.performWindowAction(agent.id, {
          signal: run?.signal?.native,
          window_index: input.window_index,
          owner_token: input.owner_token,
          action: input.action,
          detail: input.detail ?? {},
        });
      },
    },
  ];
}
