import { ModelAdapter, hasTokenData, tokenValue, PROVIDER_REPORTED_NOTE } from './adapter.js';
import { CodexAuth } from './codex-auth.js';

// The Codex backend (a ChatGPT subscription) speaks the Responses API over SSE,
// statelessly: every step sends the whole conversation, including the reasoning
// items the model produced earlier, echoed back exactly. Tool calls arrive as
// `function_call` output items and go back as `function_call_output` inputs.
// Mapped here onto the same neutral events every other adapter yields.

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const ORIGINATOR = 'codex_cli_rs';
const USER_AGENT = 'codex_cli_rs/0.0.0 (better-bots)';

export class CodexAdapter extends ModelAdapter {
  constructor({ model = null, auth = null, base_url = CODEX_BASE_URL, timeout_ms = 600_000, fetchImpl = null, reasoning_effort = null } = {}) {
    super({ provider: 'codex', model });
    this.auth = auth ?? new CodexAuth();
    this.base_url = base_url.replace(/\/$/, '');
    this.timeout_ms = timeout_ms;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.reasoning_effort = reasoning_effort;
    this.controller = null;
  }

  async *stream(messages, tools, settings = {}) {
    this._cancelled = null;
    this._usage.calls += 1;
    const controller = new AbortController();
    this.controller = controller;
    const requestSignal = settings.signal ? AbortSignal.any([controller.signal, settings.signal]) : controller.signal;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`codex request timed out after ${this.timeout_ms}ms without data`)), this.timeout_ms);
    };
    arm();
    try {
      let retried = false;
      for (;;) {
        const { access_token, account_id } = await this.auth.credentials({ force: retried });
        const res = await this.fetchImpl(`${this.base_url}/codex/responses`, {
          method: 'POST',
          signal: requestSignal,
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${access_token}`,
            ...(account_id ? { 'chatgpt-account-id': account_id } : {}),
            originator: ORIGINATOR,
            'user-agent': USER_AGENT,
            origin: 'https://chatgpt.com',
          },
          body: JSON.stringify({
            model: settings.model ?? this.model,
            instructions: settings.system ?? '',
            input: toResponsesInput(messages),
            tools: toResponsesTools(tools),
            tool_choice: 'auto',
            parallel_tool_calls: true,
            reasoning: { summary: 'auto', ...((settings.reasoning_effort ?? this.reasoning_effort) ? { effort: settings.reasoning_effort ?? this.reasoning_effort } : {}) },
            store: false,
            stream: true,
            include: ['reasoning.encrypted_content'],
          }),
        });
        if (res.status === 401 && !retried) { retried = true; continue; }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw Object.assign(new Error(`codex ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
        }
        yield* this.#events(res, settings.signal, arm);
        return;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async *#events(res, signal, onActivity = () => {}) {
    const items = [];      // every completed output item, for the caller to echo back
    let sawText = false;
    let finished = false;
    // One stable id per actual model call, assigned before any terminal frame.
    const callId = this.nextCallId();
    // Deltas are buffered and yielded once per completed item, like the other
    // adapters: the host records each text event, and a token is not a record.
    let text = '';
    let thought = '';
    for await (const event of sse(res.body)) {
      onActivity();
      if (signal ? signal.aborted : this._cancelled) return;
      const type = event.type;
      if (type === 'response.output_text.delta' && event.delta) {
        text += event.delta;
      } else if (type === 'response.reasoning_summary_text.delta' && event.delta) {
        thought += event.delta;
      } else if (type === 'response.output_item.done' && event.item) {
        items.push(event.item);
        if (event.item.type === 'message' && text) {
          sawText = true;
          yield { type: 'text', text };
          text = '';
        } else if (event.item.type === 'reasoning' && thought) {
          yield { type: 'thinking', text: thought };
          thought = '';
        }
        if (event.item.type === 'function_call') {
          yield { type: 'tool_call', id: event.item.call_id, name: event.item.name, input: safeParse(event.item.arguments), item_id: event.item.id };
        }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        if (text) { sawText = true; yield { type: 'text', text }; text = ''; }
        // One actual model call = one stable call id and one final usage
        // record. Repeated terminal frames for the same response are
        // retransmissions, not extra calls, so they are ignored here and
        // cannot double the recorded totals.
        if (finished) continue;
        finished = true;
        const u = event.response?.usage;
        const usable = u && typeof u === 'object' && hasTokenData(u, ['input_tokens', 'output_tokens']);
        const record = {
          call_id: callId,
          provenance: usable ? 'provider_reported' : 'unknown',
          authoritative: false,
          note: usable ? PROVIDER_REPORTED_NOTE : 'No usable usage data in the terminal response.',
          call: {
            input_tokens: tokenValue(u?.input_tokens),
            output_tokens: tokenValue(u?.output_tokens),
            cache_read_input_tokens: tokenValue(u?.input_tokens_details?.cached_tokens),
            cache_creation_input_tokens: 0,
          },
        };
        this.noteUsage(record);
        yield { type: 'usage', usage: record };
        yield { type: 'output_items', items };
        yield { type: 'done', stop_reason: items.some((i) => i.type === 'function_call') ? 'tool_use' : (sawText ? 'end_turn' : 'stop') };
      } else if (type === 'response.failed' || type === 'error') {
        throw new Error(`codex stream error: ${event.response?.error?.message ?? event.message ?? JSON.stringify(event).slice(0, 200)}`);
      }
    }
    if (!finished && !(signal ? signal.aborted : this._cancelled)) throw new Error('codex stream ended before response.completed; the reply may be truncated');
  }

  cancel(reason) {
    super.cancel(reason);
    try { this.controller?.abort(reason); } catch { /* already done */ }
  }
}

/** Parse a text/event-stream body into JSON events. */
export async function* sse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    // SSE allows CRLF line endings (sse-starlette, FastMCP); normalize so events still split.
    buffer = buffer.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* keep-alive or partial */ }
    }
  }
}

/**
 * Neutral messages -> Responses input items. An assistant turn that carried
 * tool calls is echoed as the exact output items the model produced (reasoning
 * included) when the host kept them; otherwise as plain function_call items.
 */
export function toResponsesInput(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool_results') {
      for (const r of message.results) out.push({ type: 'function_call_output', call_id: r.call_id, output: JSON.stringify(r.output) });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      if (message.output_items?.length) {
        out.push(...message.output_items);
      } else {
        if (message.content) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
        for (const call of message.tool_calls) out.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}) });
      }
      continue;
    }
    if (message.role === 'user' && message.images?.length) {
      const content = message.content ? [{ type: 'input_text', text: String(message.content) }] : [];
      for (const image of message.images) {
        content.push({ type: 'input_image', image_url: `data:${image.media_type};base64,${image.data}` });
      }
      out.push({ type: 'message', role: 'user', content });
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    out.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: String(message.content ?? '') }] });
  }
  return out;
}

/** Neutral tool descriptors -> Responses function tools (flat, not nested under `function`). */
export function toResponsesTools(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: `${tool.description}\n\nSide effect: ${tool.side_effect}`,
    parameters: {
      type: 'object',
      properties: tool.input_schema.properties ?? {},
      required: tool.input_schema.required ?? [],
    },
  }));
}

function safeParse(text) {
  if (typeof text !== 'string') return text ?? {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}
