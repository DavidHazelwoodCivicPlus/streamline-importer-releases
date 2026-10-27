'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseHtml, decodeEntities } = require('../src/lib/html');
const { convertHtml, FORMAT } = require('../src/lib/lexical');

const kids = html => convertHtml(html).json.root.children;
const plain = nodes => nodes.map(n => n.type === 'text' ? n.text : n.type === 'linebreak' ? '\n' : n.children ? plain(n.children) : '').join('');

// Structural checks every converted document must pass.
function validate(json) {
  const errs = [];
  const BLOCK = new Set(['paragraph', 'heading', 'quote', 'list', 'table']);
  const INLINE = new Set(['text', 'linebreak', 'decorated-link-node', 'resizeable-image']);
  const visit = (n, parent) => {
    if (!n || typeof n.type !== 'string' || n.version !== 1) errs.push('bad node ' + JSON.stringify(n).slice(0, 80));
    if (parent === 'root' && !BLOCK.has(n.type)) errs.push(n.type + ' at root');
    if (['paragraph', 'heading', 'quote', 'decorated-link-node'].includes(n.type)) for (const c of n.children) if (!INLINE.has(c.type)) errs.push(c.type + ' inside ' + n.type);
    if (n.type === 'text' && !n.text) errs.push('empty text node');
    if (n.type === 'decorated-link-node' && (!n.children.length || !n.url)) errs.push('empty link');
    if (n.type === 'list') for (const c of n.children) if (c.type !== 'listitem') errs.push(c.type + ' in list');
    if (n.type === 'table') {
      const w = n.colWidths.length;
      for (const r of n.children) if (r.children.reduce((s, c) => s + c.colSpan, 0) !== w) errs.push('ragged table row');
      for (const r of n.children) for (const c of r.children) for (const p of c.children) if (p.type !== 'paragraph') errs.push(p.type + ' in cell');
    }
    for (const c of n.children || []) visit(c, n.type);
  };
  for (const c of json.root.children) visit(c, 'root');
  return errs;
}

test('entities and implied end tags', () => {
  assert.equal(decodeEntities('a&nbsp;b &amp; &#8217; &#x2014; &bogus;'), 'a\u00a0b & \u2019 \u2014 &bogus;');
  const r = parseHtml('<p>one<p>two<ul><li>a<li>b</ul>');
  assert.deepEqual(r.children.map(c => c.tag), ['p', 'p', 'ul']);
  assert.equal(r.children[2].children.length, 2);
});

test('paragraphs, headings, formatting, whitespace', () => {
  const c = kids('<p>  Hello   <strong>bold <em>both</em></strong>&nbsp; <u>u</u> </p><h1>Top</h1><h3>Sub</h3><p>&nbsp;</p>');
  assert.equal(c.length, 3, 'empty paragraph dropped');
  assert.deepEqual(c[0].children.map(t => [t.text, t.format]), [['Hello ', 0], ['bold ', FORMAT.bold], ['both', FORMAT.bold | FORMAT.italic], [' ', 0], ['u', FORMAT.underline]]);
  assert.equal(c[1].tag, 'h2');
  assert.equal(c[2].tag, 'h3');
  assert.ok(convertHtml('<h1>Top</h1>').warnings.some(w => w.code === 'h1-demoted'));
});

test('spans are unwrapped, style bold kept, br becomes linebreak', () => {
  const c = kids('<p><span style="color:red">a</span><span style="font-weight:bold">b</span><br>c<br></p>');
  assert.deepEqual(c[0].children.map(n => n.type === 'text' ? n.text + ':' + n.format : n.type), ['a:0', 'b:1', 'linebreak', 'c:0']);
});

test('text directly in the body and in divs becomes paragraphs', () => {
  const c = kids('loose text<div>in div<div>nested</div></div>');
  assert.deepEqual(c.map(b => plain(b.children)), ['loose text', 'in div', 'nested']);
});

test('links: resolver decides url, external and drops', () => {
  const r = convertHtml('<p>See <a href="/node/5" target="_blank">page <b>five</b></a> and <a href="/gone">gone</a>.</p>', {
    resolveLink: href => href === '/node/5' ? { url: '/new-five', external: false } : null
  });
  const p = r.json.root.children[0];
  const link = p.children.find(n => n.type === 'decorated-link-node');
  assert.equal(link.url, '/new-five');
  assert.equal(link.target, '_blank');
  assert.deepEqual(link.children.map(t => t.text), ['page ', 'five']);
  assert.equal(plain(p.children), 'See page five and gone.');
  assert.deepEqual(r.links, [{ href: '/node/5', url: '/new-five' }, { href: '/gone', url: null }]);
  assert.match(r.html, /<a href="\/new-five" target="_blank">page <strong>five<\/strong><\/a>/);
});

test('nested lists use a listitem holding the child list', () => {
  const c = kids('<ul><li>one<ul><li>one-a</li></ul></li><li><p>two</p><p>more</p></li></ul><ol start="3"><li>x</li></ol>');
  const ul = c[0];
  assert.equal(ul.listType, 'bullet');
  assert.equal(ul.children.length, 3);
  assert.equal(ul.children[1].children[0].type, 'list');
  assert.equal(ul.children[1].children[0].children[0].indent, 1);
  assert.deepEqual(ul.children[2].children.map(n => n.type), ['text', 'linebreak', 'text']);
  assert.deepEqual([ul.children[0].value, ul.children[2].value], [1, 2]);
  assert.equal(c[1].start, 3);
  assert.equal(c[1].children[0].value, 3);
});

test('tables: header states, padding, nested tables flattened', () => {
  const r = convertHtml('<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>a</td></tr><tr><td colspan="2">wide<table><tr><td>inner</td></tr></table></td></tr></tbody></table>');
  const t = r.json.root.children[0];
  assert.equal(t.type, 'table');
  assert.deepEqual(t.colWidths, [92, 92]);
  assert.deepEqual(t.children[0].children.map(c => c.headerState), [1, 1]);
  assert.equal(t.children[1].children.length, 2, 'short row padded');
  assert.ok(r.warnings.some(w => w.code === 'nested-table-flattened'));
  assert.deepEqual(validate(r.json), []);
  assert.match(r.html, /<table class="freeform-editor-table">/);
});

test('scripts, iframes and hr are dropped and reported', () => {
  const r = convertHtml('<p>a</p><script>alert(1)</script><iframe src="https://x"></iframe><hr><p>b</p>');
  assert.deepEqual(r.json.root.children.map(b => plain(b.children)), ['a', 'b']);
  assert.deepEqual(r.warnings.map(w => w.code).sort(), ['dropped-hr', 'dropped-iframe', 'dropped-script']);
});

test('images need a resolver, otherwise they are dropped', () => {
  assert.ok(convertHtml('<p><img src="/x.jpg"></p>').warnings.some(w => w.code === 'dropped-image'));
  const r = convertHtml('<p>before<img src="/x.jpg" alt="A">after</p>', { resolveImage: a => ({ id: 'img1', url: 'https://cdn/x.jpg', altText: a.alt }) });
  assert.deepEqual(r.json.root.children.map(b => b.children[0].type), ['text', 'resizeable-image', 'text']);
  assert.match(r.html, /data-image-id="img1" alt="A"/);
});

test('empty input gives one empty paragraph', () => {
  assert.deepEqual(kids('').map(b => [b.type, b.children.length]), [['paragraph', 0]]);
});

// Every body in the sample exports: valid structure, and no visible text lost except in dropped elements.
const DIRS = require('./samples').sampleDirs();
const squash = s => s.replace(/[\s\u00a0\u200b]+/g, '');
function visibleText(node, dropped) {
  if (node.type === 'text') return node.text;
  if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'noscript', 'video', 'audio', 'canvas', 'svg', 'map', 'head', 'title'].includes(node.tag)) { dropped.push(node.tag); return ''; }
  return (node.children || []).map(c => visibleText(c, dropped)).join('');
}
for (const dir of DIRS) {
  test('every body converts cleanly: ' + path.basename(dir), () => {
    const bodies = [];
    for (const f of ['www-pages.json', 'www-microsites.json', 'www-faqs.json']) {
      for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
        const b = r.fields && r.fields.body && r.fields.body[0] && r.fields.body[0].value;
        if (b) bodies.push({ id: f + ':' + r.entity_id, html: b });
      }
    }
    const codes = {};
    for (const b of bodies) {
      const r = convertHtml(b.html, { resolveLink: href => ({ url: href, external: /^https?:/.test(href) }) });
      assert.deepEqual(validate(r.json), [], b.id);
      const out = squash(plain(r.json.root.children));
      const src = squash(visibleText(parseHtml(b.html), []));
      assert.equal(out, src, 'text differs in ' + b.id);
      for (const w of r.warnings) codes[w.code] = (codes[w.code] || 0) + 1;
    }
    console.log('  ' + path.basename(dir) + ': ' + bodies.length + ' bodies converted; warnings ' + JSON.stringify(codes));
  });
}
