import { HostError } from '../core/util.js';
import { isBuiltInMemoryTool } from './memory-tool.js';

const MEMORY_TOOLS = new Set(['Remember', 'Recall']);

// Tools are capabilities. A tool is described by a stable name,
// a typed input schema, a side-effect description, a permission policy, a result
// format, and an audit record. All six are required here.

export class ToolRegistry {
  constructor({ audit, permissions = null }) {
    this.audit = audit;
    this.permissions = permissions;
    this.tools = new Map();
  }

  register(tool) {
    for (const field of ['name', 'description', 'input_schema', 'side_effect', 'permission', 'handler']) {
      if (!(field in tool)) throw new HostError('bad_tool', `tool is missing "${field}"`);
    }
    if (MEMORY_TOOLS.has(tool.name) && (!isBuiltInMemoryTool(tool) || this.tools.has(tool.name))) {
      throw new HostError('reserved_tool_name', `${tool.name} is reserved for the built-in memory tool`);
    }
    this.tools.set(tool.name, tool);
    return tool;
  }

  /** A tool leaves when its integration does. Unknown names are not an error. */
  unregister(name) {
    if (MEMORY_TOOLS.has(name)) return false;
    return this.tools.delete(name);
  }

  get(name) {
    const tool = this.tools.get(name);
    if (!tool) throw new HostError('unknown_tool', `no tool named ${name}`);
    return tool;
  }

  has(name) {
    return this.tools.has(name);
  }

  allowedFor(tool, agent) {
    // Memory is a host capability for every agent, including profiles saved
    // before the built-in desk templates listed it explicitly.
    const memoryTool = MEMORY_TOOLS.has(tool.name) && isBuiltInMemoryTool(tool) && this.tools.get(tool.name) === tool;
    return (memoryTool || !Array.isArray(agent.profile?.allowed_tools) || agent.profile.allowed_tools.includes(tool.name))
      && (!tool.enabled_for || tool.enabled_for(agent));
  }

  #zoneAllows(tool) {
    if (!tool.permission?.action || !this.permissions) return true;
    try {
      const { zone } = this.permissions.policyFor(tool.permission.action);
      return this.permissions.standingMode(zone) !== 'never';
    } catch {
      return true; // an action with no policy is gated at call time, not hidden
    }
  }

  /**
   * The model only ever sees the tools policy allows for this agent
   * (`tools: policy.allowed_tools(agent.id)`). A tool whose zone the user
   * has set to `never` is not offered and then refused; it is simply absent.
   */
  describeFor(agent) {
    return [...this.tools.values()]
      .filter((tool) => this.allowedFor(tool, agent))
      .filter((tool) => this.#zoneAllows(tool))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        side_effect: tool.side_effect,
      }));
  }
}

/** Minimal structural validator. Typed inputs, checked before any side effect. */
export function validateInput(schema, input) {
  const errors = [];
  const value = input ?? {};
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null || value[key] === '') {
      errors.push(`missing required field "${key}"`);
    }
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (value[key] === undefined || value[key] === null) continue;
    const actual = Array.isArray(value[key]) ? 'array' : typeof value[key];
    // JSON Schema from an MCP server may say `integer`, or list several types.
    const wanted = Array.isArray(spec.type) ? spec.type : (spec.type ? [spec.type] : []);
    const fits = (t) => t === actual || (t === 'integer' && actual === 'number' && Number.isInteger(value[key]));
    if (wanted.length && !wanted.some(fits)) {
      errors.push(`field "${key}" should be ${wanted.join(' or ')}, got ${actual}`);
    }
    if (spec.minItems && Array.isArray(value[key]) && value[key].length < spec.minItems) {
      errors.push(`field "${key}" needs at least ${spec.minItems} item${spec.minItems === 1 ? '' : 's'}`);
    }
    if (spec.enum && !spec.enum.includes(value[key])) {
      errors.push(`field "${key}" must be one of ${spec.enum.join(', ')}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (schema.properties && !(key in schema.properties)) errors.push(`unknown field "${key}"`);
  }
  return { ok: errors.length === 0, errors };
}
