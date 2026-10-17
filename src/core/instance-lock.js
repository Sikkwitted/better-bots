import fs from 'node:fs';
import path from 'node:path';

// One running host per data folder. A second host started on the same folder would
// run crash recovery against work the first is in the middle of, so it refuses
// before touching anything. Separate folders never see each other's lock.

export class InstanceLockError extends Error {
  constructor(message, holder) { super(message); this.code = 'instance_running'; this.holder = holder; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; } // exists, just not ours to signal
}

/** Returns a function that releases the lock. Throws InstanceLockError if another live host holds it. */
export function acquireInstanceLock(dir, { pid = process.pid, alive = processAlive } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.better-bots.lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, String(pid)); } finally { fs.closeSync(fd); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only remove our own lock; never one a newer host has since taken.
        try { if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file); } catch { /* already gone */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = NaN;
      try { holder = Number(fs.readFileSync(file, 'utf8').trim()); } catch { continue; } // vanished: try again
      if (Number.isInteger(holder) && holder !== pid && alive(holder)) {
        throw new InstanceLockError(
          `Better Bots is already running on ${dir} (process ${holder}). `
          + `Stop it first, or start this one with a different BETTER_BOTS_DIR. `
          + `If you are sure nothing is running, delete ${file}.`, holder);
      }
      try { fs.unlinkSync(file); } catch { /* someone else cleaned it */ } // stale: its host is gone
    }
  }
  throw new InstanceLockError(`Could not take the lock on ${dir}.`, null);
}
