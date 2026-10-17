import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The console names each concept with one word: Bot, Room, Desk, Routine. These
// read the console's visible text and fail if an older synonym creeps back in.
// Identifiers (ids, classes, data-* attributes, API paths, JSON fields) keep their
// old names on purpose and are not visible text, so they are stripped first.

const OLD_WORDS = /\b(agents?|groups?|workflows?|jobs?)\b/i;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Visible text in markup: element text plus the attributes a person reads or hears.
function htmlText(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const out = [];
  for (const [, attrs] of body.matchAll(/<[a-z][^>]*?(\s[^>]*)?>/gi)) {
    for (const [, , value] of (attrs ?? '').matchAll(/\s(placeholder|title|aria-label|alt)="([^"]*)"/gi)) out.push(value);
  }
  for (const text of body.replace(/<[^>]*>/g, '\n').split('\n')) if (text.trim()) out.push(text.trim());
  return out;
}

// String literals in a module, skipping comments. Template literals contribute their
// static parts; strings inside ${…} are read as literals of their own.
function jsStrings(source) {
  const out = [];
  const stack = []; // brace depths of open template ${…} expressions
  let i = 0, depth = 0;
  const readTemplate = () => {
    let piece = '';
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { piece += source.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { i++; out.push(piece); return; }
      if (c === '$' && source[i + 1] === '{') { i += 2; out.push(piece); stack.push(depth); depth++; return; }
      piece += c; i++;
    }
  };
  while (i < source.length) {
    const c = source[i], n = source[i + 1];
    if (c === '/' && n === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = source.indexOf('*/', i) + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (source[j] !== c) { if (source[j] === '\\') { s += source[j + 1]; j += 2; } else s += source[j++]; }
      out.push(s); i = j + 1; continue;
    }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (stack.length && stack.at(-1) === depth) { stack.pop(); i++; readTemplate(); continue; }
    }
    i++;
  }
  assert.equal(stack.length, 0, 'the string scanner lost its place in a template literal');
  return out;
}

// Ids, class lists, selectors and paths are code, not copy: one bare lowercase token
// ("agent"), or tokens that each carry a hyphen, underscore, dot or hash ("jobs-error",
// "job-state is-fired", "#agent-list button.agent"). A word with space beside it, such
// as the " workflow" in `${n} workflow${s}`, is copy.
const looksLikeCode = (s) => /^[a-z0-9_$.#:/=[\]"-]*$/.test(s)
  || s.trim().split(/\s+/).every((t) => /[-_.#]/.test(t) && /^[a-z0-9_$.#:/=[\]",-]+$/.test(t))
  || /^\.{0,2}\//.test(s.trim());

// Explicit exceptions, each with its reason. Keep this short.
const ALLOWED = new Set([
]);

function offenders(strings) {
  return strings.filter((s) => s.trim() && !looksLikeCode(s) && OLD_WORDS.test(s) && !ALLOWED.has(s.trim())).map((s) => s.trim());
}

test('the console page names bots, rooms, desks and routines with one word each', () => {
  const html = read('web/index.html');
  const text = htmlText(html);
  // The scanner really sees the visible labels.
  for (const label of ['Bots', 'Rooms', 'Desks', 'All routines', 'Routines', 'No bot selected', 'Manage desks']) {
    assert.ok(text.includes(label), `index.html shows "${label}"`);
  }
  assert.deepEqual(offenders(text), []);
});

for (const file of ['web/workflow-copy.js', 'web/permission-copy.js', 'web/workflows.js', 'web/jobs.js', 'web/app.js']) {
  test(`${file} copy uses Bot, Room, Desk and Routine`, () => {
    const strings = jsStrings(read(file));
    assert.ok(strings.length > 10, `found string literals in ${file}`);
    assert.deepEqual(offenders(strings), []);
  });
}

test('the copy check catches the old words and ignores identifiers', () => {
  assert.deepEqual(offenders(htmlText('<h1>Agents</h1><button id="all-jobs" class="ghost">All routines</button><p title="New job">x</p>')), ['New job', 'Agents']);
  assert.deepEqual(offenders(jsStrings("el('p', 'jobs-empty', 'No jobs yet.'); $(`#jobs-${id}`); x = `${n} workflow${n === 1 ? '' : 's'}`;")), ['No jobs yet.', 'workflow']);
});
