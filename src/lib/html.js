'use strict';
// Small HTML parser for D10 body fields. Pure (no DOM), so the converter runs the same in the userscript
// and in node tests. Handles what CKEditor output contains: void tags, unclosed <p>/<li>/<td>, entities,
// comments, and raw-text <script>/<style>. Not a full HTML5 parser.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// Opening one of these closes an open <p> (HTML's implied end tags, the cases CKEditor output hits).
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·', copy: '©',
  reg: '®', trade: '™', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', times: '×',
  divide: '÷', laquo: '«', raquo: '»', sect: '§', para: '¶', cent: '¢', pound: '£',
  euro: '€', yen: '¥', shy: '­', zwnj: '‌', zwj: '‍', ensp: ' ', emsp: ' ', thinsp: ' ',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', Eacute: 'É', Ntilde: 'Ñ'
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '');
  }
  return attrs;
}

const el = (tag, attrs) => ({ type: 'element', tag, attrs: attrs || {}, children: [] });

// Returns a root element whose children are the parsed nodes: {type:'element', tag, attrs, children} | {type:'text', text}.
function parseHtml(html) {
  const root = el('#root');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const closeTo = tag => {
    for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; return true; }
    return false;
  };
  const inScope = (tag, stopAt) => {
    for (let i = stack.length - 1; i > 0; i--) { if (stack[i].tag === tag) return true; if (stopAt.includes(stack[i].tag)) return false; }
    return false;
  };
  const s = String(html || '');
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { addText(s.slice(i)); break; }
    if (lt > i) addText(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') { const e = s.indexOf('>', lt); i = e < 0 ? s.length : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(s.slice(lt));
    if (!m) { addText('<'); i = lt + 1; continue; }
    i = lt + m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1]) { // end tag
      if (tag === 'p' && !inScope('p', ['div', 'td', 'th', 'li', 'blockquote', 'table'])) { top().children.push(el('p')); continue; } // stray </p> = empty paragraph
      closeTo(tag);
      continue;
    }
    const node = el(tag, parseAttrs(m[3]));
    if (CLOSES_P.has(tag) && inScope('p', ['div', 'td', 'th', 'li', 'blockquote', 'table'])) closeTo('p');
    if (tag === 'li' && inScope('li', ['ul', 'ol'])) closeTo('li');
    // A new cell closes the open cell, and a new row closes the open row (without leaving the table).
    if (tag === 'td' || tag === 'th') { for (let k = stack.length - 1; k > 0 && stack[k].tag !== 'tr' && stack[k].tag !== 'table'; k--) if (stack[k].tag === 'td' || stack[k].tag === 'th') { stack.length = k; break; } }
    if (tag === 'tr') { for (let k = stack.length - 1; k > 0 && stack[k].tag !== 'table'; k--) if (stack[k].tag === 'tr') { stack.length = k; break; } }
    top().children.push(node);
    if (RAW.has(tag)) {
      const end = s.toLowerCase().indexOf('</' + tag, i);
      const body = s.slice(i, end < 0 ? s.length : end);
      if (body) node.children.push({ type: 'text', text: body });
      const close = end < 0 ? s.length : s.indexOf('>', end);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(node);
  }
  return root;

  function addText(t) {
    const kids = top().children;
    const text = decodeEntities(t);
    const last = kids[kids.length - 1];
    if (last && last.type === 'text') last.text += text; else kids.push({ type: 'text', text });
  }
}

module.exports = { parseHtml, decodeEntities, parseAttrs, VOID };
