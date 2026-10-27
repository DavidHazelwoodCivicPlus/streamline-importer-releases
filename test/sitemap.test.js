'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d10 = require('../src/lib/d10');
const { readSiteMap, findColumns } = require('../src/lib/sitemap');
const { matchSiteMap, parseOverrides, parseCsv } = require('../src/lib/match');
const { buildLinkIndex } = require('../src/lib/links');
const { buildPlan } = require('../src/lib/plan');
const { exportFiles } = require('./fixtures');

// user6 layout: tiers C-J, marks K-M, no URL column.
const fixed = [
  ['', '', 'Global', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', 'K', 'L', 'M'],
  ['', '', 'Home', '', '', '', '', '', '', '', '1'],
  ['', '', 'Utilities', '', '', '', '', '', '', '', '1'],
  ['', '', '', 'Water', '', '', '', '', '', '', '0', '1'],
  ['', '', '', 'Courts', '', '', '', '', '', '', '0'],
  ['', '', '', '', 'Judges', '', '', '', '', '', '1'],
  ['', '', 'About   Us', '', '', '', '', '', '', '', 'x']
];

// Monmouth-style layout: tiers start in E, marks have headers, old URLs labelled in a row above.
const named = [
  ['', '', '', '', 'Content Report', '', '', '', '', '', '', '', '', '', '', 'Existing Website URLs'],
  ['', '', '', '', 'Global', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', 'Complete Pages', 'Incomplete Pages', 'Linked Pages', ''],
  ['', '', '', '', 'Utilities', '', '', '', '', '', '', '', 1, '', '', 'https://www.old.gov/utilities'],
  ['', '', '', '', '', 'Water Service', '', '', '', '', '', '', 1, '', '', 'https://old.gov/ms10/page/water'],
  ['', '', '', '', '', 'Billing', '', '', '', '', '', '', '', '', 1, ''],
  ['', '', '', '', '', 'Alerts', '', '', '', '', '', '', 1, '', '', 'https://other.org/alerts'],
  ['', '', '', '', '', 'History of Town', '', '', '', '', '', '', 1, '', '', ''],
  ['', '', '', '', 'Press release', '', '', '', '', '', '', '', 1, '', '', '/ms30/page/press-release']
];

test('fixed layout keeps every user6 rule', () => {
  const s = readSiteMap([{ name: 'Sheet1', aoa: fixed }, { name: 'Site Navigation', aoa: fixed }]);
  assert.equal(s.sheetName, 'Site Navigation');
  assert.equal(s.cols.layout, 'fixed');
  assert.deepEqual(s.built.tree.map(n => [n.title, n.children.map(c => c.title)]), [['Utilities', ['Water']], ['About Us', []]]);
  const why = Object.fromEntries(s.built.skipped.map(x => [x.title, x.reason]));
  assert.match(why.Home, /Home/);
  assert.match(why.Courts, /Marked 0/);
  assert.match(why.Judges, /Parent page skipped: "Courts"/);
});

test('header-named layout finds tiers, marks and the URL column', () => {
  const cols = findColumns(named);
  assert.deepEqual([cols.tiers[0], cols.tiers.length, cols.complete, cols.linked, cols.url], [4, 8, 12, 14, 15]);
  const s = readSiteMap([{ name: 'Full Sitemap Navigation', aoa: named }]);
  assert.equal(s.columnsLabel, 'tiers E-L, marks M/N/O, old URLs P');
  assert.equal(s.built.count, 6);
});

test('matching: url first, unique title second, never guesses', () => {
  const exp = d10.loadExport(exportFiles());
  exp.hosts = ['www.old.gov', 'old.gov'];
  const idx = buildLinkIndex(exp);
  const s = readSiteMap([{ name: 'S', aoa: named }]);
  const r = matchSiteMap(s.built, exp, idx, {});
  const by = Object.fromEntries(r.rows.map(x => [x.title, x]));
  assert.equal(by['Water Service'].method, 'url');
  assert.equal(by['Water Service'].nid, '101');
  assert.equal(by.Billing.method, 'title');            // no URL, unique title
  assert.equal(by['History of Town'].nid, '202');      // whitespace and case do not matter
  assert.equal(by.Alerts.method, 'title');             // URL on another site, then title
  assert.match(by.Alerts.reason, /another site/);
  assert.equal(by['Press release'].status, 'not-a-page');
  assert.deepEqual([by.Utilities.method, by.Utilities.d10Type, by.Utilities.nid], ['url', 'microsite', '10']);
});

test('ambiguous titles are reported, not picked; overrides settle them', () => {
  const exp = d10.loadExport(exportFiles());
  const dupes = JSON.parse(exportFiles()[0].text);
  dupes.push(Object.assign({}, dupes[0], { entity_id: '777' }));
  const exp2 = d10.loadExport([{ name: 'www-pages.json', text: JSON.stringify(dupes) }, exportFiles()[1]]);
  const idx = buildLinkIndex(exp2);
  const aoa = fixed.slice(0, 3).concat([['', '', '', 'Water', '', '', '', '', '', '', '1']]);
  const s = readSiteMap([{ name: 'S', aoa }]);
  const r = matchSiteMap(s.built, exp2, idx, {});
  const water = r.rows.find(x => x.title === 'Water');
  assert.equal(water.status, 'ambiguous');
  assert.match(water.candidates, /101 .*\| 777/);
  assert.equal(r.tree[0].children[0].key, 'row:4');    // empty page, keyed by row
  const o = parseOverrides('"Excel row","D10 nid"\r\n"4","777"\r\n"3",""\r\n');
  const r2 = matchSiteMap(s.built, exp2, idx, { overrides: o });
  assert.equal(r2.tree[0].children[0].key, 'page:777');
  assert.equal(r2.rows.find(x => x.row === 3).reason, 'Override: no D10 page');
  void exp;
});

test('unmatched rows can be skipped with their branch', () => {
  const exp = d10.loadExport(exportFiles());
  const s = readSiteMap([{ name: 'S', aoa: fixed }]);
  const r = matchSiteMap(s.built, exp, buildLinkIndex(exp), { unmatchedRows: 'skip' });
  assert.deepEqual(r.tree.map(n => n.title), ['Utilities', 'About Us']);
  assert.deepEqual(r.tree[0].children.map(n => n.title), ['Water']);
  const r2 = matchSiteMap(readSiteMap([{ name: 'S', aoa: fixed.concat([['', '', 'Nowhere', '', '', '', '', '', '', '', '1'], ['', '', '', 'Child', '', '', '', '', '', '', '1']]) }]).built, exp, buildLinkIndex(exp), { unmatchedRows: 'skip' });
  assert.ok(!r2.tree.some(n => n.title === 'Nowhere'));
  assert.equal(r2.rows.find(x => x.title === 'Child').status, 'parent-skipped');
});

test('workbook plan: one menu item per row, shared pages created once', () => {
  const exp = d10.loadExport(exportFiles());
  const aoa = fixed.slice(0, 4).concat([['', '', 'Again', '', '', '', '', '', '', '', '1']]);
  const s = readSiteMap([{ name: 'S', aoa }]);
  const o = parseOverrides('Excel row,D10 nid\n5,101\n');
  const r = matchSiteMap(s.built, exp, buildLinkIndex(exp), { overrides: o });
  const plan = buildPlan(r.tree, { menuSource: 'workbook' });
  assert.equal(plan.menu.length, 3);
  assert.equal(plan.pages.length, 2, 'Water and Again share page:101');
  assert.deepEqual(plan.menu.map(m => m.key), ['menu:row:3', 'menu:row:4', 'menu:row:5']);
});

test('csv reader handles quotes and BOM', () => {
  assert.deepEqual(parseCsv('﻿a,"b,""c"""\r\n1,2\n'), [['a', 'b,"c"'], ['1', '2']]);
});
