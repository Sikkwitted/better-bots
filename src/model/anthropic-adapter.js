import { ModelAdapter, hasTokenData, tokenValue, PROVIDER_REPORTED_NOTE } from './adapter.js';
import { PROVIDERS } from '../../web/models.js';

// A real provider adapter for Claude, proving the model layer is a seam: the
// host can swap the model layer without touching memory, messaging, meetings,
// or permissions. Nothing in this file imports a service.
//
// The SDK is an optional dependency and is imported lazily, so the host and its
// test suite stay dependency-free.

export const DEFAULT_MODEL = null;

export class AnthropicAdapter extends ModelAdapter {
  constructor({
    model = DEFAULT_MODEL,
    apiKey = process.env.ANTHROPIC_API_KEY,
    max_tokens = 64_000,
    effort = 'high',
    thinking = { type: 'adaptive' },
    timeout_ms = 600_000,
    client = null,
  } = {}) {
    super({ provider: 'anthropic', model });
    this.apiKey = apiKey;
    this.max_tokens = max_tokens;
    this.effort = effort;
    this.thinking = thinking;
    // A request that never returns is worse than one that fails. Streaming keeps
    // long agent turns alive; this bounds the pathological case.
    this.timeout_ms = timeout_ms;
    // An injected client (tests) short-circuits every provider.
    this.client = client;
    this.clients = new Map();
    this.activeStream = null;
  }

  async #getClient(provider = 'anthropic') {
    if (this.clients.has(provider)) return this.clients.get(provider);
    if (this.client) return this.client;
    let Anthropic;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw new Error(
        'AnthropicAdapter needs the official SDK. Run: npm install @anthropic-ai/sdk',
      );
    }
    // A bare client also resolves an `ant auth login` profile, so an unset
    // ANTHROPIC_API_KEY does not mean there are no credentials.
    // One client per provider, built on first use. An agent pinned to a GLM
    // model reaches Z.ai; everything else keeps the Anthropic default. Same
    // wire format either way, which is the only reason this is cheap.
    const spec = PROVIDERS[provider] ?? PROVIDERS.anthropic;
    const options = { timeout: this.timeout_ms };
    if (spec.base_url) options.baseURL = spec.base_url;
    const key = spec.key_env.map((name) => process.env[name]).find(Boolean)
      ?? (provider === 'anthropic' ? this.apiKey : undefined);
    if (key) options.authToken = key;
    if (provider === 'anthropic' && this.apiKey) { options.apiKey = this.apiKey; delete options.authToken; }
    const client = new Anthropic(options);
    this.clients.set(provider, client);
    return client;
  }

  async *stream(messages, tools, settings = {}) {
    const client = await this.#getClient(settings.provider ?? 'anthropic');
    settings.signal?.throwIfAborted();
    this._cancelled = null;
    this._usage.calls += 1;

    const stream = client.messages.stream({
      // An agent may pin its own model; otherwise the host default stands.
      model: settings.model ?? this.model,
      max_tokens: this.max_tokens,
      thinking: this.thinking,
      output_config: { effort: settings.reasoning_effort ?? this.effort },
      // Prompt caching: the system prompt and the tool list are the
      // same on every step of a turn, so they are marked cacheable. Adapter-internal;
      // the host never sees it.
      ...(settings.system ? { system: cacheableSystem(settings.system) } : {}),
      messages: toAnthropicMessages(messages),
      tools: cacheableTools(toAnthropicTools(tools)),
    });
    this.activeStream = stream;
    const abort = () => { stream.abort?.(); stream.controller?.abort?.(); };
    settings.signal?.addEventListener('abort', abort, { once: true });
    if (settings.signal?.aborted) abort();

    // Accumulate per content block and emit one host event per finished block.
    const blocks = new Map();
    try {
      for await (const event of stream) {
        if (settings.signal ? settings.signal.aborted : this._cancelled) break;

        if (event.type === 'content_block_start') {
          blocks.set(event.index, { block: event.content_block, text: '', json: '' });
        } else if (event.type === 'content_block_delta') {
          const entry = blocks.get(event.index);
          if (!entry) continue;
          if (event.delta.type === 'text_delta') entry.text += event.delta.text;
          if (event.delta.type === 'input_json_delta') entry.json += event.delta.partial_json;
          // Reasoning streams live so the interface can show the model thinking;
          // it is never part of the visible answer.
          if (event.delta.type === 'thinking_delta' && event.delta.thinking) yield { type: 'thinking', text: event.delta.thinking };
        } else if (event.type === 'content_block_stop') {
          const entry = blocks.get(event.index);
          blocks.delete(event.index);
          if (!entry) continue;
          if (entry.block.type === 'text' && entry.text.trim()) {
            yield { type: 'text', text: entry.text };
          } else if (entry.block.type === 'tool_use') {
            yield {
              type: 'tool_call',
              id: entry.block.id,
              name: entry.block.name,
              input: entry.json ? safeParse(entry.json) : entry.block.input ?? {},
            };
          }
        }
      }

      if (!(settings.signal ? settings.signal.aborted : this._cancelled)) {
        const final = await stream.finalMessage();
        // The SDK's final message is provider-reported token accounting, not
        // billing data. A missing or malformed usage object is not a measured
        // zero, so it classifies as `unknown` instead.
        const usable = final.usage && typeof final.usage === 'object' && hasTokenData(final.usage, ['input_tokens', 'output_tokens']);
        const record = {
          call_id: this.nextCallId(),
          provenance: usable ? 'provider_reported' : 'unknown',
          authoritative: false,
          note: usable ? PROVIDER_REPORTED_NOTE : 'The provider returned no usable usage data for this call.',
          call: {
            input_tokens: tokenValue(final.usage?.input_tokens),
            output_tokens: tokenValue(final.usage?.output_tokens),
            cache_read_input_tokens: tokenValue(final.usage?.cache_read_input_tokens),
            cache_creation_input_tokens: tokenValue(final.usage?.cache_creation_input_tokens),
          },
        };
        this.noteUsage(record);
        yield { type: 'usage', usage: record };
        yield { type: 'done', stop_reason: final.stop_reason };
      }
    } finally {
      settings.signal?.removeEventListener('abort', abort);
      if (this.activeStream === stream) this.activeStream = null;
    }
  }

  /** Provider cancellation maps onto scheduler interruption. */
  cancel(reason) {
    this._cancelled = reason;
    try {
      this.activeStream?.abort?.();
      this.activeStream?.controller?.abort?.();
    } catch {
      // The stream may already be finished; cancellation stays best-effort.
    }
    return { cancelled: true, reason };
  }
}

/** Neutral host messages -> Anthropic content blocks. */
export function toAnthropicMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool_results') {
      return {
        role: 'user',
        content: message.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.call_id,
          content: JSON.stringify(r.output),
          is_error: r.output?.ok === false,
        })),
      };
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      }
      return { role: 'assistant', content };
    }
    if (message.role === 'user' && message.images?.length) {
      const content = message.content ? [{ type: 'text', text: message.content }] : [];
      for (const image of message.images) {
        content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
      }
      return { role: 'user', content };
    }
    return { role: message.role, content: message.content };
  });
}

/** Neutral tool descriptors -> Anthropic tool definitions. */
export function toAnthropicTools(tools = []) {
  return tools.map((tool) => ({
    name: tool.name,
    description: `${tool.description}\n\nSide effect: ${tool.side_effect}`,
    input_schema: {
      type: 'object',
      properties: tool.input_schema.properties ?? {},
      required: tool.input_schema.required ?? [],
    },
  }));
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/** The system prompt as one cacheable block. */
export function cacheableSystem(system) {
  if (Array.isArray(system)) return system;
  return [{ type: 'text', text: String(system), cache_control: { type: 'ephemeral' } }];
}

/** A cache breakpoint on the last tool covers the whole tool list. */
export function cacheableTools(tools) {
  if (!tools?.length) return tools;
  return tools.map((tool, index) => (index === tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool));
}
