import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Layout bugs that hid real controls. The last rule for a selector wins, so these read
// the final declarations, not the first.

const css = fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const lastRule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  return matches.at(-1)?.[1] ?? '';
};

test('the chat header grows and wraps instead of clipping its buttons and chips', () => {
  assert.match(lastRule('.chat-head'), /height:\s*auto/);
  assert.doesNotMatch(lastRule('.chat-head'), /overflow:\s*hidden/);
  assert.match(lastRule('#chat-meta'), /flex-wrap:\s*wrap/);
  assert.doesNotMatch(lastRule('#chat-meta'), /overflow-x:\s*auto/);
});

test('the roster header wraps so "+ Add" can never be pushed out of the panel', () => {
  assert.match(lastRule('.rail-left .rail-head'), /flex-wrap:\s*wrap/);
  assert.match(lastRule('.rail-head .row'), /flex-wrap:\s*wrap/);
});

test('mid-size windows keep the roster wide enough for its buttons', () => {
  const tier = css.match(/@media \(min-width: 821px\) and \(max-width: 1180px\) \{([\s\S]*?)\n\}/g).at(-1);
  const left = Number(tier.match(/\.app \{ grid-template-columns: (\d+)px/)[1]);
  assert.ok(left >= 248, `the roster is ${left}px; below 248px the Agents buttons do not fit on a row`);
});
