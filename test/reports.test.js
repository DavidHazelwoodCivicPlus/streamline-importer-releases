'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const d10 = require('../src/lib/d10');
const { faqReport, outOfScopeReport } = require('../src/lib/reports');
const { exportFiles } = require('./fixtures');

test('FAQ report groups by microsite and category in weight order', () => {
  const faq = (nid, title, ms, cat, w) => ({ entity_id: String(nid), bundle: 'faq', is_published: true, fields: { title: [{ value: title }], og_audience: [{ target_id: String(ms) }], field_faq_category: [{ target_id: cat }], field_faq_weight: [{ value: String(w) }], path: [{ alias: '/x/faq/' + nid }] } });
  const files = exportFiles().filter(f => f.name !== 'www-faqs.json').concat([
    { name: 'www-faqs.json', text: JSON.stringify([faq(1, 'B?', 10, 5, 2), faq(2, 'A?', 10, 5, 1), faq(3, 'C?', 20, 6, 0)]) },
    { name: 'www-taxonomy_terms.json', text: JSON.stringify([{ entity_id: '5', fields: { name: [{ value: 'Billing' }] } }]) }
  ]);
  const rows = faqReport(d10.loadExport(files));
  assert.deepEqual(rows.map(r => [r.microsite, r.category, r.count, r.questions]), [['About Us', 'term 6', 1, 'C?'], ['Utilities', 'Billing', 2, 'A? | B?']]);
  assert.equal(rows[1].wouldGoOn, 'Utilities (/utilities)');
});

test('out-of-scope report covers news, events and module files', () => {
  const rows = outOfScopeReport(d10.loadExport(exportFiles()));
  const by = Object.fromEntries(rows.map(r => [r.type, r.records]));
  assert.equal(by['News items'], 1);
  assert.equal(by.Events, 1);
  assert.equal(by.FAQs, 0);
  assert.equal(by['Pages that redirect'], 1);
});

const dir = require('./samples').sampleDir('cityofharvard') || '(not on this machine)';
test('reports run on the Harvard export', { skip: !fs.existsSync(dir) }, () => {
  const exp = d10.loadExport(fs.readdirSync(dir).filter(f => /^www-/.test(f)).map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') })));
  const faqs = faqReport(exp);
  assert.equal(faqs.reduce((s, r) => s + r.count, 0), 9);
  assert.ok(outOfScopeReport(exp).find(r => r.type === 'Meetings').records > 900);
});
