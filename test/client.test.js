'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeClient, ApiError } = require('../src/api/client');

const HOST = 'davidhazelwoodcpsandbox.specialdistrict.org';
const res = (status, body, headers) => ({ status, text: body == null ? '' : JSON.stringify(body), headers: { get: n => (headers || {})[n] } });
const quick = { host: HOST, minIntervalMs: 0, sleep: async () => {} };

test('refuses hosts outside allowedHosts when a list is given (the dev tools)', () => {
  assert.throws(() => makeClient(async () => res(200, {}), { host: 'www.cityoftieton.gov', allowedHosts: [HOST] }), /Refusing/);
  assert.doesNotThrow(() => makeClient(async () => res(200, {}), { host: 'any.streamline.site' }));
});

test('retries 429 and 5xx, then succeeds', async () => {
  const seq = [res(429, null, { 'retry-after': '1' }), res(502), res(200, { ok: 1 })];
  const c = makeClient(async () => seq.shift(), quick);
  assert.deepEqual(await c.request('GET', '/api/menus'), { ok: 1 });
  assert.equal(c.requestCount(), 3);
});

test('stops on other 4xx with the full request and response', async () => {
  const c = makeClient(async () => res(422, { error: 'bad title' }), quick);
  await assert.rejects(c.request('POST', '/api/menu_items', { title: '' }), e => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.detail.status, 422);
    assert.equal(e.detail.request.body, '{"title":""}');
    assert.match(e.detail.response, /bad title/);
    return true;
  });
  assert.equal(c.requestCount(), 1);
});

test('GraphQL errors with status 200 are raised', async () => {
  const c = makeClient(async () => res(200, { errors: [{ message: 'Field x does not exist' }] }), quick);
  await assert.rejects(c.gql('{ x }'), /Field x does not exist/);
});

test('gives up after maxRetries on repeated 5xx', async () => {
  const c = makeClient(async () => res(503), Object.assign({ maxRetries: 2 }, quick));
  await assert.rejects(c.request('GET', '/x'), /returned 503/);
  assert.equal(c.requestCount(), 3);
});

test('every source file and the built userscript parse', () => {
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(root, 'src'));
  const built = path.join(root, 'dist', 'streamline-importer.user.js');
  if (fs.existsSync(built)) files.push(built);
  for (const f of files) execFileSync(process.execPath, ['--check', f]); // throws with the syntax error
});

test('requests in flight at the same time still start minIntervalMs apart', async () => {
  const starts = [];
  const c = makeClient(async () => { starts.push(Date.now()); await new Promise(r => setTimeout(r, 30)); return res(200, {}); }, { host: HOST, minIntervalMs: 25 });
  await Promise.all([c.request('GET', '/a'), c.request('GET', '/b'), c.request('GET', '/c'), c.request('GET', '/d')]);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 20, 'gap ' + (starts[i] - starts[i - 1]) + 'ms');
  assert.ok(starts[3] - starts[0] < 30 * 4, 'they overlap rather than run one after another');
});
