import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHost, say, tmpDir } from './helpers.js';

// Importing a folder puts its instruction files into a bot's prompt. A cloned
// repository can hold links, so a file that resolves outside the folder (the
// host's env file, /dev/zero) is refused, while a link inside it still works.

function repo() {
  const root = tmpDir('import-links');
  const source = path.join(root, 'repo');
  fs.mkdirSync(path.join(source, '.cursor', 'rules'), { recursive: true });
  const secrets = path.join(root, 'better-bots.env');
  fs.writeFileSync(secrets, 'ANTHROPIC_API_KEY=sk-ant-secret\n');
  return { source, secrets };
}

test('a CLAUDE.md that links to AGENTS.md in the same folder imports normally', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const { source } = repo();
  fs.writeFileSync(path.join(source, 'AGENTS.md'), '# Agents\nUse tabs.');
  fs.symlinkSync('AGENTS.md', path.join(source, 'CLAUDE.md'));
  const names = host.workflows.importFromDirectory(source).map((w) => w.name).sort();
  assert.deepEqual(names, ['AGENTS.md', 'CLAUDE.md']);
});

test('an instruction file linked outside the folder is refused, so no key reaches a prompt', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const { source, secrets } = repo();
  fs.symlinkSync(secrets, path.join(source, 'AGENTS.md'));
  assert.throws(() => host.workflows.importFromDirectory(source), /links outside the imported folder/);
  assert.ok(!JSON.stringify(host.workflows.list()).includes('sk-ant-secret'));
});

test('a Cursor rule linked outside the folder is refused too', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const { source, secrets } = repo();
  fs.symlinkSync(secrets, path.join(source, '.cursor', 'rules', 'style.md'));
  assert.throws(() => host.workflows.importFromDirectory(source), /links outside the imported folder/);
});

test('oversized instruction files and devices are refused instead of read', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const { source } = repo();
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'x'.repeat(256 * 1024 + 1));
  assert.throws(() => host.workflows.importFromDirectory(source), /over 256 KB/);
  fs.rmSync(path.join(source, 'AGENTS.md'));
  if (fs.existsSync('/dev/zero')) {
    fs.symlinkSync('/dev/zero', path.join(source, 'AGENTS.md'));
    assert.throws(() => host.workflows.importFromDirectory(source), /unsafe_instruction_file|links outside/);
  }
});
