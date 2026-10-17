// Chat replies are written in Markdown. This renders the common subset safely:
// it builds DOM nodes (never innerHTML), so model output cannot inject markup,
// and links are limited to http(s) and mailto. The saved text is unchanged.

const SAFE_LINK = /^(https?:|mailto:)/i;
const MAX_RENDERED = 60_000;

/** Split text into blocks: fenced code, headings, lists, quotes, rules, paragraphs. */
export function parseBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'para', text: para.join('\n') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) body.push(lines[j++]);
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
      i = j; // skip the closing fence (or run to the end if it never closes)
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ type: 'hr' }); continue; }
    const item = line.match(/^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/);
    if (item) {
      flush();
      const ordered = Boolean(item[3]);
      const list = { type: 'list', ordered, start: ordered ? Number(item[3]) : 1, items: [item[4]] };
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j].match(/^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/);
        if (next && Boolean(next[3]) === ordered) { list.items.push(next[4]); continue; }
        // An indented continuation line belongs to the previous item.
        if (lines[j].trim() && /^\s{2,}/.test(lines[j]) && !next) { list.items[list.items.length - 1] += `\n${lines[j].trim()}`; continue; }
        break;
      }
      blocks.push(list);
      i = j - 1;
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flush();
      const body = [quote[1]];
      let j = i + 1;
      for (; j < lines.length; j++) { const more = lines[j].match(/^\s*>\s?(.*)$/); if (!more) break; body.push(more[1]); }
      blocks.push({ type: 'quote', text: body.join('\n') });
      i = j - 1;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]])/g;

/** Inline tokens: text, code, strong, em, link. Nested emphasis inside strong/em/link text. */
export function parseInline(text, depth = 0) {
  const out = [];
  const source = String(text ?? '');
  let last = 0;
  const pattern = new RegExp(INLINE.source, 'g');
  for (const m of source.matchAll(pattern)) {
    if (m.index > last) out.push({ t: 'text', v: source.slice(last, m.index) });
    const nest = (inner) => (depth < 4 ? parseInline(inner, depth + 1) : [{ t: 'text', v: inner }]);
    if (m[2] != null) out.push({ t: 'code', v: m[2].replace(/^ (.*) $/, '$1') });
    else if (m[3] != null) {
      if (SAFE_LINK.test(m[4])) out.push({ t: 'link', href: m[4], c: nest(m[3]) });
      else out.push({ t: 'text', v: m[0] });
    }
    else if (m[5] != null || m[6] != null) out.push({ t: 'strong', c: nest(m[5] ?? m[6]) });
    else if (m[7] != null || m[8] != null) out.push({ t: 'em', c: nest(m[7] ?? m[8]) });
    else if (m[9] != null) out.push({ t: 'link', href: m[9], c: [{ t: 'text', v: m[9] }] });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ t: 'text', v: source.slice(last) });
  return out.reduce((merged, token) => {
    const prev = merged.at(-1);
    if (token.t === 'text' && prev?.t === 'text') prev.v += token.v; else merged.push(token);
    return merged;
  }, []);
}

function appendInline(doc, parent, tokens) {
  for (const token of tokens) {
    if (token.t === 'text') {
      const parts = token.v.split('\n');
      parts.forEach((part, i) => { if (i) parent.append(doc.createElement('br')); if (part) parent.append(doc.createTextNode(part)); });
    } else if (token.t === 'code') {
      const code = doc.createElement('code'); code.textContent = token.v; parent.append(code);
    } else if (token.t === 'link') {
      const a = doc.createElement('a');
      a.href = token.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      appendInline(doc, a, token.c); parent.append(a);
    } else {
      const node = doc.createElement(token.t === 'strong' ? 'strong' : 'em');
      appendInline(doc, node, token.c); parent.append(node);
    }
  }
}

/**
 * Render Markdown text into a fragment. `onCopyCode(text)` adds a copy button to
 * code blocks when provided. Very long text is shown as plain text.
 */
export function renderMarkdown(doc, text, { onCopyCode = null } = {}) {
  const fragment = doc.createDocumentFragment();
  const source = String(text ?? '');
  if (source.length > MAX_RENDERED) {
    const pre = doc.createElement('div'); pre.className = 'md-plain'; pre.textContent = source; fragment.append(pre);
    return fragment;
  }
  for (const block of parseBlocks(source)) {
    let node;
    if (block.type === 'code') {
      node = doc.createElement('div'); node.className = 'md-code';
      const pre = doc.createElement('pre'); const code = doc.createElement('code');
      code.textContent = block.text; pre.append(code);
      if (block.lang) { const lang = doc.createElement('span'); lang.className = 'md-lang'; lang.textContent = block.lang; node.append(lang); }
      if (onCopyCode) {
        const copy = doc.createElement('button'); copy.type = 'button'; copy.className = 'ghost small md-copy';
        copy.textContent = 'Copy'; copy.setAttribute('aria-label', 'Copy code');
        copy.onclick = () => onCopyCode(block.text, copy);
        node.append(copy);
      }
      node.append(pre);
    } else if (block.type === 'heading') {
      node = doc.createElement(`h${Math.min(block.level + 2, 6)}`); node.className = 'md-heading';
      appendInline(doc, node, parseInline(block.text));
    } else if (block.type === 'list') {
      node = doc.createElement(block.ordered ? 'ol' : 'ul');
      if (block.ordered && block.start !== 1) node.start = block.start;
      for (const item of block.items) { const li = doc.createElement('li'); appendInline(doc, li, parseInline(item)); node.append(li); }
    } else if (block.type === 'quote') {
      node = doc.createElement('blockquote'); appendInline(doc, node, parseInline(block.text));
    } else if (block.type === 'hr') {
      node = doc.createElement('hr');
    } else {
      node = doc.createElement('p'); appendInline(doc, node, parseInline(block.text));
    }
    fragment.append(node);
  }
  return fragment;
}
