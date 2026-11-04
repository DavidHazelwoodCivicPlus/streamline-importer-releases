'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d10 = require('../src/lib/d10');
const { buildLinkIndex } = require('../src/lib/links');
const { buildNavFromD10 } = require('../src/lib/navFromD10');
const { buildPlan, DEFAULT_OPTIONS } = require('../src/lib/plan');
const { MODULE_TYPES, moduleCounts } = require('../src/lib/modules');
const { buildPageContent, placeholderLookups } = require('../src/lib/content');
const s = require('../src/lib/sample');

const NOW = Date.UTC(2026, 10, 4, 15);
function planSample() {
  const exp = d10.loadExport(s.sampleExport(NOW));
  const idx = buildLinkIndex(exp);
  const opts = Object.assign({}, DEFAULT_OPTIONS, { pageContent: 'content', modules: MODULE_TYPES.slice() });
  return { exp, idx, p: buildPlan(buildNavFromD10(exp, opts).tree, opts, idx, exp, { now: NOW }) };
}

test('the sample export loads cleanly and has every module type', () => {
  const { exp } = planSample();
  assert.deepEqual(exp.errors, []);
  assert.deepEqual(exp.warnings, []);
  for (const [type, n] of Object.entries(moduleCounts(exp))) assert.ok(n > 0, type + ' has records');
});

test('the sample plan makes menus, sections, cards and uploads, with every link resolved', () => {
  const { idx, p } = planSample();
  assert.deepEqual(p.cardIssues, []);
  // Every sample file and image is uploaded; the video is listed too but stays a link (the upload skips videos).
  assert.deepEqual(p.media.map(Number).sort(), s.SAMPLE_MEDIA.map(m => m.mid).sort());
  assert.equal(p.menu.filter(m => m.title === 'Events').length, 1, 'the Events microsite is the events listing');
  assert.ok(p.pages.some(x => !x.sourcePublished && !x.unpublished), 'a page unpublished in D10, imported published by default');
  assert.ok(p.pages.some(x => x.blocks.some(b => b.accordion)), 'an accordion section');
  for (const kind of ['text', 'image_text', 'files', 'slideshow']) assert.ok(p.pages.some(x => x.blocks.some(b => b.kind === kind)), kind + ' section');
  assert.ok(p.pages.some(x => x.cards.some(c => c.column === 'gutter')), 'right-column cards');
  const lookups = placeholderLookups(p);
  for (const x of p.pages.filter(y => y.content === 'content')) {
    const c = buildPageContent(x, idx, lookups, { includeAttachments: true });
    assert.deepEqual(c.warnings, [], x.title + ' converts without warnings');
    for (const l of c.links) assert.ok(['page', 'media', 'external', 'kept'].includes(l.outcome), x.title + ': ' + l.href + ' is ' + l.outcome);
  }
});

test('sample files are recognised by address, and documents are PDFs', () => {
  assert.equal(s.sampleMediaFor('https://' + s.SAMPLE_HOST + '/sites/default/files/park-rules.pdf').name, 'Park Rules');
  assert.equal(s.sampleMediaFor('https://www.example.com/park-rules.pdf'), null);
  assert.ok(s.isSampleUrl('https://' + s.SAMPLE_HOST + '/x.png'));
  const pdf = s.samplePdf(['Hello (world)']);
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /\(Hello \\\(world\\\)\) Tj/);
  const xref = Number(/startxref\n(\d+)/.exec(pdf)[1]);
  assert.equal(pdf.slice(xref, xref + 4), 'xref');
});
