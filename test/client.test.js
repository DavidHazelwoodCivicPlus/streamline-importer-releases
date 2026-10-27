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
