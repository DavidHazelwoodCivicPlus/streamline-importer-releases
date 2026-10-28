'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d10 = require('../src/lib/d10');
const { buildNavFromD10 } = require('../src/lib/navFromD10');
const { buildPlan } = require('../src/lib/plan');
const man = require('../src/lib/manifest');
const { runPlan, undoRun, StopRequested } = require('../src/runner');
const { exportFiles } = require('./fixtures');

// In-memory stand-in for the Streamline calls the runner uses. failAt: throw on the Nth write.
function fakeCms(opts) {
  opts = opts || {};
  let seq = 0, writes = 0;
  const pages = new Map(), items = new Map();
  const write = () => { writes++; if (opts.failAt && writes === opts.failAt) throw new Error('simulated network drop'); };
  return {
    pages, items,
    layouts: opts.layouts || [{ id: '08ff0b88-28a9-4925-86d1-57eceb5aceca', name: 'InteriorStandard' }, { id: 'x', name: 'Home' }],
    async listLayouts() { return this.layouts; },
    // loseReplyAt: the Nth write creates the page but the reply never arrives.
    async createPage({ title, unpublished, layoutId }) {
      const id = 'p' + (++seq);
      const lose = opts.loseReplyAt && writes + 1 === opts.loseReplyAt;
      write();
      pages.set(id, { id, title, slug: title.toLowerCase().replace(/\W+/g, '-'), unpublished, layoutId, promoted: false, createdAt: new Date(Date.now() + 1).toISOString() });
      if (lose) throw new Error('simulated lost reply');
      return { id, slug: pages.get(id).slug };
    },
    async listPages() { return [...pages.values()].map(p => ({ id: p.id, amplifyTitle: p.title, slug: p.slug, unpublished: !!p.unpublished, draftPageVersion: { createdAt: p.createdAt }, activePageVersion: p.promoted || p.existing ? { createdAt: p.createdAt } : null })); },
    sections: new Map(), media: new Map(), urlLookups: [],
    async draftColumns(id) { return [{ id: 'col-main-' + id, columnType: 'main' }, { id: 'col-gutter-' + id, columnType: 'gutter' }]; },
    async addSection(pageId, name, columnId, weight) { write(); const id = 's' + (++seq); this.sections.set(id, { pageId, columnId, weight, html: null }); return id; },
    async setFreeformPreferences(sid, prefs) { write(); this.sections.get(sid).prefs = prefs; },
    async pageUrl(id) { this.urlLookups.push(pages.get(id).title); return '/' + pages.get(id).slug; },
    async setFreeform(sid, html, json) { write(); const s = this.sections.get(sid); s.html = html; s.json = json; },
    async uploadMedia({ kind, basename, altText }) { write(); const id = 'm' + (++seq); this.media.set(id, { kind, basename, altText }); return { kind, id, url: '/files/' + id + '/' + basename, altText }; },
    async deleteMedia(kind, id) { write(); this.media.delete(id); },
    async promoteDraft(id) { write(); pages.get(id).promoted = true; return 'promoted'; },
    async deletePage(id) { write(); return pages.delete(id) ? 'deleted' : 'gone'; },
    async menuIdFor() { return 5; },
    async menuItems() { return [...items.values()]; },
    async createMenuItem(x) { write(); const id = ++seq; const it = { id, menu_id: x.menuId, title: x.title, poc_id: x.pageId, parent_id: x.parentId, weight: x.weight }; items.set(id, it); return it; },
    async softDeleteMenuItem(it) { write(); items.delete(it.id); return 'deleted'; }
  };
}

const plan = () => buildPlan(buildNavFromD10(d10.loadExport(exportFiles())).tree, {});
const ctx = (api, m, extra) => Object.assign({ api, manifest: m, save: () => {}, log: () => {} }, extra);

test('full run creates every page and menu item, linked and ordered', async () => {
  const api = fakeCms(), p = plan(), m = man.newManifest({ host: 'h' });
  await runPlan(p, ctx(api, m));
  assert.equal(api.pages.size, p.pages.length);
  assert.equal(api.items.size, p.menu.length);
  assert.ok([...api.pages.values()].every(x => x.promoted));
  const util = [...api.items.values()].find(i => i.title === 'Utilities');
  const kids = [...api.items.values()].filter(i => i.parent_id === util.id).sort((a, b) => a.weight - b.weight);
  assert.deepEqual(kids.map(k => k.title), ['Alerts', 'billing', 'Water']);
  for (const k of kids) assert.equal(api.pages.get(k.poc_id).title, k.title);
  assert.equal([...api.pages.values()].find(x => x.title === 'Alerts').unpublished, true);
});

test('a run that fails partway resumes without duplicates', async () => {
  const p = plan();
  for (let failAt = 1; failAt <= p.pages.length + p.menu.length + p.pages.length; failAt++) {
    const api = fakeCms({ failAt }), m = man.newManifest({ host: 'h' });
    await assert.rejects(runPlan(p, ctx(api, m)), /simulated/);
    await runPlan(p, ctx(api, m));
    assert.equal(api.pages.size, p.pages.length, 'pages after failure at write ' + failAt);
    assert.equal(api.items.size, p.menu.length, 'menu items after failure at write ' + failAt);
  }
});

test('stop request halts cleanly and resume finishes', async () => {
  const api = fakeCms(), p = plan(), m = man.newManifest({ host: 'h' });
  let n = 0;
  await assert.rejects(runPlan(p, ctx(api, m, { shouldStop: () => ++n > 4 })), StopRequested);
  assert.ok(api.pages.size < p.pages.length);
  await runPlan(p, ctx(api, m));
  assert.equal(api.items.size, p.menu.length);
});

test('items deleted in the CMS between runs are recreated', async () => {
  const api = fakeCms(), p = plan(), m = man.newManifest({ host: 'h' });
  await runPlan(p, ctx(api, m));
  const water = [...api.items.values()].find(i => i.title === 'Water');
  api.items.delete(water.id);
  await runPlan(p, ctx(api, m));
  assert.equal(api.items.size, p.menu.length);
});

test('top-level items go after the site\'s own items, also on resume', async () => {
  const api = fakeCms(), p = plan(), m = man.newManifest({ host: 'h' });
  await api.createMenuItem({ menuId: 5, title: 'Own', pageId: null, parentId: null, weight: 7 });
  let n = 0;
  await assert.rejects(runPlan(p, ctx(api, m, { shouldStop: () => ++n > p.pages.length + 3 })), StopRequested);
  await runPlan(p, ctx(api, m));
  const tops = [...api.items.values()].filter(i => i.parent_id == null && i.title !== 'Own').sort((a, b) => a.weight - b.weight);
  assert.deepEqual(tops.map(t => [t.title, t.weight]), [['About Us', 8], ['Police', 9], ['Utilities', 10]]);
});

test('layout: known id, then by name; stops when missing or ambiguous', async () => {
  const p = plan();
  const byName = fakeCms({ layouts: [{ id: 'other-id', name: 'Interior Standard' }] }), m1 = man.newManifest({ host: 'h' });
  await runPlan(p, ctx(byName, m1));
  assert.equal(m1.layout.id, 'other-id');
  assert.ok([...byName.pages.values()].every(x => x.layoutId === 'other-id'));
  for (const layouts of [[{ id: 'a', name: 'Home' }], [{ id: 'a', name: 'InteriorStandard' }, { id: 'b', name: 'interior-standard' }]]) {
    const api = fakeCms({ layouts });
    await assert.rejects(runPlan(p, ctx(api, man.newManifest({ host: 'h' }))), /InteriorStandard layout/);
    assert.equal(api.pages.size, 0);
  }
});

test('a page created but whose reply was lost is flagged on resume, not adopted', async () => {
  const api = fakeCms({ loseReplyAt: 3 }), p = plan(), m = man.newManifest({ host: 'h' });
  const logs = [];
  await assert.rejects(runPlan(p, ctx(api, m)), /lost reply/);
  await runPlan(p, ctx(api, m, { log: s => logs.push(s) }));
  assert.equal(m.possibleDuplicates.length, 1);
  assert.ok(logs.some(l => /may be a leftover/.test(l)));
  assert.equal(api.pages.size, p.pages.length + 1); // the orphan is left for a person to check
});

// Content mode: an export with a body link, an attachment, a page that is not imported, and an FAQ section.
const faqRec = (nid, q, a, cat, w, pub) => ({ entity_id: String(nid), bundle: 'faq', is_published: pub !== false, fields: { title: [{ value: q }], body: [{ value: a }], field_faq_category: [{ target_id: cat }], field_faq_weight: [{ value: String(w) }] } });
function contentSetup(options) {
  const { page, microsite } = require('./fixtures');
  const { buildLinkIndex } = require('../src/lib/links');
  // Billing has no body, only an FAQ section (embedded paragraph, as in the real export) for category 7.
  const faqSection = { target_id: 241, entity: { entity_id: '241', bundle: 'faqs', fields: { field_faq_category: [{ target_id: 7 }], field_collapsing_options: [{ value: 'none' }] } } };
  const pages = [
    page(1, 'Water', 10, { fields: { body: [{ value: '<p>See <a href="/node/2">billing</a> and <a href="/node/9">old news</a>.</p>' }], field_file_attachments: [{ target_id: 50 }] } }),
    page(2, 'Billing', 10, { fields: { body: [], field_sections: [faqSection] } }),
    page(9, 'Old news', 10, { fields: { field_news_date: ['2020-01-01'] } })
  ];
  const faqs = [
    faqRec(91, 'How do I pay?', '<p>Online, or see <a href="/node/1">water</a>.</p>', 7, 2),
    faqRec(92, 'When is it due?', '<p>On the 15th.</p>', 7, 1),
    faqRec(93, 'Draft question', '<p>Not yet.</p>', 7, 3, false),
    faqRec(94, 'Other category', '<p>Elsewhere.</p>', 8, 1)
  ];
  const mediaRec = { entity_id: '50', bundle: 'file', is_published: true, fields: { name: [{ value: 'Rates' }], field_media_file: [{ file_url: 'https://www.old.gov/files/rates.pdf', file_name: 'rates.pdf' }] } };
  const exp = d10.loadExport([
    { name: 'www-pages.json', text: JSON.stringify(pages) },
    { name: 'www-microsites.json', text: JSON.stringify([microsite(10, 'Utilities', '/utilities')]) },
    { name: 'www-media.json', text: JSON.stringify([mediaRec]) },
    { name: 'www-faqs.json', text: JSON.stringify(faqs) }
  ]);
  const idx = buildLinkIndex(exp);
  const p = buildPlan(buildNavFromD10(exp).tree, Object.assign({ pageContent: 'content' }, options), idx);
  return { idx, p };
}
const seedExisting = api => api.pages.set('home', { id: 'home', title: 'Welcome Home', slug: 'welcome-home', existing: true, createdAt: '2020-01-01T00:00:00Z' });
const download = async url => ({ type: 'application/pdf', url });

test('content mode: media uploaded, body written, links use each page url from the CMS', async () => {
  const { idx, p } = contentSetup();
  assert.deepEqual(p.media, ['50']);
  const api = fakeCms(), m = man.newManifest({ host: 'h' });
  seedExisting(api);
  await runPlan(p, ctx(api, m, { idx, download }));
  assert.deepEqual(api.urlLookups.sort(), ['Billing', 'Water'], 'only pages that something links to are looked up');
  assert.equal(api.media.size, 1);
  const water = [...api.sections.values()].find(s => api.pages.get(s.pageId).title === 'Water');
  assert.match(water.html, /<a href="\/billing">billing<\/a>/);
  assert.match(water.html, /href="https:\/\/www\.old\.gov\/ms10\/page\/old-news"/);
  assert.match(water.html, /<a href="\/files\/m\d+\/rates\.pdf">Rates<\/a>/);
  assert.equal(m.pages['page:2'].url, '/billing');
  assert.ok(Object.values(m.pages).every(r => r.stage === 'promoted'));
});

test('FAQ sections become one accordion per published question, in D10 order, links rewritten', async () => {
  const { idx, p } = contentSetup();
  const billing = p.pages.find(x => x.title === 'Billing');
  assert.deepEqual(billing.faqs.map(f => f.question), ['When is it due?', 'How do I pay?']);
  const api = fakeCms(), m = man.newManifest({ host: 'h' });
  await runPlan(p, ctx(api, m, { idx, download }));
  const secs = [...api.sections.values()].filter(s => api.pages.get(s.pageId).title === 'Billing').sort((a, b) => a.weight - b.weight);
  assert.deepEqual(secs.map(s => [s.weight, s.prefs.accordion, s.prefs.accordionTitle]), [[1, true, 'When is it due?'], [2, true, 'How do I pay?']]);
  assert.match(secs[1].html, /<a href="\/water">water<\/a>/);
  assert.equal(m.pages['page:2'].faqs, 2);
});

test('FAQ accordions can be turned off', async () => {
  const { idx, p } = contentSetup({ faqAccordions: false });
  assert.deepEqual(p.pages.find(x => x.title === 'Billing').faqs, []);
  const api = fakeCms();
  await runPlan(p, ctx(api, man.newManifest({ host: 'h' }), { idx, download }));
  assert.equal([...api.sections.values()].filter(s => api.pages.get(s.pageId).title === 'Billing').length, 0);
});

test('content mode resumes after a failure at any write, without duplicate sections or uploads', async () => {
  const { idx, p } = contentSetup();
  for (let failAt = 1; failAt <= 24; failAt++) {
    const api = fakeCms({ failAt }), m = man.newManifest({ host: 'h' });
    seedExisting(api);
    await runPlan(p, ctx(api, m, { idx, download })).catch(e => { if (!/simulated/.test(e.message)) throw e; });
    await runPlan(p, ctx(api, m, { idx, download }));
    assert.equal(api.media.size, 1, 'uploads, failAt ' + failAt);
    assert.equal(api.sections.size, 3, 'sections, failAt ' + failAt);
    assert.ok([...api.sections.values()].every(s => s.html), 'every section has content, failAt ' + failAt);
    assert.equal(api.pages.size, p.pages.length + 1, 'pages, failAt ' + failAt);
  }
});

test('a failed download is reported and the link stays on the old site', async () => {
  const { idx, p } = contentSetup();
  const api = fakeCms(), m = man.newManifest({ host: 'h' });
  seedExisting(api);
  await runPlan(p, ctx(api, m, { idx, download: async () => { throw new Error('404'); } }));
  assert.equal(api.media.size, 0);
  assert.ok(m.mediaFailures['50']);
  const html = [...api.sections.values()].find(s => api.pages.get(s.pageId).title === 'Water').html;
  assert.match(html, /href="https:\/\/www\.old\.gov\/files\/rates\.pdf"/);
});

test('a page URL pattern set in Options is used instead of looking addresses up', async () => {
  const { idx, p } = contentSetup({ pageUrlPattern: '/p/{slug}' });
  const api = fakeCms();
  await runPlan(p, ctx(api, man.newManifest({ host: 'h' }), { idx, download }));
  assert.deepEqual(api.urlLookups, []);
  const water = [...api.sections.values()].find(s => api.pages.get(s.pageId).title === 'Water');
  assert.match(water.html, /<a href="\/p\/billing">billing<\/a>/);
});

test('resume refuses different run options', async () => {
  const api = fakeCms(), m = man.newManifest({ host: 'h' });
  await runPlan(plan(), ctx(api, m));
  const other = buildPlan(buildNavFromD10(d10.loadExport(exportFiles())).tree, { unpublishedSourceAs: 'published' });
  await assert.rejects(runPlan(other, ctx(api, m)), /different options \(unpublishedSourceAs\)/);
});

test('undo also removes uploaded media', async () => {
  const { idx, p } = contentSetup();
  const api = fakeCms(), m = man.newManifest({ host: 'h' });
  seedExisting(api);
  await runPlan(p, ctx(api, m, { idx, download }));
  await undoRun(ctx(api, m));
  assert.equal(api.media.size, 0);
  assert.deepEqual([...api.pages.keys()], ['home']);
  assert.ok(man.isEmpty(m));
});

test('undo removes only what the manifest created', async () => {
  const api = fakeCms(), p = plan(), m = man.newManifest({ host: 'h' });
  const other = await api.createMenuItem({ menuId: 5, title: 'Site own item', pageId: null, parentId: null, weight: 0 });
  await runPlan(p, ctx(api, m));
  await undoRun(ctx(api, m));
  assert.equal(api.pages.size, 0);
  assert.deepEqual([...api.items.keys()], [other.id]);
  assert.ok(man.isEmpty(m));
});
