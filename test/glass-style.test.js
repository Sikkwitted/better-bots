import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');

test('glass has an opaque fallback when backdrop filters are unavailable', () => {
  const rule = css.match(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{([\s\S]*?)\n\}/);
  assert.ok(rule, 'no-blur fallback exists');
  assert.match(rule[1], /--panel: var\(--panel-solid\)/);
  assert.match(rule[1], /--chat-bg: var\(--chat-solid\)/);
  assert.match(rule[1], /--bubble: var\(--bubble-solid\)/);
});

test('reduced transparency disables blur and uses opaque surfaces in both themes', () => {
  const rule = css.match(/@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(rule, 'reduced-transparency preference is supported');
  assert.match(rule[1], /--blur: none/);
  assert.match(rule[1], /--panel: var\(--panel-solid\)/);
  assert.match(rule[1], /--chat-bg: var\(--chat-solid\)/);
  assert.match(rule[1], /data-theme="light"/);
});

test('backdrop blur is restricted to shell surfaces, not nested cards or bubbles', () => {
  const allowed = new Set(['.rail', '.chat-head', '.composer', '.ctx-menu', '.banner', '.tabs', '#app-settings', '#app-settings::backdrop']);
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selectors, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/backdrop-filter:/.test(body)) continue;
    for (const selector of selectors.trim().split(/\s*,\s*/)) assert.ok(allowed.has(selector), `unexpected blur layer: ${selector}`);
  }
});

test('Jobs layout explicitly honors hidden and narrow panes', () => {
  assert.match(css, /\.jobs-panel\[hidden\][^{]*\{\s*display: none/);
  assert.match(css, /\.jobs-form\[hidden\]/);
  assert.match(css, /\.transcript\[hidden\][^{]*\{\s*display: none/);
  assert.match(css, /\.jobs-toolbar > \.row\s*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /@container \(max-width: 480px\)/);
  assert.match(css, /\.jobs-form-grid\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('reduced motion stops repeating activity animations rather than accelerating them', () => {
  const rule = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
  assert.match(rule[1], /animation: none !important/);
  assert.match(rule[1], /transition: none !important/);
});

test('danger controls and attachment errors use a theme-aware text color', () => {
  assert.match(css, /\.card \.deny, \.attachment-preview \.attachment-error\s*\{\s*color: var\(--bad\)/);
});

test('workflow manager text follows the active light or dark theme', () => {
  assert.match(css, /#workflow-manager\s*\{[^}]*color: var\(--ink\)/);
  assert.doesNotMatch(css, /#workflow-manager\s*\{[^}]*color: var\(--text/);
});

test('dark glass form labels retain normal-text contrast over layered highlights', () => {
  const root = css.match(/:root \{([\s\S]*?)\n\}/)[1];
  const rgb = value => value.startsWith('#') ? value.slice(1).match(/../g).map(x => parseInt(x, 16)) : value.match(/[\d.]+/g).map(Number);
  const token = name => rgb(root.match(new RegExp(`--${name}: ([^;]+)`))[1]);
  const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
  const luminance = c => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const sheen = rgb(root.match(/--sheen: linear-gradient\(125deg, (rgba\([^)]+\))/)[1]);
  const panelRule = css.match(/\.panel, \.card\s*\{([^}]+)\}/)[1];
  const nested = panelRule.match(/background-image: linear-gradient\(125deg, (rgba\([^)]+\))/);
  const highlight = nested ? rgb(nested[1]) : sheen;
  let surface = blend(token('panel'), blend(token('glow-b'), blend(token('glow-a'), token('bg'))));
  surface = blend(highlight, blend(token('panel-2'), blend(sheen, surface)));
  const ratio = (luminance(token('ink-faint')) + .05) / (luminance(surface) + .05);
  assert.ok(ratio >= 4.5, `layered label contrast ${ratio.toFixed(2)}:1 must be at least 4.5:1`);
});
