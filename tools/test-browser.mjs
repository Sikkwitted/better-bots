import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the platform's offline browser checks.
const tests = readdirSync(new URL('../test/browser/', import.meta.url))
  .filter(name => name.endsWith('.mjs')).sort();
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'XDG_CACHE_HOME',
  'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_MODULE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
env.BETTER_BOTS_DESKTOP = 'placeholder';
env.BETTER_BOTS_CODEX_AUTH_FILE = '/nonexistent/better-bots-browser-test-auth.json';
for (const name of tests) {
  console.log(`Browser check: ${name}`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../test/browser/${name}`, import.meta.url))],
    { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? `Browser check failed: ${name}`);
    process.exit(1);
  }
}
console.log(`Passed ${tests.length} browser checks.`);
