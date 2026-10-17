import fs from 'node:fs';

/**
 * Replace one KEY=value line in the env file, preserving the rest. Written
 * to a temp file in the same directory and renamed, so a crash mid-write
 * cannot leave the host with a half-written credential file.
 *
 * Shared by the provider key route (built-in providers) and the custom
 * provider store, so a key saved anywhere reaches the file the service unit
 * reads at boot.
 */
export function writeEnvVar(name, value, file = process.env.BETTER_BOTS_ENV_FILE ?? '/var/lib/better-bots/better-bots.env') {
  // A newline in a value would become extra environment lines in the file systemd reads.
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || /[\r\n\0]/.test(String(value))) throw new Error('Invalid credential name or value');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith(`${name}=`));
  } catch {
    // First write. The file may not exist yet.
  }
  lines = lines.filter((l) => l.trim() !== '');
  lines.push(`${name}=${value}`);
  // Keep whatever mode the operator chose (a 0600 file must not loosen); a new file starts at 0640.
  let mode = 0o640;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* first write */ }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode });
  fs.renameSync(tmp, file);
}
