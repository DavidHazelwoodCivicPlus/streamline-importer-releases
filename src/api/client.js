'use strict';
// HTTP client shared by the userscript (browser fetch, same origin) and the dev tools (node, cookie from .env).
// Throttles every request, retries 429 and 5xx with backoff, and stops on any other error
// with the full request and response attached so it can be logged.

// The test site. The userscript runs on any Streamline site (with a typed confirmation on any other site);
// the dev tools in tools/ only ever talk to this one.
const SANDBOX_HOST = 'davidhazelwoodcpsandbox.specialdistrict.org';

class ApiError extends Error {
  constructor(message, detail) { super(message); this.name = 'ApiError'; this.detail = detail; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// transport(req) -> Promise<{ status, headers: {get(name)}, text }>. req: { method, path, headers, body }.
// opts: { host, allowedHosts?, minIntervalMs, maxRetries, log, sleep }
// allowedHosts, when given, is the only list of hosts this client may talk to (the dev tools pass the sandbox).
function makeClient(transport, opts) {
  opts = Object.assign({ minIntervalMs: 250, maxRetries: 4, log: () => {}, sleep }, opts);
  if (opts.allowedHosts && !opts.allowedHosts.includes(opts.host)) throw new Error('Refusing to run against ' + opts.host + '. Allowed: ' + opts.allowedHosts.join(', '));
  let last = 0, count = 0;

  async function throttle() {
    const wait = last + opts.minIntervalMs - Date.now();
    if (wait > 0) await opts.sleep(wait);
    last = Date.now();
  }

  async function request(method, path, body) {
    const req = { method, path, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
    for (let attempt = 0; ; attempt++) {
      await throttle();
      count++;
      let res;
      try { res = await transport(req); }
      catch (e) {
        if (attempt < opts.maxRetries) { opts.log('  network error on ' + method + ' ' + path + ' (' + e.message + '), retrying'); await opts.sleep(backoff(attempt)); continue; }
        throw new ApiError(method + ' ' + path + ' failed: ' + e.message, { request: req, error: e.message });
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < opts.maxRetries) {
          const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
          const ms = ra > 0 ? ra * 1000 : backoff(attempt);
          opts.log('  ' + method + ' ' + path + ' returned ' + res.status + ', retrying in ' + Math.round(ms / 1000) + 's');
          await opts.sleep(ms);
          continue;
        }
      }
      if (res.status >= 300) {
        throw new ApiError(method + ' ' + path + ' returned ' + res.status, { request: req, status: res.status, response: res.text });
      }
      return res.text ? parseJson(res.text, req) : null;
    }
  }

  function parseJson(text, req) {
    try { return JSON.parse(text); }
    catch (e) { throw new ApiError(req.method + ' ' + req.path + ' returned a non-JSON body', { request: req, response: text.slice(0, 2000) }); }
  }

  // GraphQL errors come back with status 200, so they are checked here.
  async function gql(query, variables) {
    const j = await request('POST', '/api/graphql', { query, variables: variables || {} });
    if (j && j.errors && j.errors.length) {
      throw new ApiError('GraphQL: ' + j.errors.map(e => e.message).join('; '), { request: { query, variables }, response: j });
    }
    return j.data;
  }

  return { request, gql, host: opts.host, requestCount: () => count };
}

const backoff = attempt => Math.min(30000, 1000 * Math.pow(2, attempt));

// Browser transport for the userscript: same-origin fetch, the session cookie rides along,
// XSRF token read fresh from document.cookie on every call.
function browserTransport() {
  const xsrf = () => decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
  return async req => {
    const r = await fetch(req.path, {
      method: req.method, credentials: 'same-origin', body: req.body,
      headers: Object.assign({}, req.headers, { 'X-Xsrf-Token': xsrf() })
    });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
}

// Node transport for dev tools. Keeps the XSRF token current from each response's set-cookie.
function nodeTransport(baseUrl, session, xsrfToken) {
  const state = { session, xsrf: xsrfToken };
  const transport = async req => {
    const r = await fetch(baseUrl + req.path, {
      method: req.method, body: req.body,
      headers: Object.assign({}, req.headers, {
        Cookie: '_traction_session=' + state.session + '; XSRF-TOKEN=' + encodeURIComponent(state.xsrf),
        'X-Xsrf-Token': state.xsrf
      })
    });
    const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    for (const c of cookies) {
      const x = /(?:^|\s)XSRF-TOKEN=([^;]+)/.exec(c);
      if (x) state.xsrf = decodeURIComponent(x[1]);
      const s = /(?:^|\s)_traction_session=([^;]+)/.exec(c);
      if (s) state.session = s[1];
    }
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  transport.state = state;
  return transport;
}

module.exports = { SANDBOX_HOST, ApiError, makeClient, browserTransport, nodeTransport };
