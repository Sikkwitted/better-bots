import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHost, tmpDir, say } from './helpers.js';
import { parseManifest, INSTRUCTION_ENTRY_POINTS } from '../src/services/workflow-store.js';

// Imported scripts do not run during import.

function fixtureProject() {
  const dir = tmpDir('better-bots-src');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project rules\nAlways run the tests.');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent notes\nPrefer small handoffs.');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'CLAUDE.md'), '# Nested rules\nUse the sandbox.');
  fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cursor', 'rules', 'style.mdc'), '# Style\nTwo-space indent.');
  fs.writeFileSync(path.join(dir, '.cursor', 'rules', 'naming.md'), '# Naming\nkebab-case files.');
  fs.writeFileSync(path.join(dir, 'README.md'), 'not an instruction entry point');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'unblessed'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'unblessed', 'SKILL.md'), '# Should not be swept up');
  return dir;
}

test('the importer discovers only the entry points it actually supports', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const source = fixtureProject();
  const imported = host.workflows.importFromDirectory(source, { source_ecosystem: 'local' });

  const names = imported.map((w) => w.name).sort();
  assert.deepEqual(names, [
    '.claude/CLAUDE.md', '.cursor/rules/naming.md', '.cursor/rules/style.mdc', 'AGENTS.md', 'CLAUDE.md',
  ].sort());
  assert.ok(!names.includes('README.md'), 'unrelated Markdown is not swept up');
  assert.ok(
    !imported.some((w) => w.original_path.includes(path.join('skills', 'unblessed'))),
    'a skills folder is not imported wholesale; it needs the deliberate adapter',
  );
  for (const entry of INSTRUCTION_ENTRY_POINTS) {
    assert.ok(imported.some((w) => w.name === entry.split(path.sep).join('/')) || imported.some((w) => w.name === entry));
  }
  assert.equal(imported.find((w) => w.name === '.cursor/rules/style.mdc').source_ecosystem, 'cursor');
});

test('a skill import copies declared files and never executes a helper script', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const skillDir = tmpDir('better-bots-skill');
  const sentinel = path.join(tmpDir('better-bots-sentinel'), 'executed.txt');

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: deploy-helper',
    'description: Deploys the sample app',
    'files: [install.sh, reference.md]',
    '---',
    '# Deploy helper',
    'Run the install script inside the sandbox.',
  ].join('\n'));
  // If the importer ever executes this, the sentinel file appears.
  fs.writeFileSync(path.join(skillDir, 'install.sh'), `#!/bin/sh\ntouch "${sentinel}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(skillDir, 'reference.md'), '# Reference');
  fs.writeFileSync(path.join(skillDir, 'secret-not-declared.txt'), 'should not be copied');

  const record = host.workflows.importSkill(skillDir, { source_ecosystem: 'claude-code' });

  assert.equal(fs.existsSync(sentinel), false, 'the helper script did not run during import');
  assert.equal(record.name, 'deploy-helper');
  assert.equal(record.description, 'Deploys the sample app');
  assert.equal(record.source_ecosystem, 'claude-code');
  assert.equal(record.original_path, skillDir);

  const copied = record.files.map((f) => f.declared_as).sort();
  assert.deepEqual(copied, ['SKILL.md', 'install.sh', 'reference.md']);
  assert.ok(!copied.includes('secret-not-declared.txt'), 'only declared files are copied');

  assert.equal(record.helper_scripts.length, 1);
  assert.equal(record.helper_scripts[0].executed_on_import, false);
  assert.ok(fs.existsSync(record.helper_scripts[0].stored_at), 'the script is preserved for sandbox use');
  assert.ok(host.audit.where((e) => e.type === 'workflow.helper_scripts_preserved').length === 1);
});

test('a folder without a manifest is refused rather than swept', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const dir = tmpDir('better-bots-noskill');
  fs.writeFileSync(path.join(dir, 'random.md'), 'hello');
  assert.throws(() => host.workflows.importSkill(dir), /will not sweep a folder blindly/);
});

test('importing enables nothing; the user decides which agents may use it', async () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const agent = host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  const workflow = host.workflows.importMarkdown({
    name: 'checkout-rules', description: 'How to build checkout', text: 'Always use one-page checkout.',
  });

  assert.deepEqual(workflow.enabled_for, [], 'import does not grant');
  assert.deepEqual(host.workflows.instructionsFor('agt_a'), []);
  assert.throws(() => host.workflows.enableFor(workflow.id, 'agt_a', { actor: 'agent' }), /only the user/);

  host.workflows.enableFor(workflow.id, 'agt_a', { actor: 'user' });
  assert.deepEqual(host.workflows.get(workflow.id).enabled_for, ['agt_a']);
  assert.ok(host.registry.get('agt_a').enabled_workflows.includes(workflow.id));

  host.workflows.disableFor(workflow.id, 'agt_a', { actor: 'user' });
  assert.deepEqual(host.workflows.get(workflow.id).enabled_for, []);
});

test('only an enabled workflow reaches the prompt', async () => {
  const seen = [];
  const { host } = makeHost({ script: (ctx) => { seen.push(ctx.settings.system); return [say('ok')]; } });
  host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
  host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
  const workflow = host.workflows.importMarkdown({ name: 'house-style', text: 'Never use inline styles.' });
  host.workflows.enableFor(workflow.id, 'agt_a', { actor: 'user' });

  host.userRequest({ agent_id: 'agt_a', text: 'go' });
  await host.drain();
  host.userRequest({ agent_id: 'agt_b', text: 'go' });
  await host.drain();

  assert.match(seen[0], /Enabled workflows:[\s\S]*house-style[\s\S]*Never use inline styles/);
  assert.ok(!seen[1].includes('Never use inline styles'), 'an agent without the grant does not see it');
});

test('a linked source is referenced, not copied', () => {
  const { host } = makeHost({ script: () => [say('ok')] });
  const dir = tmpDir('better-bots-link');
  const file = path.join(dir, 'live.md');
  fs.writeFileSync(file, 'version one');
  const workflow = host.workflows.linkSource({ name: 'live-rules', source_path: file });

  assert.equal(workflow.kind, 'linked');
  assert.equal(host.workflows.readInstructions(workflow.id), 'version one');
  fs.writeFileSync(file, 'version two');
  assert.equal(host.workflows.readInstructions(workflow.id), 'version two', 'a link follows the live source');
  assert.throws(() => host.workflows.linkSource({ name: 'x', source_path: '/nope/missing.md' }), /no file at/);
});

test('manifest parsing normalizes name and description with a safe fallback', () => {
  assert.deepEqual(
    parseManifest('---\nname: a-skill\ndescription: Does a thing\nfiles: [x.sh, "y.md"]\n---\n# Heading\n', 'folder'),
    { name: 'a-skill', description: 'Does a thing', declared: ['x.sh', 'y.md'] },
  );
  const noFrontmatter = parseManifest('# Title\nA plain description line.\n', 'folder-name');
  assert.equal(noFrontmatter.name, 'folder-name');
  assert.equal(noFrontmatter.description, 'A plain description line.');
  assert.deepEqual(noFrontmatter.declared, []);
});
