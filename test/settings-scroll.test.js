import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))[1];
};

test('settings can shrink and scroll within the center column', () => {
  const settings = rule('.settings');
  assert.match(settings, /min-height:\s*0\s*;/);
  assert.match(settings, /max-height:\s*60dvh\s*;/);
  assert.match(settings, /overflow-y:\s*auto\s*;/);
  assert.match(settings, /overscroll-behavior-y:\s*contain\s*;/);
});

test('desktop grid bounds its row rather than growing with settings content', () => {
  assert.match(rule('.app'), /grid-template-rows:\s*minmax\(0, 1fr\)\s*;/);
});
