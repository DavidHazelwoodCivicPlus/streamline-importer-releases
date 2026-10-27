'use strict';
// Converts D10 body HTML into what amplifyUpsertFreeformContent takes: Lexical JSON plus matching HTML.
// Node shapes for text, paragraph, heading, quote, link (decorated-link-node), table and image come from
// Streamline Demo Tool 0.2.0, which was checked against the editor. List and linebreak nodes use Lexical's
// standard shapes (docs/api.md marks them as needing a capture to confirm).
// Pure: links and images are resolved by functions the caller passes in. Anything that cannot be carried
// over is dropped and reported as a warning, never guessed.

const { parseHtml } = require('./html');

const FORMAT = { bold: 1, italic: 2, strikethrough: 4, underline: 8, code: 16, subscript: 32, superscript: 64 };
const TAG_FORMAT = {
  b: FORMAT.bold, strong: FORMAT.bold, i: FORMAT.italic, em: FORMAT.italic, cite: FORMAT.italic, dfn: FORMAT.italic, var: FORMAT.italic,
  u: FORMAT.underline, ins: FORMAT.underline, s: FORMAT.strikethrough, strike: FORMAT.strikethrough, del: FORMAT.strikethrough,
  sub: FORMAT.subscript, sup: FORMAT.superscript, code: FORMAT.code, kbd: FORMAT.code, tt: FORMAT.code, samp: FORMAT.code
};
// Inline wrappers that carry no format of their own: unwrapped (their style may still add bold/italic/underline).
const UNWRAP_INLINE = new Set(['span', 'font', 'small', 'big', 'mark', 'abbr', 'acronym', 'q', 'label', 'time', 'bdi', 'bdo', 'data', 'nobr', 'o:p']);
// Block wrappers: content becomes ordinary blocks.
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center', 'address', 'figure',
  'figcaption', 'dd', 'dt', 'dl', 'details', 'summary', 'fieldset', 'legend', 'li', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption', 'body', 'html']);
// Dropped with their content, and reported.
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'noscript',
  'video', 'audio', 'canvas', 'svg', 'map', 'area', 'head', 'meta', 'link', 'title', 'colgroup', 'col', 'source', 'track', 'picture']);

const textNode = (text, format) => ({ detail: 0, format: format || 0, mode: 'normal', style: '', text, type: 'text', version: 1 });
const paragraph = (children, format) => ({ children, direction: 'ltr', format: format == null ? 'start' : format, indent: 0, type: 'paragraph', version: 1, textFormat: 0, textStyle: '' });
const linebreak = () => ({ type: 'linebreak', version: 1 });

const ALIGN = { left: 'left', center: 'center', right: 'right', justify: 'justify', start: 'start', end: 'end' };
function alignOf(attrs) {
  const m = /text-align\s*:\s*([a-z]+)/i.exec(attrs.style || '');
  return ALIGN[(m ? m[1] : attrs.align || '').toLowerCase()] || null;
}
function styleFormat(attrs) {
  const st = (attrs.style || '').toLowerCase();
  let f = 0;
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(st)) f |= FORMAT.bold;
  if (/font-style\s*:\s*italic/.test(st)) f |= FORMAT.italic;
  if (/text-decoration[^;]*underline/.test(st)) f |= FORMAT.underline;
  if (/text-decoration[^;]*line-through/.test(st)) f |= FORMAT.strikethrough;
  return f;
}

// opts: {
//   resolveLink(href, attrs) -> { url, external, target? } | null   (null: drop the link, keep its text)
//   resolveImage(attrs)      -> { id, url, altText } | null           (null: drop the image)
//   resolveEmbed(attrs)      -> { kind: 'image', id, url, altText } | { kind: 'link', url, text, external } | null   (<drupal-media>)
// }
// Returns { json, html, warnings: [{code, detail}], links: [{href, url}] }
function convertHtml(input, opts) {
  opts = opts || {};
  const warnings = [];
  const warn = (code, detail) => warnings.push({ code, detail: String(detail || '') });
  const links = [];
  const root = parseHtml(input);

  const state = newState((atoms, ctx) => blockFromAtoms(atoms, 'paragraph', null, ctx));
  walk(root.children, { format: 0, link: null, align: null, pre: false, flat: false, inTable: false }, state);
  flush(state, {});
  let children = state.out;
  if (!children.length) children = [paragraph([])];
  const json = { root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } };
  return { json, html: renderBlocks(children), warnings, links };

  function newState(make) { return { out: [], buf: [], make }; }
  function flush(st, ctx) {
    const atoms = st.buf; st.buf = [];
    const made = st.make(atoms, ctx);
    if (made) st.out.push(made);
  }

  // Walks nodes, collecting inline atoms into st.buf and finished blocks into st.out.
  function walk(nodes, ctx, st) {
    for (const n of nodes) {
      if (n.type === 'text') { pushText(n.text, ctx, st); continue; }
      const t = n.tag;
      if (DROP.has(t)) { warn('dropped-' + t, describe(n)); continue; }
      if (t === 'br') { st.buf.push({ br: true, link: ctx.link }); continue; }
      if (t === 'wbr') continue;
      if (t === 'img') { image(n.attrs, ctx, st); continue; }
      if (t === 'drupal-media') { embed(n.attrs, ctx, st); continue; }
      if (t === 'a') { anchor(n, ctx, st); continue; }
      if (TAG_FORMAT[t] || UNWRAP_INLINE.has(t)) {
        walk(n.children, Object.assign({}, ctx, { format: ctx.format | (TAG_FORMAT[t] || 0) | styleFormat(n.attrs) }), st);
        continue;
      }
      if (t === 'hr') { flush(st, ctx); warn('dropped-hr', 'horizontal rule'); continue; }
      if (!ctx.flat && /^h[1-6]$/.test(t)) {
        flush(st, ctx);
        let tag = t;
        if (t === 'h1') { tag = 'h2'; warn('h1-demoted', textOf(n)); }
        const sub = newState(atoms => blockFromAtoms(atoms, 'heading', tag));
        walk(n.children, Object.assign({}, ctx, { format: ctx.format }), sub);
        flush(sub, ctx);
        st.out.push(...sub.out);
        continue;
      }
      if (!ctx.flat && t === 'blockquote') {
        flush(st, ctx);
        const sub = newState(atoms => blockFromAtoms(atoms, 'quote'));
        walk(n.children, ctx, sub);
        flush(sub, ctx);
        st.out.push(...sub.out);
        continue;
      }
      if (t === 'ul' || t === 'ol') {
        flush(st, ctx);
        if (ctx.flat) { walk(n.children, ctx, st); flush(st, ctx); continue; } // a list inside a table cell: flattened
        st.out.push(list(n, ctx, 0));
        continue;
      }
      if (t === 'table') {
        flush(st, ctx);
        if (ctx.inTable || ctx.flat) { warn('nested-table-flattened', textOf(n).slice(0, 80)); walk(n.children, ctx, st); flush(st, ctx); continue; }
        const tb = table(n, ctx);
        if (tb.caption) st.out.push(tb.caption);
        if (tb.node) st.out.push(tb.node);
        continue;
      }
      if (t === 'pre') {
        flush(st, ctx);
        walk(n.children, Object.assign({}, ctx, { pre: true }), st);
        flush(st, ctx);
        continue;
      }
      if (BLOCKS.has(t) || /^h[1-6]$/.test(t) || t === 'blockquote') {
        flush(st, ctx);
        const c = Object.assign({}, ctx, { align: alignOf(n.attrs) || ctx.align });
        walk(n.children, c, st);
        flush(st, c);
        continue;
      }
      warn('unwrapped-' + t, describe(n));
      walk(n.children, ctx, st);
    }
  }

  function pushText(text, ctx, st) {
    let s = text.replace(/ /g, ' ');
    if (ctx.pre) {
      s.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
        if (i) st.buf.push({ br: true, link: ctx.link });
        if (line) st.buf.push({ text: line, format: ctx.format, link: ctx.link, pre: true });
      });
      return;
    }
    s = s.replace(/[\s​]+/g, ' ');
    if (s) st.buf.push({ text: s, format: ctx.format, link: ctx.link });
  }

  function anchor(n, ctx, st) {
    const href = (n.attrs.href || '').trim();
    if (!href) { walk(n.children, ctx, st); return; } // named anchor
    const r = opts.resolveLink ? opts.resolveLink(href, n.attrs) : { url: href, external: /^https?:/i.test(href) };
    links.push({ href, url: r ? r.url : null });
    if (!r) { walk(n.children, ctx, st); return; }
    const target = r.target !== undefined ? r.target : (n.attrs.target === '_blank' ? '_blank' : null);
    walk(n.children, Object.assign({}, ctx, { link: { url: r.url, external: !!r.external, target } }), st);
  }

  function image(attrs, ctx, st) {
    const r = opts.resolveImage ? opts.resolveImage(attrs) : null;
    if (!r) { warn('dropped-image', attrs.src || ''); return; }
    flush(st, ctx);
    st.out.push(imageBlock(r));
  }

  function embed(attrs, ctx, st) {
    const r = opts.resolveEmbed ? opts.resolveEmbed(attrs) : null;
    if (!r) { warn('dropped-embed', attrs['data-entity-uuid'] || ''); return; }
    if (r.kind === 'image') { flush(st, ctx); st.out.push(imageBlock(r)); return; }
    const link = { url: r.url, external: !!r.external, target: null };
    st.buf.push({ text: r.text || r.url, format: ctx.format, link });
    links.push({ href: 'drupal-media:' + (attrs['data-entity-uuid'] || ''), url: r.url });
  }

  function imageBlock(r) {
    return paragraph([{ type: 'resizeable-image', altText: r.altText || '', imageId: r.id, version: 1, position: 'center', src: r.url, uncroppedSrc: r.url }]);
  }

  // Turns collected atoms into inline Lexical nodes: whitespace trimmed, adjacent text merged, links grouped.
  function inlineNodes(atoms) {
    const a = [];
    for (const x of atoms) {
      if (x.br) { a.push(x); continue; }
      let text = x.text;
      if (!x.pre) {
        const prev = a[a.length - 1];
        if (!prev || prev.br || /\s$/.test(prev.text)) text = text.replace(/^ +/, '');
      }
      if (text) a.push(Object.assign({}, x, { text }));
    }
    // Trailing spaces at the end and before line breaks.
    for (let i = a.length - 1; i >= 0; i--) {
      const next = a[i + 1];
      if (!a[i].br && !a[i].pre && (!next || next.br)) a[i] = Object.assign({}, a[i], { text: a[i].text.replace(/ +$/, '') });
    }
    const b = a.filter(x => x.br || x.text);
    while (b.length && b[b.length - 1].br) b.pop(); // trailing <br>
    while (b.length && b[0].br) b.shift();
    if (!b.some(x => !x.br)) return [];

    const out = [];
    let curLink = null, linkNode = null;
    const target = () => (linkNode ? linkNode.children : out);
    for (const x of b) {
      if (x.link !== curLink) {
        curLink = x.link;
        linkNode = curLink ? { children: [], direction: 'ltr', format: '', indent: 0, rel: null, target: curLink.target, title: null, type: 'decorated-link-node', url: curLink.url, version: 1, external: curLink.external } : null;
        if (linkNode) out.push(linkNode);
      }
      const into = target();
      if (x.br) { into.push(linebreak()); continue; }
      const last = into[into.length - 1];
      if (last && last.type === 'text' && last.format === x.format) last.text += x.text;
      else into.push(textNode(x.text, x.format));
    }
    return out.filter(n => n.type !== 'decorated-link-node' || n.children.length);
  }

  function blockFromAtoms(atoms, kind, tag, ctx) {
    const kids = inlineNodes(atoms);
    if (!kids.length) return null;
    if (kind === 'heading') return { children: kids, direction: 'ltr', format: 'start', indent: 0, tag, type: 'heading', version: 1 };
    if (kind === 'quote') return { children: kids, direction: 'ltr', format: 'start', indent: 0, type: 'quote', version: 1 };
    return paragraph(kids, (ctx && ctx.align) || 'start');
  }

  // Lexical lists: a nested list sits in its own listitem right after the item it belongs to.
  function list(n, ctx, depth) {
    const listType = n.tag === 'ol' ? 'number' : 'bullet';
    const start = n.tag === 'ol' ? Math.max(1, parseInt(n.attrs.start, 10) || 1) : 1;
    const items = [];
    let value = start;
    const lis = n.children.filter(c => !(c.type === 'text' && !c.text.trim()));
    for (const li of lis) {
      const kids = li.type === 'element' && li.tag === 'li' ? li.children : [li];
      const nested = [], rest = [];
      for (const k of kids) (k.type === 'element' && (k.tag === 'ul' || k.tag === 'ol') ? nested : rest).push(k);
      const sub = newState(atoms => atoms.length ? atoms : null);
      walk(rest, Object.assign({}, ctx, { flat: true }), sub);
      flush(sub, ctx);
      const joined = [];
      sub.out.forEach((atoms, i) => { if (i) joined.push({ br: true, link: null }); joined.push(...atoms); });
      const inl = inlineNodes(joined);
      if (inl.length || !nested.length) items.push({ children: inl, direction: 'ltr', format: '', indent: depth, type: 'listitem', value: value++, version: 1 });
      for (const nl of nested) items.push({ children: [list(nl, ctx, depth + 1)], direction: 'ltr', format: '', indent: depth, type: 'listitem', value, version: 1 });
    }
    return { children: items, direction: 'ltr', format: '', indent: 0, listType, start, tag: n.tag, type: 'list', version: 1 };
  }

  function table(n, ctx) {
    const rows = [];
    let caption = null;
    const collect = (nodes, inHead) => {
      for (const c of nodes) {
        if (c.type !== 'element') continue;
        if (c.tag === 'tr') rows.push({ el: c, inHead });
        else if (c.tag === 'thead') collect(c.children, true);
        else if (c.tag === 'tbody' || c.tag === 'tfoot') collect(c.children, false);
        else if (c.tag === 'caption') {
          const sub = newState(atoms => blockFromAtoms(atoms, 'paragraph'));
          walk(c.children, ctx, sub); flush(sub, ctx);
          caption = sub.out[0] || null;
        }
      }
    };
    collect(n.children, false);
    if (!rows.length) { warn('empty-table', ''); return { caption, node: null }; }
    const cellCtx = Object.assign({}, ctx, { inTable: true });
    const grid = rows.map(r => r.el.children.filter(c => c.type === 'element' && (c.tag === 'td' || c.tag === 'th')));
    const headerColumn = grid.length > 1 && grid.every(cells => cells[0] && cells[0].tag === 'th');
    let width = 0;
    const out = grid.map((cells, ri) => {
      const headerRow = rows[ri].inHead || (cells.length > 0 && cells.every(c => c.tag === 'th'));
      const lexCells = cells.map((c, ci) => {
        const sub = newState(atoms => { const k = inlineNodes(atoms); return k.length ? paragraph(k, '') : null; });
        walk(c.children, cellCtx, sub); flush(sub, cellCtx);
        let hs = 0;
        if (c.tag === 'th') { if (headerRow) hs |= 1; if (ci === 0 && headerColumn) hs |= 2; if (!hs) hs = 1; }
        const colSpan = Math.max(1, parseInt(c.attrs.colspan, 10) || 1), rowSpan = Math.max(1, parseInt(c.attrs.rowspan, 10) || 1);
        if (rowSpan > 1) warn('table-rowspan', 'row ' + (ri + 1));
        return {
          children: sub.out.length ? sub.out : [paragraph([], '')], colSpan, rowSpan, headerState: hs,
          backgroundColor: null, direction: 'ltr', format: '', indent: 0, type: 'tablecell', version: 1
        };
      });
      width = Math.max(width, lexCells.reduce((s, c) => s + c.colSpan, 0));
      return lexCells;
    });
    // Lexical needs every row to be as wide as the widest one.
    const tableRows = out.map(cells => {
      const have = cells.reduce((s, c) => s + c.colSpan, 0);
      for (let k = have; k < width; k++) cells.push({ children: [paragraph([], '')], colSpan: 1, rowSpan: 1, headerState: 0, backgroundColor: null, direction: 'ltr', format: '', indent: 0, type: 'tablecell', version: 1 });
      return { children: cells, direction: 'ltr', format: '', indent: 0, type: 'tablerow', version: 1 };
    });
    return { caption, node: { children: tableRows, colWidths: Array(width).fill(92), direction: 'ltr', format: '', indent: 0, type: 'table', version: 1 } };
  }

  function describe(n) { return '<' + n.tag + (n.attrs.src ? ' src="' + n.attrs.src + '"' : '') + '> ' + textOf(n).slice(0, 60); }
}

function textOf(n) {
  if (n.type === 'text') return n.text;
  return (n.children || []).map(textOf).join('').replace(/\s+/g, ' ').trim();
}

// ---------- HTML rendering from the Lexical tree (so html and json always agree) ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderInline(nodes) {
  return nodes.map(n => {
    if (n.type === 'linebreak') return '<br>';
    if (n.type === 'text') {
      let h = esc(n.text);
      const f = n.format;
      if (f & FORMAT.code) h = '<code>' + h + '</code>';
      if (f & FORMAT.subscript) h = '<sub>' + h + '</sub>';
      if (f & FORMAT.superscript) h = '<sup>' + h + '</sup>';
      if (f & FORMAT.strikethrough) h = '<s>' + h + '</s>';
      if (f & FORMAT.underline) h = '<u>' + h + '</u>';
      if (f & FORMAT.italic) h = '<em>' + h + '</em>';
      if (f & FORMAT.bold) h = '<strong>' + h + '</strong>';
      return h;
    }
    if (n.type === 'decorated-link-node') return '<a href="' + esc(n.url) + '"' + (n.target ? ' target="' + esc(n.target) + '"' : '') + '>' + renderInline(n.children) + '</a>';
    if (n.type === 'resizeable-image') return '<div class="freeform-editor-resizable-image-center"><img src="' + esc(n.src) + '" data-image-id="' + esc(n.imageId) + '" alt="' + esc(n.altText) + '"></div>';
    return '';
  }).join('');
}

const alignStyle = f => (f && f !== 'start' && f !== 'left' ? ' style="text-align: ' + f + ';"' : '');

function renderBlocks(blocks) {
  return blocks.map(b => {
    switch (b.type) {
      case 'paragraph':
        if (b.children.length === 1 && b.children[0].type === 'resizeable-image') return '<p class="freeform-editor-paragraph">' + renderInline(b.children) + '</p>';
        return '<p' + alignStyle(b.format) + '>' + renderInline(b.children) + '</p>';
      case 'heading': return '<' + b.tag + '>' + renderInline(b.children) + '</' + b.tag + '>';
      case 'quote': return '<blockquote>' + renderInline(b.children) + '</blockquote>';
      case 'list': return renderList(b);
      case 'table': return renderTable(b);
      default: return '';
    }
  }).join('');
}

function renderList(l) {
  const open = l.tag === 'ol' ? '<ol' + (l.start > 1 ? ' start="' + l.start + '"' : '') + '>' : '<ul>';
  const items = l.children.map(li => {
    if (li.children.length === 1 && li.children[0].type === 'list') return '<li>' + renderList(li.children[0]) + '</li>';
    return '<li>' + renderInline(li.children) + '</li>';
  }).join('');
  return open + items + '</' + l.tag + '>';
}

// Same table markup the editor writes (from 0.2.0).
function renderTable(t) {
  const cellStyle = 'border: 1px solid black; width: 75px; vertical-align: top; text-align: start;';
  const headStyle = cellStyle + ' background-color: rgb(242, 243, 245);';
  const cols = t.colWidths.map(w => '<col style="width: ' + w + 'px;">').join('');
  const rows = t.children.map((r, ri) => '<tr' + (ri === 0 ? ' dir="ltr"' : '') + '>' + r.children.map(c => {
    const span = (c.colSpan > 1 ? ' colspan="' + c.colSpan + '"' : '') + (c.rowSpan > 1 ? ' rowspan="' + c.rowSpan + '"' : '');
    const inner = c.children.map(p => '<p class="freeform-editor-paragraph">' + (p.children.length ? '<span style="white-space: pre-wrap;">' + renderInline(p.children) + '</span>' : '<br>') + '</p>').join('');
    return c.headerState
      ? '<th class="freeform-editor-table-cell freeform-editor-table-header" dir="ltr" style="' + headStyle + '"' + span + '>' + inner + '</th>'
      : '<td class="freeform-editor-table-cell" style="' + cellStyle + '"' + span + '>' + inner + '</td>';
  }).join('') + '</tr>').join('');
  return '<table class="freeform-editor-table"><colgroup>' + cols + '</colgroup><tbody>' + rows + '</tbody></table>';
}

module.exports = { convertHtml, renderBlocks, FORMAT, textOf };
