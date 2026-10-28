'use strict';
// Runs the pure steps against the real sample exports when they are on this machine.
// See test/samples.js for where they are looked for. Skipped when none are found.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const d10 = require('../src/lib/d10');
const { buildNavFromD10 } = require('../src/lib/navFromD10');
const { buildPlan } = require('../src/lib/plan');

const dirs = require('./samples').sampleDirs();

for (const dir of dirs) {
  test('sample export ' + path.basename(dir), () => {
    const files = fs.readdirSync(dir).filter(f => /^www-.*\.json$/.test(f))
      .map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
    const exp = d10.loadExport(files);
    assert.deepEqual(exp.errors, []);
    const nav = buildNavFromD10(exp);
    const plan = buildPlan(nav.tree, {});

    // Every page is either planned or skipped with a reason, never both, never lost.
    const planned = new Set(plan.pages.filter(p => p.sourceType === 'page').map(p => p.nid));
    const skipped = new Set(nav.skipped.filter(s => s.sourceType === 'page').map(s => s.nid));
    for (const p of exp.pages) assert.ok(planned.has(p.nid) !== skipped.has(p.nid), 'page ' + p.nid + ' planned xor skipped');
    for (const p of plan.pages) if (p.sourceType === 'page') assert.equal(exp.pages.find(x => x.nid === p.nid).kind, 'page');
    assert.ok(plan.menu.every(m => m.level <= 2));
    assert.equal(new Set(plan.menu.map(m => m.key)).size, plan.menu.length);

    console.log('  ' + path.basename(dir) + ': ' + exp.pages.length + ' page records -> ' +
      plan.menu.filter(m => m.level === 1).length + ' microsites + ' + planned.size + ' pages planned, ' +
      nav.skipped.length + ' skipped, ' + nav.warnings.length + ' warnings');
  });
}

if (!dirs.length) test('sample exports', { skip: 'no sample folders found' }, () => {});

const harvard = require('./samples').sampleDir('cityofharvard');
test('Harvard: the Boil Water Order page gets its 5 FAQs as accordions, in D10 order', { skip: !harvard }, () => {
  const files = fs.readdirSync(harvard).filter(f => /^www-.*\.json$/.test(f)).map(f => ({ name: f, text: fs.readFileSync(path.join(harvard, f), 'utf8') }));
  const exp = d10.loadExport(files);
  const plan = buildPlan(buildNavFromD10(exp).tree, { pageContent: 'content' }, require('../src/lib/links').buildLinkIndex(exp));
  const page = plan.pages.find(p => p.nid === '1061');
  assert.deepEqual(page.faqs.map(f => f.question), ['When is a boil order issued?', 'How do I know if my home is under a boil order?',
    'How long does a boil order last?', 'How can I make my water safe?', 'Can I wash my hands using tap water?']);
});
