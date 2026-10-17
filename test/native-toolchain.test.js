import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the actual native test registration with an isolated platform/toolchain.
// No compiler is launched here; native-tunnel.test.js exercises it when present.
function runNativeTests(platform, swiftStatus) {
  const preload = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    childProcess.spawnSync = (command, args) => {
      if (command !== '/usr/bin/swift' || process.platform !== 'darwin') {
        throw new Error('Unexpected toolchain probe');
      }
      if (args[0] === '--version') return { status: ${JSON.stringify(swiftStatus)}, stdout: '', stderr: '' };
      if (${JSON.stringify(swiftStatus)} !== 0) throw new Error('Unavailable Swift must not execute native tests');
      return { status: 0, stdout: '', stderr: '' };
    };
    syncBuiltinESMExports();
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This subprocess is an independent test runner.
  return spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    '--test', '--test-reporter=tap',
    fileURLToPath(new URL('./native-tunnel.test.js', import.meta.url)),
  ], { encoding: 'utf8', timeout: 30_000, env });
}

test('Node-only macOS skips native checks when the Swift toolchain is unavailable', () => {
  const result = runNativeTests('darwin', 1);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# skipped 2/);
  assert.match(result.stdout, /# SKIP .*Swift/i);
});

test('macOS skips native checks when the Swift probe cannot start or times out', () => {
  const result = runNativeTests('darwin', null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# skipped 2/);
});

test('native checks still run on macOS when Swift is available', () => {
  const result = runNativeTests('darwin', 0);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# pass 2/);
  assert.match(result.stdout, /# skipped 0/);
});

test('non-macOS platforms skip native checks without probing Swift', () => {
  const result = runNativeTests('linux', 0);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# skipped 2/);
});
