import { ModelAdapter, hasTokenData, tokenValue, PROVIDER_REPORTED_NOTE } from './adapter.js';
import { PROVIDERS } from '../../web/models.js';

// A second provider adapter, proving the same seam from the other side: the
// host swaps the model layer without touching memory, messaging, meetings, or
// permissions. Nothing here imports a service.
//
// This speaks the OpenAI chat-completions shape, which is what Ollama, OpenRouter,
// LM Studio, vLLM, and most local runtimes serve. Zero dependencies: Node's fetch
// plus about forty lines of SSE parsing.

const DONE = '[DONE]';

/**
 * Whether a 400's diagnostics explicitly reject the usage-request field —
 * "unknown field: stream_options", "'include_usage' is not supported",
 * "extra fields not permitted" naming it — as opposed to an unrelated failure
 * that happens to echo the request body, where the field name appears as JSON
 * (`"stream_options":`). Echoes are never the field being rejected.
 */
function rejectsUsageField(detail) {
  const before = /(?:unknown|unexpected|unrecognized|unsupported|invalid|extra|not permitted|not supported)[^\n]{0,40}(?:stream_options|include_usage)/i;
  const nearby = /(?:stream_options|include_usage)["']?[^\n]{0,60}(?:unknown|unexpected|unrecognized|unsupported|invalid|extra|not permitted|not supported|rejected)/i;
  const echoedJson = /"\s*:\s*\{?\s*"?(?:stream_options|include_usage)["']?\s*:/i;
  return (before.test(detail) || nearby.test(detail)) && !echoedJson.test(detail);
}

// The status travels on the error so the host can tell a passing rate limit from a real refusal.
function requestError(provider, model, status, detail) {
  return Object.assign(describeRequestError(provider, model, status, detail), { status });
}

function describeRequestError(provider, model, status, detail) {
  if (provider !== 'openrouter') return new Error(`${provider} returned ${status}: ${detail.slice(0, 300)}`);

  let error;
  try { error = JSON.parse(detail)?.error; } catch { /* Do not display an unstructured response body. */ }
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const generic = /^(?:provider returned error|provider error|upstream error|error)$/i.test(message);
  const raw = error?.metadata?.raw;
  const candidate = generic && typeof raw === 'string' ? raw : message;
  // Provider text can contain a URL, request echo, or secrets. Keep only the
  // first plain sentence; fall back to a fixed message if it is not safe.
  const firstSentence = candidate.split(/\bhttps?:\/\/|[\r\n]/, 1)[0].split(/(?<=[.!?])\s+/, 1)[0].trim();
  const unsafe = /[{}[\]"`]|\b(?:authorization|bearer|api[_ -]?key|password|prompt|messages|request body)\b/i;
  const reason = firstSentence && firstSentence.length <= 180 && !unsafe.test(firstSentence)
    ? firstSentence
    : 'Provider request failed';
  const modelLabel = typeof model === 'string' && /^[\w./:+-]{1,120}$/.test(model) ? ` (${model})` : '';
  return new Error(`openrouter${modelLabel} returned ${status}: ${reason}`);
}

export class OpenAICompatAdapter extends ModelAdapter {
  constructor({
    provider = 'local',
    model = null,
    apiKey = null,
    // A custom provider supplies its own endpoint and key name; built-ins
    // still resolve through PROVIDERS so one adapter serves them all.
    base_url = null,
    key_env = null,
    max_tokens = 8192,
    timeout_ms = 600_000,
    fetchImpl = null,
  } = {}) {
    super({ provider, model });
    this.apiKey = apiKey;
    this.base_url = base_url;
    this.key_env = key_env;
    this.max_tokens = max_tokens;
    this.timeout_ms = timeout_ms;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.controller = null;
  }

  #endpoint(provider) {
    const spec = PROVIDERS[provider] ?? PROVIDERS[this.provider];
    const base = this.base_url ?? spec?.base_url;
    if (!base) throw new Error(`provider ${provider} has no base_url`);
    return `${base.replace(/\/$/, '')}/chat/completions`;
  }

  #key(provider) {
    const spec = PROVIDERS[provider] ?? PROVIDERS[this.provider];
    const names = this.key_env ?? spec?.key_env ?? [];
    return names.map((name) => process.env[name]).find(Boolean) ?? this.apiKey;
  }

  async *stream(messages, tools, settings = {}) {
    const provider = settings.provider ?? this.provider;
    const model = settings.model ?? this.model;
    this._cancelled = null;
    this._usage.calls += 1;

    const controller = new AbortController();
    this.controller = controller;
    const requestSignal = settings.signal ? AbortSignal.any([controller.signal, settings.signal]) : controller.signal;
    // Idle timeout: re-armed on every chunk, so a long but healthy stream is not cut off.
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`${provider} request timed out after ${this.timeout_ms}ms without data`)), this.timeout_ms);
    };
    arm();

    const headers = { 'Content-Type': 'application/json' };
    const key = this.#key(provider);
    // Local runtimes need no credential; hosted ones do.
    if (key) headers.Authorization = `Bearer ${key}`;

    // Ask the provider for its token counts instead of guessing.
    // Runtimes that reject the unknown field get one fallback request without it.
    let includeUsage = true;
    let response;
    for (;;) {
      const body = {
        model,
        // OpenAI's newer models reject max_tokens; compatible gateways still expect it.
        ...(provider === 'openai' ? { max_completion_tokens: this.max_tokens } : { max_tokens: this.max_tokens }),
        stream: true,
        messages: toOpenAIMessages(messages, settings.system),
        ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      };
      try {
        response = await this.fetchImpl(this.#endpoint(provider), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: requestSignal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (this.controller === controller) this.controller = null;
        throw err;
      }
      if (response.status === 400 && includeUsage) {
        // Retry without stream_options only when the provider's diagnostics
        // explicitly reject that field. A 400 that merely echoes the request
        // body (an invalid model, say) names the field too — but as JSON —
        // and is a real failure that keeps its message.
        const detail = await response.text().catch(() => '');
        if (!rejectsUsageField(detail)) {
          clearTimeout(timer);
          if (this.controller === controller) this.controller = null;
          throw requestError(provider, model, response.status, detail);
        }
        includeUsage = false;
        continue;
      }
      break;
    }

    if (!response.ok) {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
      const detail = await response.text().catch(() => '');
      throw requestError(provider, model, response.status, detail);
    }

    // A text event becomes one transcript entry, so the whole message is
    // emitted once at the end rather than per token — otherwise a single reply
    // would land in the transcript as hundreds of fragments.
    let text = '';
    const calls = new Map();
    let stopReason = 'end_turn';
    let usage = null;
    let complete = false;

    try {
      for await (const event of readSSE(response.body)) {
        arm();
        if (settings.signal ? settings.signal.aborted : this._cancelled) break;
        if (event === DONE) { complete = true; break; }

        let chunk;
        try {
          chunk = JSON.parse(event);
        } catch {
          continue; // keep-alive or comment line
        }

        if (chunk.error) throw new Error(`${provider} stream error: ${String(chunk.error.message ?? chunk.error.code ?? 'unknown').slice(0, 200)}`);
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        if (delta.content) text += delta.content;
        // DeepSeek, OpenRouter, and local runtimes stream reasoning under one of these.
        const thought = delta.reasoning_content ?? delta.reasoning ?? null;
        if (thought) yield { type: 'thinking', text: String(thought) };

        for (const call of delta.tool_calls ?? []) {
          // Some gateways omit `index`; key by id, else continue the latest call.
          const key = call.index ?? (call.id && ![...calls.values()].some((s) => s.id === call.id) ? `id:${call.id}` : [...calls.keys()].at(-1) ?? 0);
          const slot = calls.get(key) ?? { id: null, name: '', args: '' };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.args += call.function.arguments;
          calls.set(key, slot);
        }

        if (choice.finish_reason) {
          complete = true;
          stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
        }
      }
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }

    if (settings.signal ? settings.signal.aborted : this._cancelled) return;
    if (!complete) throw new Error(`${provider} stream ended before completion; the reply may be truncated`);

    // One final usage record per call. A provider frame is provider-reported
    // token accounting — useful, but not billing data — so it classifies as
    // `provider_reported` and replaces the estimate rather than adding to it.
    // A frame without usable numbers is not a measured zero; it falls through
    // to the estimate, or to `unknown` when there is nothing to estimate from.
    const callId = this.nextCallId();
    const framed = usage && typeof usage === 'object' && hasTokenData(usage, ['prompt_tokens', 'completion_tokens']);
    let record;
    if (framed) {
      record = {
        call_id: callId,
        provenance: 'provider_reported',
        authoritative: false,
        note: PROVIDER_REPORTED_NOTE,
        call: {
          input_tokens: tokenValue(usage.prompt_tokens),
          output_tokens: tokenValue(usage.completion_tokens),
          cache_read_input_tokens: tokenValue(usage.prompt_tokens_details?.cached_tokens),
          cache_creation_input_tokens: 0,
        },
      };
    } else {
      // Tool calls are output too: their names and serialized arguments are
      // the only available basis when the provider stayed silent. The result
      // is an approximation and is labeled as one.
      const outputCharacters = text.length
        + [...calls.values()].reduce((n, slot) => n + (slot.name?.length ?? 0) + (slot.args?.length ?? 0), 0);
      if (outputCharacters > 0) {
        record = {
          call_id: callId,
          provenance: 'estimated',
          authoritative: false,
          note: 'Estimated from output length including tool-call arguments; the provider sent no usage data. Approximate, not measured.',
          call: { input_tokens: 0, output_tokens: Math.ceil(outputCharacters / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      } else {
        record = {
          call_id: callId,
          provenance: 'unknown',
          authoritative: false,
          note: 'No provider usage data and no output to estimate from.',
          call: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      }
    }
    this.noteUsage(record);

    if (text) yield { type: 'text', text };
    for (const slot of calls.values()) {
      yield { type: 'tool_call', id: slot.id, name: slot.name, input: safeParse(slot.args) };
    }
    yield { type: 'usage', usage: record };
    yield { type: 'done', stop_reason: stopReason };
  }

  /** Provider cancellation maps onto scheduler interruption. */
  cancel(reason) {
    const result = super.cancel(reason);
    try {
      this.controller?.abort(reason);
    } catch { /* already gone */ }
    return result;
  }
}

/** Read an SSE body and yield each `data:` payload. */
export async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith('data:')) yield rest.slice(5).trim();
}

/** Neutral messages -> OpenAI chat messages. The system prompt leads. */
export function toOpenAIMessages(messages, system) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (message.role === 'tool_results') {
      for (const result of message.results) {
        out.push({
          role: 'tool',
          tool_call_id: result.call_id,
          content: JSON.stringify(result.output),
        });
      }
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        })),
      });
      continue;
    }
    if (message.role === 'user' && message.images?.length) {
      const content = message.content ? [{ type: 'text', text: message.content }] : [];
      for (const image of message.images) {
        content.push({ type: 'image_url', image_url: { url: `data:${image.media_type};base64,${image.data}` } });
      }
      out.push({ role: 'user', content });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

/** Neutral tool descriptors -> OpenAI function definitions. */
export function toOpenAITools(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: `${tool.description}\n\nSide effect: ${tool.side_effect}`,
      parameters: {
        type: 'object',
        properties: tool.input_schema.properties ?? {},
        required: tool.input_schema.required ?? [],
      },
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
