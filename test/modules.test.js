'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const d10 = require('../src/lib/d10');
const { moduleEntries, formatDate, moduleCounts } = require('../src/lib/modules');
const { buildLinkIndex } = require('../src/lib/links');
const { buildNavFromD10 } = require('../src/lib/navFromD10');
const { buildPlan, normalizeOptions } = require('../src/lib/plan');
const man = require('../src/lib/manifest');
const { runPlan } = require('../src/runner');
const { page, microsite } = require('./fixtures');

test('date-times are shown in the site time zone; dates as written', () => {
  assert.equal(formatDate('2017-09-08T22:00:00', 'America/Chicago'), 'September 8, 2017 5:00 PM');
  assert.equal(formatDate('2026-01-13T05:00:00', 'America/Chicago'), 'January 12, 2026 11:00 PM');
  assert.equal(formatDate('2023-07-01', 'America/Chicago'), 'July 1, 2023');
});

const job = (nid, title, extra) => ({ entity_id: String(nid), bundle: 'job_opening', is_published: true, fields: Object.assign({ title: [{ value: title }], path: [{ alias: '/admin/job-opening/' + nid }], field_job_status: [{ value: 'open' }], field_job_closing_date: '2026-03-01T23:00:00', field_file_attachments: [{ target_id: 70 }] }, extra || {}) });

// Page 1 links to page 2 and to job 501 in an "embedded pages" section; news 3 and job 501 are modules.
function setup() {
  const embedded = { target_id: 900, entity: { entity_id: '900', bundle: 'embedded_pages', fields: {
    field_embed_header: [{ value: 'Related' }], field_embed_type: [{ value: 'individual' }],
    field_embed_individual: [{ target_id: 2 }, { target_id: 501 }, { target_id: 3 }, { target_id: 777 }] } } };
  const pages = [
    page(1, 'Water', 10, { fields: { field_sections: [embedded] } }),
    page(2, 'Billing', 10),
    page(3, 'Main break', 10, { fields: { field_news_date: '2025-05-02' } })
  ];
  return d10.loadExport([
    { name: 'www-pages.json', text: JSON.stringify(pages) },
    { name: 'www-microsites.json', text: JSON.stringify([microsite(10, 'Utilities', '/utilities')]) },
    { name: 'www-jobs.json', text: JSON.stringify([job(502, 'Zoo keeper'), job(501, 'Clerk', { field_job_status: [{ value: 'closed' }] })]) },
    { name: 'www-media.json', text: JSON.stringify([{ entity_id: '70', bundle: 'file', is_published: true, fields: { name: [{ value: 'Posting' }], field_media_file: [{ file_url: 'https://www.old.gov/f/post.pdf', file_name: 'post.pdf' }] } }]) }
  ]);
}

test('module entries: details from fields, alphabetical, news newest first with its date', () => {
  const exp = setup();
  assert.deepEqual(moduleCounts(exp).jobs, 2);
  const jobs = moduleEntries(exp, 'jobs', { timeZone: 'America/Chicago' });
  assert.deepEqual(jobs.map(j => [j.key, j.title]), [['jobs:501', 'Clerk'], ['jobs:502', 'Zoo keeper']]);
  assert.equal(jobs[0].bodyHtml, '<p><strong>Status:</strong> Closed</p><p><strong>Closing date:</strong> March 1, 2026 5:00 PM</p>');
  assert.deepEqual(jobs[0].attachments, ['70']);
  const news = moduleEntries(exp, 'news');
  assert.deepEqual(news.map(n => [n.key, n.publishedAt]), [['news:3', '2025-05-02']]);
});

test('plan: listing page with cards, entry pages, menu item; embedded pages become right-column cards', () => {
  const exp = setup();
  const idx = buildLinkIndex(exp);
  const p = buildPlan(buildNavFromD10(exp).tree, { modules: ['jobs', 'news'] }, idx, exp);
  const list = p.pages.find(x => x.key === 'list:jobs');
  assert.deepEqual(list.cards, [{ column: 'main', title: '', keys: ['jobs:501', 'jobs:502'], orderBy: 'alphabetical_by_title', perPage: 12 }]);
  assert.equal(p.pages.find(x => x.key === 'list:news').cards[0].orderBy, 'date_published');
  assert.ok(p.menu.some(m => m.pageKey === 'list:jobs' && m.level === 1));
  assert.equal(p.pages.find(x => x.key === 'jobs:501').content, 'content', 'entries get content even in empty mode');
  const water = p.pages.find(x => x.title === 'Water');
  assert.deepEqual(water.cards, [{ column: 'gutter', title: 'Related', keys: ['page:2', 'jobs:501', 'news:3'], orderBy: 'manual', perPage: 3 }]);
  assert.deepEqual(p.cardIssues.map(i => [i.target, i.reason]), [['777', 'not in the export']]);
  // Without the modules, those links cannot become cards and say why.
  const p2 = buildPlan(buildNavFromD10(exp).tree, {}, idx, exp);
  assert.deepEqual(p2.pages.find(x => x.title === 'Water').cards[0].keys, ['page:2']);
  assert.match(p2.cardIssues.find(i => i.target === '501').reason, /select that module/);
});

test('options: module types are checked and kept in a fixed order', () => {
  assert.deepEqual(normalizeOptions({ modules: ['parks', 'news', 'parks'] }).modules, ['news', 'parks']);
  assert.throws(() => normalizeOptions({ modules: ['meetings'] }), /Unknown module type/);
});

// Minimal in-memory CMS for the cards phase.
function cms() {
  let seq = 0;
  const pages = new Map(), sections = new Map(), items = new Map();
  return {
    pages, sections, items,
    async listLayouts() { return [{ id: '08ff0b88-28a9-4925-86d1-57eceb5aceca', name: 'InteriorStandard' }]; },
    async createPage({ title }) { const id = 'p' + (++seq); pages.set(id, { id, title, slug: title.toLowerCase().replace(/\W+/g, '-') }); return { id, slug: pages.get(id).slug }; },
    async listPages() { return [...pages.values()].map(p => ({ id: p.id, amplifyTitle: p.title })); },
    async promoteDraft() { return 'promoted'; },
    async menuIdFor() { return 1; },
    async menuItems() { return [...items.values()]; },
    async createMenuItem(x) { const id = ++seq; items.set(id, Object.assign({ id }, x)); return { id }; },
    async draftColumns(id) { return [{ id: 'main-' + id, columnType: 'main' }, { id: 'gutter-' + id, columnType: 'gutter' }]; },
    async addSection(pageId, name, columnId, weight) { const id = 's' + (++seq); sections.set(id, { pageId, name, columnId, weight, teasers: [] }); return id; },
    async setFreeform(sid, html) { sections.get(sid).html = html; },
    async setFreeformPreferences() {},
    async setTeaserPreferences(sid, prefs) { sections.get(sid).prefs = prefs; },
    async addTeasers(sid, ids) { sections.get(sid).teasers.push(...ids); },
    async pageUrl(id) { return '/' + pages.get(id).slug; },
    async uploadMedia() { throw new Error('no uploads in this test'); }
  };
}

test('run: listing page gets a main-column card section, Water gets right-column cards in D10 order', async () => {
  const exp = setup();
  const idx = buildLinkIndex(exp);
  const p = buildPlan(buildNavFromD10(exp).tree, { modules: ['jobs', 'news'], uploadMedia: false }, idx, exp);
  const api = cms(), m = man.newManifest({ host: 'h' });
  await runPlan(p, { api, manifest: m, save: () => {}, log: () => {}, idx });
  const byTitle = t => [...api.pages.values()].find(x => x.title === t).id;
  const teaserSecs = [...api.sections.values()].filter(s => s.name === 'Teasers');
  const listing = teaserSecs.find(s => s.pageId === byTitle('Job Openings'));
  assert.equal(listing.columnId, 'main-' + byTitle('Job Openings'));
  assert.deepEqual(listing.teasers, [byTitle('Clerk'), byTitle('Zoo keeper')]);
  assert.equal(listing.prefs.orderByIndex, 'alphabetical_by_title');
  const water = teaserSecs.find(s => s.pageId === byTitle('Water'));
  assert.equal(water.columnId, 'gutter-' + byTitle('Water'));
  assert.deepEqual(water.teasers, [byTitle('Billing'), byTitle('Clerk'), byTitle('Main break')]);
  assert.equal(water.prefs.title, 'Related');
  assert.ok(!('buttonText' in water.prefs) && !('pageId' in water.prefs), 'no button-style link');
  const clerk = [...api.sections.values()].find(s => s.pageId === byTitle('Clerk') && s.name === 'Freeform');
  assert.match(clerk.html, /Closing date:<\/strong> March 1, 2026/);
  // A second run adds nothing.
  const before = api.sections.size;
  await runPlan(p, { api, manifest: m, save: () => {}, log: () => {}, idx });
  assert.equal(api.sections.size, before);
});

const harvard = require('./samples').sampleDir('cityofharvard');
test('Harvard: modules and right-column cards plan cleanly', { skip: !harvard }, () => {
  const exp = d10.loadExport(fs.readdirSync(harvard).filter(f => /^www-/.test(f)).map(f => ({ name: f, text: fs.readFileSync(path.join(harvard, f), 'utf8') })));
  const types = ['news', 'jobs', 'bids_rfps', 'ordinances', 'parks', 'projects', 'standard_locations'];
  const p = buildPlan(buildNavFromD10(exp).tree, { pageContent: 'content', modules: types, timeZone: 'America/Chicago' }, buildLinkIndex(exp), exp);
  const counts = Object.fromEntries(types.map(t => [t, p.pages.filter(x => x.moduleType === t && x.sourceType !== 'listing').length]));
  assert.deepEqual(counts, { news: 70, jobs: 59, bids_rfps: 38, ordinances: 36, parks: 11, projects: 9, standard_locations: 16 });
  const cardPages = p.pages.filter(x => x.cards.some(c => c.column === 'gutter'));
  assert.equal(cardPages.length, 29, 'pages with right-column cards');
  assert.equal(new Set(p.pages.map(x => x.key)).size, p.pages.length);
});

test('api: card sections use the square card layout and never the button link', async () => {
  const { streamlineApi } = require('../src/api/streamline');
  const calls = [];
  const api = streamlineApi({ gql: async (q, v) => { calls.push(v.i); return {}; }, request: async () => ({}) });
  await api.setTeaserPreferences('s1', { title: 'Related', orderByIndex: 'manual', perPage: 3 });
  await api.setTeaserPreferences('s2', { title: undefined, orderByIndex: 'alphabetical_by_title', perPage: 12 });
  assert.deepEqual(calls[0], { sectionInstanceId: 's1', preferences: { colorIndex: 'light3', layout: 'cards', columnDesign: 'three_column', titleAlignment: 'centered', paginationStyleIndex: 'pagination', perPage: 3, orderByIndex: 'manual', title: 'Related' } });
  assert.ok(!('title' in calls[1].preferences));
  assert.ok(calls.every(c => !('buttonText' in c.preferences) && !('pageId' in c.preferences)));
});
