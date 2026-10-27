'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d10 = require('../src/lib/d10');
const { buildNavFromD10, limitTree } = require('../src/lib/navFromD10');
const { buildPlan, planReportRows, normalizeOptions } = require('../src/lib/plan');
const { toCsv, PLAN_COLUMNS } = require('../src/lib/csv');
const man = require('../src/lib/manifest');
const { exportFiles } = require('./fixtures');

const load = () => d10.loadExport(exportFiles());

test('loadExport reads pages and microsites and reports missing files', () => {
  const exp = load();
  assert.deepEqual(exp.errors, []);
  assert.equal(exp.pages.length, 11);
  assert.equal(exp.microsites.length, 5);
  assert.equal(exp.counts.faqs, 0);
  assert.equal(exp.counts.media, null);
  const bad = d10.loadExport([{ name: 'www-pages.json', text: '{' }, { name: 'notes.txt', text: '' }]);
  assert.ok(bad.errors.some(e => /not valid JSON/.test(e)));
  assert.ok(bad.errors.includes('Missing www-microsites.json'));
  assert.ok(bad.warnings.some(w => /notes\.txt/.test(w)));
});

test('a news date stored as a plain string, with no array (as in the Harvard export), is news', () => {
  const rec = { entity_id: '1', fields: { field_news_date: '2017-08-25', field_smart_date: [] } };
  assert.equal(d10.classifyPage(rec), 'news');
  assert.equal(d10.classifyPage({ entity_id: '2', fields: { field_news_date: null } }), 'page');
});

test('classifyPage handles bare-string news dates and smart dates', () => {
  const kinds = Object.fromEntries(load().pages.map(p => [p.nid, p.kind]));
  assert.equal(kinds['301'], 'news');
  assert.equal(kinds['302'], 'event');
  assert.equal(kinds['101'], 'page');
});

test('titles are whitespace-trimmed and empty bodies detected', () => {
  const p = load().pages.find(x => x.nid === '202');
  assert.equal(p.title, 'History of Town');
  assert.equal(p.hasBody, false);
});

test('nav: microsites alphabetical, pages alphabetical, Home and empty microsites skipped', () => {
  const nav = buildNavFromD10(load());
  assert.deepEqual(nav.tree.map(n => n.title), ['About Us', 'Police', 'Utilities']);
  assert.deepEqual(nav.tree[2].children.map(n => n.title), ['Alerts', 'billing', 'Water']);
  assert.deepEqual(nav.tree[1].children.map(n => n.title), ['Records']);
  const reasons = Object.fromEntries(nav.skipped.map(s => [s.nid, s.reason]));
  assert.match(reasons['1'], /Home microsite/);
  assert.match(reasons['401'], /Parent microsite skipped/);
  assert.match(reasons['40'], /no pages/);
  assert.match(reasons['301'], /News/);
  assert.match(reasons['302'], /Event/);
  assert.match(reasons['501'], /No microsite/);
  assert.match(reasons['601'], /not in www-microsites/);
  assert.equal(nav.count, 3 + 2 + 1 + 3);
});

test('nav: includeEmptyMicrosites keeps microsites without pages', () => {
  const nav = buildNavFromD10(load(), { includeEmptyMicrosites: true });
  assert.ok(nav.tree.some(n => n.title === 'Empty Board'));
});

test('limitTree keeps the first N pages and their microsites', () => {
  const nav = buildNavFromD10(load());
  const t = limitTree(nav.tree, 3);
  assert.deepEqual(t.map(n => [n.title, n.children.length]), [['About Us', 2], ['Police', 1]]);
});

test('plan: parents first, weights are sibling order, unpublished option applied', () => {
  const nav = buildNavFromD10(load());
  const plan = buildPlan(nav.tree, {});
  assert.equal(plan.pages[0].key, 'microsite:20');
  const idx = k => plan.menu.findIndex(m => m.key === k);
  for (const m of plan.menu) if (m.parentKey) assert.ok(idx(m.parentKey) < idx(m.key), m.key + ' after its parent');
  const alerts = plan.pages.find(p => p.nid === '103');
  assert.equal(alerts.unpublished, true);
  const asPub = buildPlan(nav.tree, { unpublishedSourceAs: 'published' }).pages.find(p => p.nid === '103');
  assert.equal(asPub.unpublished, false);
  const water = plan.menu.find(m => m.pageKey === 'page:101');
  assert.equal(water.parentKey, 'menu:microsite:10');
  assert.equal(water.weight, 2);
  assert.equal(water.path, 'Utilities');
});

test('plan options: unknown values are refused, empty mode turns media off', () => {
  assert.throws(() => normalizeOptions({ pageContent: 'full' }), /Unknown page content/);
  assert.throws(() => normalizeOptions({ menuSource: 'xml' }), /Unknown menu source/);
  assert.throws(() => normalizeOptions({ newsEvents: 'import' }), /skipped/);
  assert.throws(() => normalizeOptions({ pageUrlPattern: '/pages/' }), /\{slug\}/);
  assert.equal(normalizeOptions({ pageContent: 'empty', uploadMedia: true }).uploadMedia, false);
  assert.equal(normalizeOptions({ pageContent: 'content' }).uploadMedia, true);
});

test('report CSV is BOM-prefixed and quotes values', () => {
  const plan = buildPlan(buildNavFromD10(load()).tree, {});
  const csv = toCsv(PLAN_COLUMNS, planReportRows(plan));
  assert.ok(csv.startsWith('﻿"Level"'));
  assert.ok(csv.includes('"Redirect: internal:/calendar"'));
});

test('manifest: stages, host check, round trip', () => {
  const m = man.newManifest({ host: 'a.example', source: { label: 'x' } });
  man.recordPage(m, 'page:1', { streamlineId: 'abc', stage: 'created' });
  assert.equal(man.pageStageAtLeast(m.pages['page:1'], 'promoted'), false);
  man.setPageStage(m, 'page:1', 'promoted');
  assert.equal(man.pageStageAtLeast(m.pages['page:1'], 'created'), true);
  man.recordMenuItem(m, 'menu:page:1', { id: 7 });
  const back = man.parseManifest(JSON.stringify(m), 'a.example');
  assert.equal(back.pages['page:1'].streamlineId, 'abc');
  assert.throws(() => man.parseManifest(JSON.stringify(m), 'b.example'), /belongs to a\.example/);
  assert.throws(() => man.parseManifest('{"format":"x"}'), /not an importer manifest/);
  assert.deepEqual(man.summary(m).pages, 1);
});
