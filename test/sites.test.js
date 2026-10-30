'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSiteList, isEnabled, withSite, withoutSite } = require('../src/lib/sites');

test('parseSiteList takes addresses or full URLs, lowercases and drops duplicates', () => {
  assert.deepEqual(
    parseSiteList('https://Foo.SpecialDistrict.org/admin/pages, bar.gov ; foo.specialdistrict.org\nlocalhost:8765'),
    ['foo.specialdistrict.org', 'bar.gov', 'localhost:8765']);
  assert.deepEqual(parseSiteList(''), []);
  assert.deepEqual(parseSiteList('  , ;  '), []);
  assert.deepEqual(parseSiteList('not a host!'), ['not', 'a']); // words split on spaces; "host!" is dropped
});

test('isEnabled / withSite / withoutSite', () => {
  const list = ['a.org'];
  assert.equal(isEnabled(list, 'A.org'), true);
  assert.equal(isEnabled(list, 'b.org'), false);
  assert.equal(isEnabled(null, 'a.org'), false);
  assert.deepEqual(withSite(list, 'B.org'), ['a.org', 'b.org']);
  assert.deepEqual(withSite(list, 'a.org'), ['a.org']);
  assert.deepEqual(withoutSite(['a.org', 'b.org'], 'A.ORG'), ['b.org']);
  assert.deepEqual(list, ['a.org']); // not changed in place
});
