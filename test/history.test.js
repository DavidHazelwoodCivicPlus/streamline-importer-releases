'use strict';
const test = require('node:test');
const assert = require('node:assert');
const man = require('../src/lib/manifest');
const hist = require('../src/lib/history');

const HOST = 'example.test';
function made(label, createdAt, runId) {
  const m = man.newManifest({ host: HOST, source: { label }, runId });
  m.createdAt = createdAt;
  man.recordPage(m, 'page:1', { streamlineId: 'p-' + runId, title: 'A page', stage: 'promoted' });
  return m;
}

test('each export is its own import; running the same export again continues it', () => {
  let list = [];
  const a = made('townofzolfo (14 files)', '2026-11-01T10:00:00Z', 'run-a');
  const b = made('cityofhorton (14 files)', '2026-11-02T10:00:00Z', 'run-b');
  list = hist.upsert(list, a);
  list = hist.upsert(list, b);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(hist.forSource(list, 'townofzolfo (14 files)').runId, 'run-a');
  assert.strictEqual(hist.forSource(list, 'cityofnya (14 files)'), null);
  assert.strictEqual(hist.last(list).runId, 'run-b');
  // Saving the first import again (a resume) keeps the order by start time, so "last" is still b.
  man.recordPage(a, 'page:2', { streamlineId: 'p2', title: 'Another', stage: 'promoted' });
  list = hist.upsert(list, a);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(hist.last(list).runId, 'run-b');
  assert.deepStrictEqual(hist.newestFirst(list).map(m => m.runId), ['run-b', 'run-a']);
});

test('undoing the last import leaves the earlier ones', () => {
  let list = [made('a', '2026-11-01T10:00:00Z', 'run-a'), made('b', '2026-11-02T10:00:00Z', 'run-b')];
  list = hist.remove(list, hist.last(list).runId);
  assert.deepStrictEqual(list.map(m => m.runId), ['run-a']);
  // A fully undone manifest (empty) drops out when saved.
  const a = list[0];
  man.forgetPage(a, 'page:1');
  assert.deepStrictEqual(hist.upsert(list, a), []);
});

test('the history round-trips, and a manifest saved by an older version is moved into it', () => {
  const a = made('a', '2026-11-01T10:00:00Z', 'run-a');
  const legacy = made('old', '2026-10-01T10:00:00Z', 'run-old');
  const text = hist.serialize([a]);
  const list = hist.parseHistory(text, HOST, JSON.stringify(legacy));
  assert.deepStrictEqual(list.map(m => m.runId), ['run-old', 'run-a']);
  // Another site's history is ignored, as is garbage.
  assert.deepStrictEqual(hist.parseHistory(text, 'other.test', null), []);
  assert.deepStrictEqual(hist.parseHistory('not json', HOST, 'nor this'), []);
  // The legacy manifest is not added twice.
  assert.strictEqual(hist.parseHistory(hist.serialize(list), HOST, JSON.stringify(legacy)).length, 2);
});
