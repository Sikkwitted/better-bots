import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, renderMarkdown } from '../web/markdown.js';

// A minimal document: enough for renderMarkdown, and it records every node so
// the test can prove no markup is ever parsed from the text.
function fakeDocument() {
  const make = (tag) => ({
    tagName: tag, children: [], attrs: {}, className: '', textContent: '',
    append(...nodes) { this.children.push(...nodes); },
    setAttribute(k, v) { this.attrs[k] = v; },
  });
  return {
    createElement: make,
    createTextNode: (text) => ({ tagName: '#text', textContent: text }),
    createDocumentFragment: () => make('#fragment'),
  };
}
const flat = (node) => [node, ...(node.children ?? []).flatMap(flat)];
const textOf = (node) => node.tagName === '#text' ? node.textContent : node.textContent || (node.children ?? []).map(textOf).join('');

test('blocks: paragraphs, headings, lists, quotes, rules and fenced code', () => {
  const blocks = parseBlocks('# Title\n\nFirst line\nsecond line\n\n- one\n- two\n\n3. three\n4. four\n\n> quoted\n\n---\n\n```js\nconst x = 1;\n```');
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'para', 'list', 'list', 'quote', 'hr', 'code']);
  assert.equal(blocks[1].text, 'First line\nsecond line');
  assert.deepEqual(blocks[2].items, ['one', 'two']);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[3].start, 3);
  assert.deepEqual(blocks[6], { type: 'code', lang: 'js', text: 'const x = 1;' });
});

test('an unclosed fence keeps the rest as code instead of losing it', () => {
  const blocks = parseBlocks('before\n```\nstill code\n# not a heading');
  assert.deepEqual(blocks.at(-1), { type: 'code', lang: '', text: 'still code\n# not a heading' });
});

test('inline: code, strong, em, links and bare URLs', () => {
  const tokens = parseInline('Use `npm test` for **all** of *it*: [docs](https://example.com/a) or https://example.com/b.');
  assert.deepEqual(tokens.map(t => t.t), ['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'link', 'text', 'link', 'text']);
  assert.equal(tokens[7].href, 'https://example.com/a');
  assert.equal(tokens[9].href, 'https://example.com/b', 'trailing punctuation is not part of a bare URL');
});

test('identifiers with underscores and multiplication are not emphasis', () => {
  assert.deepEqual(parseInline('snake_case_name and 2*3*4'), [{ t: 'text', v: 'snake_case_name and 2*3*4' }]);
});

test('unsafe link protocols render as plain text, never as links', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,hi', 'vbscript:x']) {
    const tokens = parseInline(`[click](${href})`);
    assert.deepEqual(tokens, [{ t: 'text', v: `[click](${href})` }]);
  }
});

test('rendering builds nodes only: HTML in the text stays text', () => {
  const doc = fakeDocument();
  const fragment = renderMarkdown(doc, '<img src=x onerror=alert(1)> **bold** [ok](https://example.com)');
  const nodes = flat(fragment);
  assert.ok(!nodes.some(n => n.tagName === 'img'));
  assert.ok(nodes.some(n => n.tagName === '#text' && n.textContent.includes('<img src=x onerror=alert(1)>')));
  const link = nodes.find(n => n.tagName === 'a');
  assert.equal(link.href, 'https://example.com');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.target, '_blank');
  assert.ok(nodes.some(n => n.tagName === 'strong'));
});

test('code blocks offer a copy button that copies the code exactly', () => {
  const doc = fakeDocument();
  let copied = null;
  const fragment = renderMarkdown(doc, '```\n  indented\n\tand tabbed\n```', { onCopyCode: (text) => { copied = text; } });
  const button = flat(fragment).find(n => n.tagName === 'button');
  button.onclick();
  assert.equal(copied, '  indented\n\tand tabbed');
  assert.equal(textOf(flat(fragment).find(n => n.tagName === 'code')), '  indented\n\tand tabbed');
});

test('very long replies fall back to plain text', () => {
  const doc = fakeDocument();
  const fragment = renderMarkdown(doc, '**x** '.repeat(20_000));
  assert.equal(fragment.children.length, 1);
  assert.equal(fragment.children[0].className, 'md-plain');
});
