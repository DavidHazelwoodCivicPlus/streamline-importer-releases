'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d10 = require('../src/lib/d10');
const { buildLinkIndex, classify, makeResolver, referencedMedia, attachmentsHtml } = require('../src/lib/links');
const { buildPageContent } = require('../src/lib/content');
const { page, microsite } = require('./fixtures');

const media = (mid, kind, file, extra) => ({
  entity_id: String(mid), bundle: kind, is_published: true,
  fields: Object.assign({ uuid: [{ value: 'u-' + mid }], name: [{ value: 'Media ' + mid }] },
    kind === 'image' ? { field_media_image: [{ alt: 'Alt ' + mid, file_url: 'https://www.old.gov/sites/g/files/x/files/' + file, file_name: file }] }
      : { field_media_file: [{ file_url: 'https://www.old.gov/sites/g/files/x/files/' + file, file_name: file }] }, extra || {})
});

function exp() {
  const pages = [
    page(1, 'Water', 10, { fields: { metatag: [{ tag: 'link', attributes: { rel: 'canonical', href: 'https://www.old.gov/utilities/page/water' } }], field_file_attachments: [{ target_id: 51 }, { target_id: 999 }] } }),
    page(2, 'Billing', 10),
    page(3, 'Old news', 10, { fields: { field_news_date: ['2020-01-01'] } })
  ];
  return d10.loadExport([
    { name: 'www-pages.json', text: JSON.stringify(pages) },
    { name: 'www-microsites.json', text: JSON.stringify([microsite(10, 'Utilities', '/utilities')]) },
    { name: 'www-media.json', text: JSON.stringify([media(50, 'file', 'rates.pdf'), media(51, 'file', 'form.docx'), media(60, 'image', 'tower.jpg')]) }
  ]);
}

test('old site hosts come from canonical metatags and file urls, with and without www', () => {
  const e = exp();
  assert.ok(e.hosts.includes('www.old.gov') && e.hosts.includes('old.gov'));
  assert.equal(e.origin, 'https://www.old.gov');
});

test('classify: node, alias, media by id/uuid/path, files, external, special', () => {
  const idx = buildLinkIndex(exp());
  const t = (h, a) => classify(idx, h, a).type;
  assert.equal(t('/node/2'), 'node');
  assert.equal(t('https://old.gov/ms10/page/billing/'), 'alias');
  assert.equal(t('/media/50'), 'media');
  assert.equal(t('/x', { 'data-entity-uuid': 'u-60', 'data-entity-type': 'media' }), 'media');
  assert.equal(t('https://www.old.gov/sites/g/files/x/files/rates.pdf'), 'media');
  assert.equal(t('/sites/g/files/x/files/missing.pdf'), 'file');
  assert.equal(t('https://example.com/a'), 'external');
  assert.equal(t('mailto:a@b.c'), 'special');
  assert.equal(t('/some/old/path'), 'internal');
});

test('resolver: imported pages and uploaded media get new urls, the rest stays on the old site with a reason', () => {
  const idx = buildLinkIndex(exp());
  const log = [];
  const r = makeResolver(idx, {
    pageUrl: k => (k === 'page:2' ? '/billing' : null),
    media: mid => (mid === '50' ? { url: '/files/abc/rates.pdf', id: 'f1' } : null)
  }, e => log.push(e));
  assert.deepEqual(r.resolveLink('/node/2#top'), { url: '/billing#top', external: false });
  assert.deepEqual(r.resolveLink('/media/50'), { url: '/files/abc/rates.pdf', external: false });
  assert.equal(r.resolveLink('/node/3').url, 'https://www.old.gov/ms10/page/old-news');
  assert.equal(r.resolveLink('/media/51').url, 'https://www.old.gov/sites/g/files/x/files/form.docx');
  assert.equal(r.resolveLink('/node/777').url, 'https://www.old.gov/node/777');
  assert.equal(r.resolveLink('https://example.com/x').url, 'https://example.com/x');
  assert.deepEqual(log.map(l => l.outcome), ['page', 'media', 'old-site', 'old-site', 'old-site', 'external']);
  assert.match(log[2].reason, /news/);
  assert.match(log[3].reason, /not uploaded/);
});

test('referenced media and attachments html', () => {
  const idx = buildLinkIndex(exp());
  const html = '<a href="/media/50">a</a><a href="https://old.gov/sites/g/files/x/files/tower.jpg">b</a><a href="/media/50">again</a>';
  assert.deepEqual(referencedMedia(idx, html, ['51', '999']), ['50', '60', '51']);
  assert.equal(attachmentsHtml(idx, ['51', '999']), '<h2>Documents</h2><ul><li><a href="/media/51">Media 51</a></li></ul>');
});

test('page content: body plus attachments, links rewritten', () => {
  const e = exp();
  const idx = buildLinkIndex(e);
  const p = { bodyHtml: '<p>Pay your <a href="/node/2">bill</a>.</p>', attachments: ['51'] };
  const c = buildPageContent(p, idx, { pageUrl: () => '/billing', media: () => ({ url: '/files/1/form.docx', id: 'f' }) });
  assert.match(c.html, /<a href="\/billing">bill<\/a>/);
  assert.match(c.html, /<h2>Documents<\/h2><ul><li><a href="\/files\/1\/form.docx">Media 51<\/a><\/li><\/ul>/);
  assert.equal(c.empty, false);
  assert.equal(buildPageContent({ bodyHtml: '', attachments: [] }, idx, {}).empty, true);
});
