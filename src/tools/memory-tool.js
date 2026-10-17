// Profile, transcript, and memory are different things, and
// memory is a budgeted view, not a dump. The transcript window is short on
// purpose; this is how a model keeps something beyond it. The
// model proposes, the host commits (and enforces the scope rules).

export const MEMORY_SCOPES = ['agent', 'user', 'project'];
export const MEMORY_TIERS = ['profile', 'log', 'note'];
const builtInMemoryTools = new WeakMap();

const markBuiltIn = (tool) => {
  builtInMemoryTools.set(tool, tool.name);
  return tool;
};

export const isBuiltInMemoryTool = (tool) => Boolean(tool && builtInMemoryTools.get(tool) === tool.name);

export function rememberTool({ host }) {
  return markBuiltIn({
    name: 'Remember',
    description:
      'Keep one durable fact beyond this conversation. scope user: about the person (every agent sees it). ' +
      'scope project: a decision or convention about the shared work. scope agent: your own private working note. ' +
      'tier profile: always in mind (your own scope only; user and project facts you write are kept as log). tier log: a dated decision or event, recalled when relevant. ' +
      'tier note: a detail kept for Recall only, never shown automatically. ' +
      'Never store secrets or transient task state.',
    side_effect: 'Writes one fact to durable memory. No external effect.',
    permission: null,
    input_schema: {
      type: 'object',
      required: ['scope', 'tier', 'text'],
      properties: {
        scope: { type: 'string', enum: MEMORY_SCOPES },
        tier: { type: 'string', enum: MEMORY_TIERS },
        text: { type: 'string', description: 'One self-contained sentence, at most 600 characters.' },
      },
    },
    handler({ agent, input }) {
      const text = String(input.text).replace(/\s+/g, ' ').trim().slice(0, 600);
      if (!text) throw new Error('memory text cannot be empty');
      const owner_id = input.scope === 'agent' ? agent.id : input.scope === 'project' ? host.project_id : 'user';
      const fact = host.memory.remember({ scope: input.scope, owner_id, writer_agent_id: agent.id, tier: input.tier, text, source: 'tool' });
      const note = fact.tier === input.tier ? 'Kept. It will be recalled in later turns when relevant.'
        : 'Kept as a log fact: shared memory an agent writes is recalled when relevant, not always in mind. Only the person sets standing shared facts.';
      return { ok: true, fact_id: fact.id, scope: fact.owner_scope, tier: fact.tier, note };
    },
  });
}

/**
 * Older material stays on disk for explicit reading or search. This is
 * the explicit read. The model names a query; the host searches only the scopes
 * this agent may see — its own, the user's, the project's — notes included.
 */
export function recallTool({ host }) {
  return markBuiltIn({
    name: 'Recall',
    description:
      'Search your durable memory for anything not already in front of you: earlier decisions, dates, ' +
      'people, preferences, details you filed as notes. Use it before saying you do not know or do not ' +
      'remember. Searches your own memory plus the shared user and project memory; never another agent\'s.',
    side_effect: 'Reads memory. No external effect.',
    permission: null,
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What you are trying to remember, as a question or phrase.' },
        scope: { type: 'string', enum: ['all', ...MEMORY_SCOPES], description: 'Where to look. Default all.' },
        limit: { type: 'number', description: 'At most this many results, default 8, max 20.' },
      },
    },
    async handler({ agent, input }) {
      const query = String(input.query ?? '').trim();
      if (!query) throw new Error('query cannot be empty');
      const limit = Math.max(1, Math.min(20, Number(input.limit) || 8));
      const all = [
        { scope: 'agent', owner_id: agent.id },
        { scope: 'project', owner_id: host.project_id },
        { scope: 'user', owner_id: 'user' },
      ];
      const scopes = !input.scope || input.scope === 'all' ? all : all.filter((s) => s.scope === input.scope);
      const facts = await host.memory.search({ agent_id: agent.id, scopes, query, limit });
      return {
        ok: true,
        query,
        results: facts.map((f) => ({
          text: f.text,
          scope: f.owner_scope,
          tier: f.tier,
          ...(f.when ? { when: f.when } : {}),
          learned_at: f.learned_at,
        })),
        note: facts.length ? `${facts.length} result(s).` : 'Nothing matched. It may never have been stored.',
      };
    },
  });
}
