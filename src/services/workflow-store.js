import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JsonDoc } from '../core/store.js';
import { newId, HostError } from '../core/util.js';

// Tools, workflows, plugins, and skills.
//
// The importer handles Markdown, live sources, CLAUDE.md, AGENTS.md,
// .claude/CLAUDE.md and Cursor rules. Skill folders (.codex/skills/,
// .claude/skills/) go through a deliberate adapter, not a blanket copy.
//
// The safe skill adapter, in order:
//   1. Detect the manifest or instruction entry point.
//   2. Copy or link only the declared files.
//   3. Record the source ecosystem and original path.
//   4. Normalize name and description.
//   5. Preserve helper scripts but do not execute them during import.
//   6. Ask the user which agents may enable the skill.
//   7. Run imported scripts inside the agent sandbox with normal permissions.

/** Instruction entry points the importer recognises. */
export const INSTRUCTION_ENTRY_POINTS = [
  'CLAUDE.md',
  'AGENTS.md',
  path.join('.claude', 'CLAUDE.md'),
];
export const CURSOR_RULES_DIR = path.join('.cursor', 'rules');
const CURSOR_RULE_EXTENSIONS = ['.md', '.mdc'];
const SKILL_MANIFESTS = ['SKILL.md', 'skill.md'];
const HELPER_SCRIPT_EXTENSIONS = ['.sh', '.js', '.mjs', '.py', '.rb', '.ts'];

export class WorkflowStore {
  constructor({ dir, clock, audit, registry }) {
    this.dir = dir;
    this.clock = clock;
    this.audit = audit;
    this.registry = registry;
    this.sandbox_kind = process.platform === 'linux' ? 'bwrap' : 'seatbelt';
    this.filesDir = path.join(dir, 'workflows', 'files');
    this.doc = new JsonDoc(path.join(dir, 'workflows', 'workflows.json'), { workflows: {} });
  }

  list() {
    return Object.values(this.doc.read().workflows);
  }

  get(workflowId) {
    const record = this.doc.read().workflows[workflowId];
    if (!record) throw new HostError('workflow_not_found', `unknown workflow ${workflowId}`);
    return record;
  }

  #save(record) {
    this.doc.update((state) => {
      state.workflows[record.id] = record;
      return state;
    });
    this.audit.record('workflow.imported', {
      workflow_id: record.id, name: record.name, kind: record.kind,
      source_ecosystem: record.source_ecosystem, original_path: record.original_path,
      helper_scripts: record.helper_scripts.length,
    });
    return record;
  }

  /** Import Markdown instructions directly. */
  importMarkdown({ name, description = '', text, source_ecosystem = 'inline', original_path = null }) {
    const record = this.#blank({ name, description, kind: 'markdown', source_ecosystem, original_path });
    const file = path.join(this.filesDir, record.id, 'instructions.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    record.files = [{ role: 'instructions', stored_at: file }];
    return this.#save(record);
  }

  /** Link a live source path instead of copying it. */
  linkSource({ name, description = '', source_path, source_ecosystem = 'linked' }) {
    if (!fs.existsSync(source_path)) {
      throw new HostError('source_not_found', `no file at ${source_path}`);
    }
    const record = this.#blank({ name, description, kind: 'linked', source_ecosystem, original_path: source_path });
    record.files = [{ role: 'instructions', linked_to: source_path }];
    return this.#save(record);
  }

  /**
   * Discover the instruction entry points this importer actually supports.
   * Anything else in the directory is ignored rather than swept up.
   */
  importFromDirectory(sourceDir, { source_ecosystem = 'local' } = {}) {
    const imported = [];
    for (const entry of INSTRUCTION_ENTRY_POINTS) {
      const full = path.join(sourceDir, entry);
      if (!fs.existsSync(full)) continue;
      imported.push(this.importMarkdown({
        name: entry,
        description: `Instruction file discovered at ${entry}`,
        text: readInstructionFile(sourceDir, full),
        source_ecosystem,
        original_path: full,
      }));
    }

    const rulesDir = path.join(sourceDir, CURSOR_RULES_DIR);
    if (fs.existsSync(rulesDir)) {
      for (const file of fs.readdirSync(rulesDir).sort()) {
        if (!CURSOR_RULE_EXTENSIONS.includes(path.extname(file))) continue;
        imported.push(this.importMarkdown({
          name: path.join(CURSOR_RULES_DIR, file),
          description: 'Cursor rule',
          text: readInstructionFile(sourceDir, path.join(rulesDir, file)),
          source_ecosystem: 'cursor',
          original_path: path.join(rulesDir, file),
        }));
      }
    }

    this.audit.record('workflow.directory_scanned', {
      source_dir: sourceDir, source_ecosystem, imported: imported.length,
    });
    return imported;
  }

  /**
   * The safe skill adapter. Copies only the declared files, records provenance,
   * and preserves helper scripts WITHOUT running any of them. Nothing in this
   * method spawns a process — that is the whole point.
   */
  importSkill(skillDir, { source_ecosystem = 'unknown' } = {}) {
    const manifestName = SKILL_MANIFESTS.find((m) => fs.existsSync(path.join(skillDir, m)));
    if (!manifestName) {
      throw new HostError(
        'no_manifest',
        `no skill manifest in ${skillDir}; this importer will not sweep a folder blindly`,
      );
    }
    const manifestPath = path.join(skillDir, manifestName);
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const { name, description, declared } = parseManifest(raw, path.basename(skillDir));

    const record = this.#blank({
      name, description, kind: 'skill', source_ecosystem, original_path: skillDir,
    });
    const destDir = path.join(this.filesDir, record.id);
    fs.mkdirSync(destDir, { recursive: true });

    // Copy only the manifest plus whatever the manifest declares.
    const wanted = [...new Set([manifestName, ...declared])];
    // Validate the complete set before copying anything, including directory links.
    for (const relative of wanted) safeSkillFile(skillDir, relative);
    const skipped = [];
    for (const relative of wanted) {
      const from = path.join(skillDir, relative);
      if (!fs.existsSync(from) || !insideDir(skillDir, from)) {
        skipped.push(relative);
        continue;
      }
      const to = path.join(destDir, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      const isScript = HELPER_SCRIPT_EXTENSIONS.includes(path.extname(relative));
      const file = { role: relative === manifestName ? 'manifest' : isScript ? 'helper_script' : 'asset', declared_as: relative, stored_at: to };
      record.files.push(file);
      if (isScript) record.helper_scripts.push({ declared_as: relative, stored_at: to, executed_on_import: false });
    }

    record.skipped_undeclared = skipped;
    record.instructions_file = path.join(destDir, manifestName);
    record.bundle_version = bundleHash(record.files);
    const versionDir = path.join(destDir, record.bundle_version);
    fs.mkdirSync(versionDir);
    for (const file of record.files) {
      const target = path.join(versionDir, file.declared_as);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(file.stored_at, target);
      file.stored_at = target;
    }
    for (const helper of record.helper_scripts) helper.stored_at = path.join(versionDir, helper.declared_as);
    record.bundle_dir = versionDir;
    record.instructions_file = path.join(versionDir, manifestName);
    this.#save(record);
    if (record.helper_scripts.length > 0) {
      this.audit.record('workflow.helper_scripts_preserved', {
        workflow_id: record.id,
        count: record.helper_scripts.length,
        note: 'Stored, never executed during import. They run in the agent sandbox under normal permissions.',
      });
    }
    return record;
  }

  #blank({ name, description, kind, source_ecosystem, original_path }) {
    return {
      id: newId('wfl'),
      name: String(name).trim(),
      description: String(description ?? '').trim(),
      kind,
      source_ecosystem,
      original_path,
      files: [],
      helper_scripts: [],
      // Step 6: the user decides which agents may enable it. Nothing is enabled
      // by being imported.
      enabled_for: [],
      imported_at: this.clock.iso(),
    };
  }

  /** Enabling a workflow for an agent is a user decision, never an agent's. */
  enableFor(workflowId, agentId, { actor = 'user' } = {}) {
    if (actor !== 'user') {
      this.audit.record('workflow.enable_blocked', { workflow_id: workflowId, agent_id: agentId, actor });
      throw new HostError('user_only_decision', 'only the user may enable a workflow for an agent');
    }
    this.get(workflowId);
    this.registry.get(agentId);
    this.doc.update((state) => {
      const record = state.workflows[workflowId];
      if (!record.enabled_for.includes(agentId)) record.enabled_for.push(agentId);
      return state;
    });
    this.registry.enableWorkflow(agentId, workflowId);
    this.audit.record('workflow.enabled', { workflow_id: workflowId, agent_id: agentId, actor });
    return this.get(workflowId);
  }

  disableFor(workflowId, agentId, { actor = 'user' } = {}) {
    if (actor !== 'user') throw new HostError('user_only_decision', 'only the user may disable a workflow');
    this.doc.update((state) => {
      const record = state.workflows[workflowId];
      if (record) record.enabled_for = record.enabled_for.filter((id) => id !== agentId);
      return state;
    });
    this.audit.record('workflow.disabled', { workflow_id: workflowId, agent_id: agentId, actor });
    return this.get(workflowId);
  }

  /** Instruction text for the agents that were explicitly granted this workflow. */
  instructionsFor(agentId) {
    return this.list()
      .filter((w) => w.enabled_for.includes(agentId))
      .map((w) => {
        const bundle = w.kind === 'skill' ? this.bundle(w) : null;
        const text = this.readInstructions(w.id);
        return { id: w.id, name: w.name, text: bundle
          ? `${text}\n\nSkill bundle (read-only): ${bundle.target}\nDeclared files: ${w.files.map((f) => f.declared_as).join(', ')}\nUse SandboxRunCommand with these absolute paths to read assets or run helpers. Write outputs in your agent working directory. Normal tool permissions apply.`
          : text };
      })
      .filter((w) => w.text);
  }

  bundle(record) {
    const source = record.bundle_dir ?? path.join(this.filesDir, record.id);
    if (!insideDir(this.filesDir, source)) throw new HostError('unsafe_skill_file', 'skill bundle must stay in managed storage');
    for (const file of record.files) {
      const safe = safeSkillFile(source, file.declared_as);
      if (path.resolve(file.stored_at) !== safe) throw new HostError('unsafe_skill_file', 'skill file does not match its declared path');
    }
    const version = bundleHash(record.files);
    if (record.bundle_version && version !== record.bundle_version) throw new HostError('skill_changed', 'skill files changed; import and enable the new version explicitly');
    return { id: record.id, source: fs.realpathSync(source), version,
      target: this.sandbox_kind === 'bwrap' ? `/skills/${record.id}/${version}` : fs.realpathSync(source) };
  }

  sandboxBundles(agentId) {
    return this.list().filter((w) => w.kind === 'skill' && w.enabled_for.includes(agentId)).map((w) => this.bundle(w));
  }

  readInstructions(workflowId) {
    const record = this.get(workflowId);
    const entry = record.files.find((f) => f.role === 'instructions' || f.role === 'manifest');
    if (!entry) return null;
    const file = entry.stored_at ?? entry.linked_to;
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
}

/** Normalize a name and description out of a manifest, with a safe fallback. */
export function parseManifest(raw, fallbackName) {
  let name = fallbackName;
  let description = '';
  const declared = [];

  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatter) {
    for (const line of frontmatter[1].split('\n')) {
      const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (key === 'name' && value) name = value.trim();
      if (key === 'description' && value) description = value.trim();
      if (key === 'files' && value) {
        for (const f of value.replace(/^\[|\]$/g, '').split(',')) {
          const trimmed = f.trim().replace(/^["']|["']$/g, '');
          if (trimmed) declared.push(trimmed);
        }
      }
    }
  }
  if (!description) {
    const heading = raw.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').find((l) => l.trim() && !l.startsWith('#'));
    description = (heading ?? '').trim().slice(0, 200);
  }
  return { name, description, declared };
}

function insideDir(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved.startsWith(resolvedRoot + path.sep);
}

const MAX_INSTRUCTION_BYTES = 256 * 1024;

/**
 * Imported text goes into a bot's prompt on every turn. A cloned repository can
 * hold links, so the file must resolve inside the imported folder (a CLAUDE.md
 * linked to AGENTS.md is fine; one linked to the host's env file is not), be a
 * regular file, and stay small.
 */
function readInstructionFile(sourceDir, file) {
  const root = fs.realpathSync(sourceDir);
  const target = fs.realpathSync(file);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HostError('unsafe_instruction_file', `${path.relative(sourceDir, file)} links outside the imported folder`);
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new HostError('unsafe_instruction_file', `${path.relative(sourceDir, file)} is not a regular file`);
  if (stat.size > MAX_INSTRUCTION_BYTES) throw new HostError('instruction_file_too_large', `${path.relative(sourceDir, file)} is over ${MAX_INSTRUCTION_BYTES / 1024} KB`);
  return fs.readFileSync(target, 'utf8');
}

function safeSkillFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((p) => !p || p === '.' || p === '..')) {
    throw new HostError('unsafe_skill_file', 'skill files must use contained relative paths');
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw new HostError('unsafe_skill_file', 'skill roots cannot be symlinks');
  let target = path.resolve(root);
  for (const segment of relative.split('/')) {
    target = path.join(target, segment);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new HostError('unsafe_skill_file', 'skill symlinks are not imported');
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.nlink !== 1) throw new HostError('unsafe_skill_file', 'skill declarations must name regular, unaliased files');
  return target;
}

function bundleHash(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.declared_as.localeCompare(b.declared_as))) {
    hash.update(JSON.stringify([file.declared_as, fs.statSync(file.stored_at).mode & 0o777]));
    hash.update(fs.readFileSync(file.stored_at));
  }
  return hash.digest('hex').slice(0, 24);
}
