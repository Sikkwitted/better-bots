// Plain-English wording for permissions. The host speaks in zones and action ids
// (`local.write_file`, `external.unclassified`); a person deciding whether to let a bot
// do something needs to know what it will do, to what, and what "Always" really covers.

/** What each permission category covers, in the order people think about them. */
export const ZONE_COPY = {
  local: {
    title: 'This computer',
    covers: 'files and commands on the computer that runs Better Bots',
    note: 'Reading and changing files, and running commands, on the computer that runs Better Bots. If Better Bots runs on a server, that means the server, not your Mac.',
  },
  external: {
    title: 'The internet and connected apps',
    covers: 'browsing, messaging, posting, paying, deleting and connected tools',
    note: 'Browsing, sending messages, posting, paying, deleting, and using connected tools.',
  },
  sandbox: {
    title: 'The bots’ own workspace',
    covers: 'work inside the bots’ fenced-off workspace',
    note: 'A fenced-off area where bots can create files and run code. Nothing in it touches the rest of your computer.',
  },
  coordination: {
    title: 'Bots working together',
    covers: 'bots handing tasks to each other',
    note: 'Bots handing tasks to each other.',
  },
};

export const MODE_COPY = {
  ask: { label: 'Ask me first', short: 'asks you first' },
  always: { label: 'Allow without asking', short: 'is allowed without asking' },
  never: { label: 'Always block', short: 'is blocked' },
};

export const zoneTitle = (zone) => ZONE_COPY[zone]?.title ?? zone;

// action -> what the bot wants to do, what the target is, and why it matters.
const ACTIONS = {
  'local.read_file': { does: 'read a file on this computer', label: 'File', risk: 'It can see anything in that file, outside the bots’ safe workspace.' },
  'local.list_directory': { does: 'look inside a folder on this computer', label: 'Folder', risk: 'It can see the names of everything in that folder.' },
  'local.write_file': { does: 'change a file on this computer', label: 'File', risk: 'It will create or overwrite this file, outside the bots’ safe workspace.' },
  'local.run_command': { does: 'run a command on this computer', label: 'Command', risk: 'It runs directly on this computer, outside the bots’ safe workspace.' },
  'external.browser': { does: 'use its web browser', label: 'Action', risk: 'It can click and type on real websites as the browser’s signed-in user.' },
  'external.unclassified': { does: 'use a connected tool', label: 'Request', risk: 'This tool hasn’t been marked safe or read-only, so it could change things in the connected service.' },
  'integration.act': { does: 'make a change in a connected app', label: 'Request', risk: 'It will change something in that app, not just read it.' },
  'external.fetch_dependency': { does: 'download a software package', label: 'Package', risk: 'It downloads the package into the bot’s workspace. Nothing is installed or run.' },
  'external.credentials': { does: 'change a login or account access', label: 'Request', risk: 'This can change who can get into an account.' },
  'external.publish': { does: 'publish something publicly', label: 'What', risk: 'Once published, other people can see it.' },
  'external.pay': { does: 'spend money', label: 'What', risk: 'Money leaves your account. This usually can’t be undone.' },
  'external.send': { does: 'send something outside Better Bots', label: 'What', risk: 'Messages that are sent can’t be taken back.' },
  'external.delete': { does: 'delete something', label: 'What', risk: 'Deleted things may not come back.' },
  'coordination.fanout': { does: 'send this task to another bot or room', label: 'To', risk: 'That bot or room will be able to act on the task.' },
};

const SCREEN_VERBS = {
  click: 'click', double_click: 'double-click', right_click: 'right-click', type: 'type', key: 'press a key',
  scroll: 'scroll', drag: 'drag', move: 'move the mouse', open_url: 'open a web page', navigate: 'go to a web page', wait: 'wait',
};

/** Pretty-print the JSON the host stores as a target; anything else is shown as given. */
function plainTarget(request) {
  const raw = request.target;
  if (raw == null || raw === '') return null;
  if (request.action === 'external.browser') {
    try {
      const t = JSON.parse(raw);
      const verb = SCREEN_VERBS[t.action] ?? String(t.action ?? 'act');
      const detail = t.detail && Object.keys(t.detail).length ? ` — ${Object.entries(t.detail).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}` : '';
      return `${verb}${detail}`;
    } catch { /* fall through to the raw text */ }
  }
  return String(raw);
}

/**
 * The words for one approval card.
 * @param request  the host's approval request
 * @param who      the bot's name
 */
export function describeRequest(request, who = 'This bot') {
  const known = ACTIONS[request.action];
  const zone = request.zone ?? String(request.action ?? '').split('.')[0];
  const category = ZONE_COPY[zone];
  const target = plainTarget(request);
  const connected = request.tool && /__/.test(request.tool) ? request.tool.split('__').join(' → ') : request.tool;
  return {
    headline: `${who} wants to ${known ? known.does : `do something (${String(request.action ?? 'unknown').replace(/[._]/g, ' ')})`}`,
    targetLabel: known?.label ?? 'Details',
    target,
    tool: request.action === 'external.unclassified' || request.action === 'integration.act' ? connected : null,
    risk: known?.risk ?? null,
    highRisk: Boolean(request.high_risk),
    zone,
    category: category?.title ?? zone,
    covers: category?.covers ?? 'this kind of action',
  };
}

/** What each of the four answers does, for the sentence under the buttons. */
export function standingRuleHelp(zone) {
  const title = zoneTitle(zone);
  return `Applies to every bot and everything under “${title}” until you change it in App settings → Permissions.`;
}

export const OUTCOME_TOAST = {
  allow_once: 'Allowed this once.',
  deny: 'Not allowed.',
  always: 'Standing rule saved: always allowed.',
  never: 'Standing rule saved: always blocked.',
};
