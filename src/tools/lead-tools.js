// The lead agent returns one answer to the user with the conclusion, evidence,
// and remaining risks: the lead-agent result contract. The host already
// assembles such a packet; this is the tool that lets the lead, and only the
// lead, call it.

export function resultItemText(value) {
  if (Array.isArray(value)) return value.map(resultItemText).join('; ');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, detail]) => {
      const label = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
      return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${resultItemText(detail)}`;
    }).join('; ');
  }
  return String(value);
}

export function assembleResultTool({ host }) {
  return {
    name: 'AssembleResult',
    description:
      'Publish the one answer the person sees: a conclusion, the evidence behind it, and the risks that remain. ' +
      'Call it once, when the work is actually done. Only the lead agent has this tool.',
    side_effect: 'Publishes a visible result packet. No external effect.',
    permission: null,
    enabled_for: (agent) => agent.profile?.lead === true,
    input_schema: {
      type: 'object',
      required: ['conclusion'],
      properties: {
        conclusion: { type: 'string', description: 'The answer, in plain language.' },
        evidence: { type: 'array', description: 'Facts, files, or observations the conclusion rests on.' },
        risks: { type: 'array', description: 'What remains uncertain or undone.' },
      },
    },
    handler({ agent, input, run }) {
      const strings = (value) => (Array.isArray(value) ? value.map(resultItemText).filter(Boolean).slice(0, 40) : []);
      const packet = host.assembleResult({
        lead_agent_id: agent.id,
        conclusion: String(input.conclusion).trim().slice(0, 20_000),
        evidence: strings(input.evidence),
        risks: strings(input.risks),
        run_id: run?.id ?? null,
      });
      return { ok: true, result_id: packet.id, published_at: packet.at };
    },
  };
}

// The interface can show what each agent is doing, but the reason to see an
// agent's screen is to know it is stuck on a CAPTCHA or a login, not to watch
// it work. This is how an agent says so.
export const BLOCKED_REASONS = ['captcha', 'login', 'payment', 'consent', 'unexpected_dialog', 'rate_limited', 'timeout', 'other'];

/** Classify failure metadata, never normal page text or arbitrary nested documents. */
export function blockedToolFailure(result) {
  if (!result || typeof result !== 'object') return null;
  const status = Number(result.status ?? result.http_status ?? result.statusCode);
  if (result.ok !== false && result.isError !== true && !(status >= 400 && status <= 599)) return null;
  const code = typeof result.error === 'string' ? result.error : result.error?.code ?? '';
  const upstreamCode = typeof result.upstream_code === 'string' ? result.upstream_code : '';
  const message = typeof result.message === 'string' ? result.message : result.error?.message ?? '';
  // MCP marks tool-error content as an error message. WebReadPublic page text,
  // shell output, and successful MCP responses are not error messages.
  const errorText = `${code} ${upstreamCode} ${message} ${['tool_error', 'upstream_error'].includes(code) ? result.text ?? '' : ''}`.slice(0, 8_000);
  let reason;
  if (status === 429 || /rate[_ -]?limit|too many requests|\bHTTP(?: error)?\s*429\b|\banswered 429\b/i.test(errorText)) reason = 'rate_limited';
  else if (/captcha|challenge[_ -](?:required|failed|blocked)|human verification|verify (?:that )?you are human/i.test(errorText)) reason = 'captcha';
  else if (status === 401 || /unauthori[sz]ed|authentication[_ -](?:required|failed)|invalid[_ -](?:api[_ -]?key|credentials|token)|(?:login|sign[_ -]?in)[_ -](?:required|again)|not signed in/i.test(errorText)) reason = 'login';
  else if (result.timed_out === true || /(?:^|[_\s])(?:timeout|timed[_ -]out|etimedout)(?:$|[_\s:])/i.test(errorText)) reason = 'timeout';
  else if (status === 403 || code === 'screen_action_failed') reason = 'other';
  else return null;
  const retry = Number(result.retry_after_ms);
  return { reason, ...(Number.isFinite(status) && status >= 400 && status <= 599 ? { status } : {}), ...(Number.isFinite(retry) && retry >= 0 ? { retry_after_ms: retry } : {}) };
}

/** A service quota is shared; a CAPTCHA belongs to the destination website. */
export function blockedToolSource(tool, input = {}, reason = null) {
  let destination = null;
  try { destination = new URL(input.url).hostname; } catch { /* no explicit destination */ }
  const source = tool.integration ?? destination ?? tool.name;
  return reason === 'captcha' && tool.integration && destination ? `${source}:${destination}` : source;
}

export function reportBlockedTool({ host }) {
  const refused = (errors) => ({
    ok: false, error: 'invalid_input', details: errors, recorded: false,
    message: 'Nothing was recorded. Try the next alternative first; if you are still blocked, report again listing each rung you tried and its outcome in ladder.',
  });
  return {
    name: 'ReportBlocked',
    description:
      'Record an in-app attention item for an observed blocker: CAPTCHA, login, payment, consent, unexpected dialog, ' +
      'rate limit, or timeout. State what failed and what work remains. A held screen is attached when available. ' +
      'This records the issue in the app; it does not send an external notification. Continue other available work; do not retry the blocked step. ' +
      'Before reporting, work a ladder of alternatives (another source or tool, another approach, your memory, a peer or your desk lead) ' +
      'and list each rung you tried with its outcome in ladder. A report without a ladder is refused.',
    side_effect: 'Records a visible in-app attention item, with a screenshot when available.',
    permission: null,
    input_schema: {
      type: 'object',
      required: ['reason', 'detail', 'ladder'],
      properties: {
        reason: { type: 'string', enum: BLOCKED_REASONS },
        detail: { type: 'string', description: 'What you were doing and what is in the way.' },
        ladder: {
          type: 'array', minItems: 1, items: { type: 'string' },
          description: 'Each alternative you already tried, in order, with what happened (e.g. "WebReadPublic on the mirror: 403").',
        },
      },
    },
    invalid_input_result: ({ errors }) => refused(errors),
    async handler({ agent, input, run }) {
      const ladder = input.ladder.map((rung) => String(rung).trim().slice(0, 500)).filter(Boolean).slice(0, 20);
      if (!ladder.length) return refused(['field "ladder" must list at least one alternative you tried']);
      const item = await host.reportBlocked({
        agent_id: agent.id,
        reason: input.reason,
        detail: String(input.detail).trim().slice(0, 4_000),
        ladder,
        run_id: run?.id ?? null,
      });
      return {
        ok: true,
        report_id: item.id,
        attention_status: 'recorded',
        ...(item.screenshot ? { screenshot: item.screenshot } : {}),
        note: `An in-app attention item was recorded.${item.screenshot ? ' A screenshot is attached.' : ''} Do not retry the blocked step; continue other available work.`,
      };
    },
  };
}
