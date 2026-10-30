// ==UserScript==
// @name         Drupal 10 to Streamline Importer
// @namespace    civicplus.streamline.d10importer
// @version      0.7.0
// @description  Create Streamline pages and the primary menu from a Drupal 10 export (www-*.json). Runs only on the Streamline sites you turn it on for (Tampermonkey menu).
// @match        https://*/*
// @resource     xlsx https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/DavidHazelwoodCivicPlus/streamline-importer-releases
// @updateURL    https://raw.githubusercontent.com/DavidHazelwoodCivicPlus/streamline-importer-releases/main/dist/streamline-importer.meta.js
// @downloadURL  https://raw.githubusercontent.com/DavidHazelwoodCivicPlus/streamline-importer-releases/main/dist/streamline-importer.user.js
// ==/UserScript==
// Built 2026-10-30T17:29:30.003Z. Do not edit; edit src/ and run "npm run build".

(function () {
  'use strict';
  const defs = {
  "api/client": function (module, exports, require) {
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

  // Requests start at least minIntervalMs apart, even when several are in flight at once (a queue of starts).
  let gate = Promise.resolve();
  function throttle() {
    gate = gate.then(async () => {
      const wait = last + opts.minIntervalMs - Date.now();
      if (wait > 0) await opts.sleep(wait);
      last = Date.now();
    });
    return gate;
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

  },
  "api/streamline": function (module, exports, require) {
'use strict';
// Streamline CMS calls. Each one is taken from a script that already works against the CMS
// (Streamline Demo Tool 0.2.0 for pages, user6 for menus) unless marked UNCONFIRMED.
// docs/api.md tracks what has been checked against the live schema.

// InteriorStandard layout id from 0.2.0. Each run looks the layout up with amplifyLayouts (see runner.resolveLayout),
// since ids may differ per site; this id is only the first thing it tries.
const INTERIOR_STANDARD_LAYOUT_ID = '08ff0b88-28a9-4925-86d1-57eceb5aceca';

const MIME = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf', zip: 'application/zip',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff'
};
function mimeFor(name, blobType) {
  if (blobType && blobType !== 'application/octet-stream') return blobType.split(';')[0];
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
  return (ext && MIME[ext.toLowerCase()]) || 'application/octet-stream';
}

// opts.storagePut(url, blob, contentType) -> Promise<status>: the PUT to the signed storage URL.
// The storage host is not the CMS, so this does not go through the client's host check.
function streamlineApi(client, opts) {
  const { gql, request } = client;
  const storagePut = (opts && opts.storagePut) || (async (url, blob, type) => (await fetch(url, { method: 'PUT', body: blob, headers: { 'Content-Type': type } })).status);

  // ---------- Pages ----------
  async function createPage({ title, layoutId, unpublished }) {
    const d = await gql(
      'mutation($i: AmplifyUpsertPageMutationInput!) { amplifyUpsertPage(input: $i) { page { id slug } } }',
      { i: { amplifyPage: { amplifyTitle: title, amplifyLayoutId: layoutId || INTERIOR_STANDARD_LAYOUT_ID, unpublished: !!unpublished, colorIndex: 'light1' } } }
    );
    return d.amplifyUpsertPage.page; // { id, slug }
  }

  async function draftColumns(pageId) {
    const d = await gql('query($id: ID!) { amplifyDraft(pocId: $id) { containers { columns { id columnType } } } }', { id: pageId });
    return d.amplifyDraft.containers.flatMap(c => c.columns);
  }

  // instanceableType TRACTION_POC + the page id is the combination that renders (from 0.2.0).
  async function addSection(pageId, name, columnId, weight) {
    const d = await gql(
      'mutation($i: AmplifyUpsertSectionInstanceMutationInput!) { amplifyUpsertSectionInstance(input: $i) { sectionInstance { id name } } }',
      { i: { sectionInstance: { name, amplifyColumnId: columnId, weight, instanceableType: 'TRACTION_POC', instanceableId: pageId } } }
    );
    return d.amplifyUpsertSectionInstance.sectionInstance.id;
  }

  async function setFreeform(sectionInstanceId, html, json) {
    await gql(
      'mutation($i: UpsertFreeformContentMutationInput!) { amplifyUpsertFreeformContent(input: $i) { clientMutationId } }',
      { i: { sectionInstanceId, html, json } }
    );
  }

  // Section settings. An accordion folds the section under accordionTitle (checked on the sandbox, 2026-10-28).
  async function setFreeformPreferences(sectionInstanceId, prefs) {
    await gql(
      'mutation($i: AmplifyPreferencesFreeformMutationInput!) { amplifyUpdatePreferencesFreeform(input: $i) { clientMutationId } }',
      { i: { sectionInstanceId, preferences: Object.assign({ colorIndex: 'light1', padding: true, highContrast: false }, prefs) } }
    );
  }

  // Link cards (a Teasers section), set like the card section built by hand on the sandbox (cards, three_column,
  // light3, centered; read 2026-10-29) but without its pageId/buttonText: the
  // button they add (the rounded link) does not show on the public page. Shapes from 0.2.0 and the schema.
  async function setTeaserPreferences(sectionInstanceId, prefs) {
    const preferences = Object.assign({ colorIndex: 'light3', layout: 'cards', columnDesign: 'three_column', titleAlignment: 'centered', paginationStyleIndex: 'pagination', perPage: 3, orderByIndex: 'manual' }, prefs);
    if (!preferences.title) delete preferences.title;
    await gql(
      'mutation($i: AmplifyPreferencesTeaserMutationInput!) { amplifyUpdatePreferencesTeaser(input: $i) { clientMutationId } }',
      { i: { sectionInstanceId, preferences } }
    );
  }
  async function addTeasers(sectionInstanceId, pocIds) {
    if (!pocIds.length) return;
    await gql(
      'mutation($i: AmplifyAddTeasersToSectionInstanceMutationInput!) { amplifyAddTeasersToSectionInstance(input: $i) { clientMutationId } }',
      { i: { sectionInstanceId, isFirst: false, pocIds } }
    );
  }

  // The page's public address on this site, e.g. "/boil-water-order-faqs", as the CMS reports it.
  async function pageUrl(pageId) {
    const rec = await request('GET', '/api/pocs/' + encodeURIComponent(pageId));
    if (!rec || !rec.url) throw new Error('The CMS returned no url for page ' + pageId);
    return rec.url;
  }

  // "already published" is not an error: the public copy is current.
  async function promoteDraft(pageId) {
    try {
      await gql('mutation($i: AmplifyPromoteDraftMutationInput!) { amplifyPromoteDraft(input: $i) { clientMutationId } }', { i: { draftId: pageId } });
      return 'promoted';
    } catch (e) {
      if (/already published/i.test(e.message)) return 'already published';
      throw e;
    }
  }

  // Soft delete through the legacy POC endpoint, as 0.2.0 does. 404 means it is already gone.
  async function deletePage(pageId) {
    let rec;
    try { rec = await request('GET', '/api/pocs/' + encodeURIComponent(pageId)); }
    catch (e) { if (e.detail && e.detail.status === 404) return 'gone'; throw e; }
    if (!rec || rec.deleted) return 'gone';
    await request('PUT', '/api/pocs/' + encodeURIComponent(pageId), Object.assign({}, rec, { deleted: true }));
    return 'deleted';
  }

  // All standard Amplify pages: id, title, unpublished, and when each version was created.
  // Paging (after/pageInfo) is in the schema. amplifyPages has an `unpublished` filter and the schema does not
  // say what leaving it out returns, so both states are listed and merged.
  async function listPages() {
    const byId = new Map();
    for (const unpublished of [false, true]) {
      let after = null;
      for (let guard = 0; ; guard++) {
        if (guard >= 200) throw new Error('Stopped listing pages after 200 batches');
        const d = await gql(
          'query($after: String, $u: Boolean) { amplifyPages(pageType: STANDARD, unpublished: $u, first: 100, after: $after) { nodes { id amplifyTitle slug unpublished draftPageVersion { createdAt } activePageVersion { createdAt } } pageInfo { hasNextPage endCursor } } }',
          { after, u: unpublished }
        );
        const c = d.amplifyPages;
        for (const n of c.nodes || []) if (n) byId.set(String(n.id), n);
        if (!c.pageInfo.hasNextPage) break;
        after = c.pageInfo.endCursor;
      }
    }
    return [...byId.values()];
  }

  async function listLayouts() {
    const d = await gql('{ amplifyLayouts { id name } }');
    return d.amplifyLayouts;
  }

  // ---------- Media (calls confirmed from the HAR capture) ----------
  // 1. createFileUpload -> signed putUrl (expires in 900s, so it is requested right before the PUT)
  // 2. PUT the bytes with Content-Type only
  // 3. createFile (documents) or createImage (images)
  async function uploadMedia({ kind, basename, blob, altText }) {
    const type = mimeFor(basename, blob.type);
    const up = (await gql('mutation($b: String!) { createFileUpload(input: {basename: $b}) { putUrl storagePath } }', { b: basename })).createFileUpload;
    const status = await storagePut(up.putUrl, blob, type);
    if (status < 200 || status >= 300) throw new Error('Upload of ' + basename + ' to storage returned ' + status);
    if (kind === 'image') {
      const img = (await gql('mutation($p: String!) { createImage(input: {storagePath: $p, mediaType: Image}) { image { id largeUrl altText } } }', { p: up.storagePath })).createImage.image;
      // createImage writes its own alt text; the D10 alt text wins when there is one.
      if (altText && altText !== img.altText) {
        await gql('mutation($i: UpdateImageMutationInput!) { updateImage(input: $i) { image { id altText } } }', { i: { image: { id: img.id, altText } } });
        img.altText = altText;
      }
      return { kind, id: img.id, url: img.largeUrl, altText: img.altText, storagePath: up.storagePath };
    }
    const f = (await gql('mutation($p: String!) { createFile(input: {storagePath: $p}) { file { id friendlyUrl } } }', { p: up.storagePath })).createFile.file;
    return { kind, id: f.id, url: f.friendlyUrl, storagePath: up.storagePath };
  }

  async function deleteMedia(kind, id) {
    const m = kind === 'image' ? 'deleteImage' : 'deleteFile';
    await gql('mutation($i: ' + (kind === 'image' ? 'DeleteImageMutationInput!' : 'DeleteFileMutationInput!') + ') { ' + m + '(input: $i) { clientMutationId } }', { i: { id } });
  }

  // ---------- Whole-site listings (for "Erase this site") ----------
  // pocs, files and images are Relay connections; each is read to the end, 100 at a time.
  async function readAll(field, query, vars) {
    const out = [];
    let after = null;
    for (let guard = 0; ; guard++) {
      if (guard >= 500) throw new Error('Stopped listing ' + field + ' after 500 batches');
      const d = await gql(query, Object.assign({ after }, vars || {}));
      const c = d[field];
      out.push(...(c.nodes || []).filter(Boolean));
      if (!c.pageInfo.hasNextPage) return out;
      after = c.pageInfo.endCursor;
    }
  }
  const listAllPocs = () => readAll('pocs', 'query($after: String) { pocs(first: 100, after: $after, hideEvents: false) { nodes { id title pocTypeName canDelete unpublished } pageInfo { hasNextPage endCursor } } }');
  const listFiles = () => readAll('files', 'query($after: String) { files(first: 100, after: $after) { nodes { id basename } pageInfo { hasNextPage endCursor } } }');
  const listImages = () => readAll('images', 'query($after: String) { images(first: 100, after: $after) { nodes { id basename type } pageInfo { hasNextPage endCursor } } }');
  async function listMenus() {
    const ms = await request('GET', '/api/menus');
    return Array.isArray(ms) ? ms : (ms && ms.menus) || [];
  }

  // ---------- Menus ----------
  async function menuIdFor(name) {
    const ms = await request('GET', '/api/menus');
    const list = Array.isArray(ms) ? ms : (ms && ms.menus) || [];
    const m = list.find(x => x.name === name);
    if (!m) throw new Error('Menu not found: ' + name);
    return m.id;
  }

  // The API ignores ?menu_id and returns every menu's items, sometimes twice, so filter and de-duplicate.
  async function menuItems(menuId) {
    const items = await request('GET', '/api/menu_items');
    const seen = new Set();
    return (items || []).filter(i => {
      if (i.deleted || String(i.menu_id) !== String(menuId) || seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });
  }

  async function createMenuItem({ menuId, title, pageId, parentId, weight }) {
    const res = await request('POST', '/api/menu_items', {
      title, poc_id: pageId || null, menu_id: menuId, parent_id: parentId == null ? null : parentId, weight,
      deleted: false, items: [], isNew: true, isDirty: true
    });
    if (!res || res.id == null) throw new Error('POST /api/menu_items returned no id for "' + title + '"');
    return res;
  }

  async function softDeleteMenuItem(item) {
    try {
      await request('PUT', '/api/menu_items/' + item.id, Object.assign({}, item, { deleted: true }));
      return 'deleted';
    } catch (e) {
      if (e.detail && e.detail.status === 404) return 'gone';
      throw e;
    }
  }

  return {
    createPage, draftColumns, addSection, setFreeform, promoteDraft, deletePage, listPages, listLayouts,
    uploadMedia, deleteMedia, setFreeformPreferences, setTeaserPreferences, addTeasers, pageUrl,
    listAllPocs, listFiles, listImages, listMenus,
    menuIdFor, menuItems, createMenuItem, softDeleteMenuItem
  };
}

module.exports = { streamlineApi, INTERIOR_STANDARD_LAYOUT_ID, mimeFor };

  },
  "lib/content": function (module, exports, require) {
'use strict';
// Builds one page's freeform content (html + Lexical json) from its D10 body and attachments, and one
// accordion per FAQ its D10 FAQ sections show, with links resolved for the new site.
// Used for real by the runner and with placeholders by the dry run.

const { convertHtml } = require('./lexical');
const { makeResolver, attachmentsHtml } = require('./links');

const isEmptyDoc = json => json.root.children.length === 1 && json.root.children[0].type === 'paragraph' && !json.root.children[0].children.length;

// page: a plan page (bodyHtml, attachments, faqs). lookups: see links.makeResolver.
// Returns { html, json, warnings, links: [{href, type, result, outcome, target, reason}], empty,
//           faqs: [{ nid, question, html, json }] }
// empty = the body (with its attachments) has nothing in it; the page may still have FAQs.
function buildPageContent(page, idx, lookups, opts) {
  opts = opts || {};
  const links = [];
  const resolver = makeResolver(idx, lookups, e => links.push(e));
  const convert = html => convertHtml(html, {
    resolveLink: resolver.resolveLink,
    resolveEmbed: resolver.resolveEmbed,
    resolveImage: () => null // bodies in the samples have no <img>; any that appear are reported
  });

  const r = convert((page.bodyHtml || '') + (opts.includeAttachments !== false ? attachmentsHtml(idx, page.attachments) : ''));
  // Attachments that point at media missing from www-media.json have no file to link to.
  const warnings = r.warnings.slice();
  if (opts.includeAttachments !== false) for (const id of page.attachments || []) if (!idx.media.has(id)) warnings.push({ code: 'attachment-missing', detail: 'media ' + id + ' is not in www-media.json' });

  const faqs = (page.faqs || []).map(f => {
    const a = convert(f.answerHtml || '');
    for (const w of a.warnings) warnings.push({ code: w.code, detail: 'FAQ "' + f.question + '": ' + w.detail });
    if (isEmptyDoc(a.json)) warnings.push({ code: 'faq-empty-answer', detail: 'FAQ "' + f.question + '" has no answer' });
    return { nid: f.nid, question: f.question, html: a.html, json: a.json };
  });

  return { html: r.html, json: r.json, warnings, links, empty: isEmptyDoc(r.json), faqs };
}

// Dry-run lookups: say where links would go without knowing real URLs yet.
function placeholderLookups(plan) {
  const titles = new Map(plan.pages.map(p => [p.key, p.title]));
  const media = new Set(plan.media || []);
  return {
    pageUrl: key => (titles.has(key) ? '[new page: ' + titles.get(key) + ']' : null),
    media: mid => (media.has(mid) ? { url: '[uploaded media ' + mid + ']', id: 'pending-' + mid } : null)
  };
}

// Which imported pages the content links to (so the runner only looks up those pages' addresses).
function linkedPageKeys(plan, idx, opts) {
  const keys = new Set(plan.pages.map(p => p.key));
  const wanted = new Set();
  const lookups = { pageUrl: key => { if (keys.has(key)) wanted.add(key); return null; }, media: () => null };
  for (const p of plan.pages) if (p.content === 'content') buildPageContent(p, idx, lookups, opts);
  return wanted;
}

module.exports = { buildPageContent, placeholderLookups, linkedPageKeys };

  },
  "lib/csv": function (module, exports, require) {
'use strict';
// CSV writer. Quoted and BOM-prefixed so Excel opens it cleanly (same format as the user6 skip report).

function toCsv(columns, rows) {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [columns.map(c => q(c.label)).join(',')]
    .concat(rows.map(r => columns.map(c => q(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(',')));
  return '﻿' + lines.join('\r\n');
}

const PLAN_COLUMNS = [
  { key: 'level', label: 'Level' }, { key: 'menuPath', label: 'Parent path' }, { key: 'title', label: 'Menu item / page' },
  { key: 'order', label: 'Order' }, { key: 'sourceType', label: 'D10 type' }, { key: 'nid', label: 'D10 nid' },
  { key: 'oldUrl', label: 'Old URL' }, { key: 'd10Published', label: 'Published in D10' }, { key: 'importAs', label: 'Import as' },
  { key: 'row', label: 'Sheet row' }, { key: 'body', label: 'Body' }, { key: 'attachments', label: 'Attachments' }, { key: 'faqs', label: 'FAQ accordions' }, { key: 'cards', label: 'Right-column cards' },
  { key: 'linksToPages', label: 'Links to new pages' }, { key: 'linksToMedia', label: 'Links to uploaded media' },
  { key: 'linksToOldSite', label: 'Links left on old site' }, { key: 'dropped', label: 'Dropped markup' },
  { key: 'notes', label: 'Not carried over' }
];

// One row per link in converted content: where it pointed and where it points now.
const LINK_COLUMNS = [
  { key: 'page', label: 'Page' }, { key: 'nid', label: 'D10 nid' }, { key: 'href', label: 'Link in D10' },
  { key: 'type', label: 'Kind' }, { key: 'outcome', label: 'Now points to' }, { key: 'result', label: 'New link' },
  { key: 'reason', label: 'Why' }
];

// Media that will be (or was) uploaded.
const MEDIA_COLUMNS = [
  { key: 'mid', label: 'D10 media id' }, { key: 'kind', label: 'Kind' }, { key: 'name', label: 'Name' },
  { key: 'fileName', label: 'File' }, { key: 'alt', label: 'Alt text' }, { key: 'url', label: 'Old URL' },
  { key: 'usedBy', label: 'Used by pages' }
];

const SKIPPED_COLUMNS = [
  { key: 'sourceType', label: 'D10 type' }, { key: 'nid', label: 'D10 nid' }, { key: 'title', label: 'Title' },
  { key: 'alias', label: 'Old URL' }, { get: r => r.published ? 'yes' : 'no', label: 'Published in D10' },
  { key: 'parent', label: 'Parent' }, { key: 'reason', label: 'Why skipped' }
];

// Embedded-pages links that could not become right-column cards.
const CARD_ISSUE_COLUMNS = [
  { key: 'page', label: 'Page' }, { key: 'nid', label: 'D10 nid' }, { key: 'section', label: 'Section heading' },
  { key: 'target', label: 'Linked nid' }, { key: 'targetTitle', label: 'Linked title' }, { key: 'reason', label: 'Why no card' }
];

module.exports = { CARD_ISSUE_COLUMNS, toCsv, PLAN_COLUMNS, SKIPPED_COLUMNS, LINK_COLUMNS, MEDIA_COLUMNS };

  },
  "lib/d10": function (module, exports, require) {
'use strict';
// Reads the D10 export (www-*.json files) into plain page and microsite summaries.
// Pure: takes file text, returns data. No DOM, no network.

// The export files we know, keyed by the part after "www-". Empty arrays are valid.
const KNOWN_FILES = [
  'bids_rfps', 'business_directory', 'directory_listings', 'faqs', 'jobs', 'media', 'meetings',
  'microsites', 'ordinances', 'pages', 'paragraphs', 'parks', 'projects', 'property_listings',
  'standard_locations', 'taxonomy_terms'
];
const REQUIRED_FILES = ['pages', 'microsites'];

// D10 field values come as [{value: x}], [{target_id: x}], a bare ["x"], or (field_news_date in the Harvard
// export) a bare "x" with no array around it.
function fieldItems(rec, name) {
  const v = rec && rec.fields ? rec.fields[name] : null;
  if (Array.isArray(v)) return v;
  return v == null || v === '' ? [] : [v];
}
function itemValue(item) {
  if (item == null) return null;
  if (typeof item !== 'object') return item;
  if ('value' in item) return item.value;
  if ('target_id' in item) return item.target_id;
  if ('uri' in item) return item.uri;
  return null;
}
function firstValue(rec, name) {
  for (const it of fieldItems(rec, name)) {
    const v = itemValue(it);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}
const hasValue = (rec, name) => firstValue(rec, name) !== null;

const cleanTitle = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Same buckets as the Build61 tool: news wins over event, everything else is a regular page.
function classifyPage(rec) {
  if (hasValue(rec, 'field_news_date')) return 'news';
  if (hasValue(rec, 'field_smart_date')) return 'event';
  return 'page';
}

function aliasOf(rec) {
  const p = fieldItems(rec, 'path')[0];
  return p && p.alias ? String(p.alias) : '';
}

// Content on the D10 page that milestone 1 does not carry over. Listed so the report can show it.
function pageNotes(rec) {
  const notes = [];
  if (hasValue(rec, 'field_page_redirect')) notes.push('Redirect: ' + firstValue(rec, 'field_page_redirect'));
  if (hasValue(rec, 'field_sections')) notes.push('Has sections (paragraphs)');
  if (hasValue(rec, 'field_file_attachments')) notes.push('Has file attachments');
  if (hasValue(rec, 'field_primary_image_video')) notes.push('Has primary image/video');
  return notes;
}

// Media ids attached to a page (field_file_attachments), in field order.
function attachmentIds(rec) {
  return fieldItems(rec, 'field_file_attachments').map(it => it && (it.target_id != null ? it.target_id : it.entity_id)).filter(v => v != null).map(String);
}

function summarizePage(rec) {
  const body = firstValue(rec, 'body');
  return {
    attachments: attachmentIds(rec),
    sourceType: 'page',
    nid: String(rec.entity_id),
    uuid: firstValue(rec, 'uuid') || '',
    title: cleanTitle(firstValue(rec, 'title')),
    alias: aliasOf(rec),
    published: rec.is_published === true,
    micrositeIds: fieldItems(rec, 'og_audience').map(itemValue).filter(v => v != null).map(String),
    kind: classifyPage(rec),
    bodyHtml: typeof body === 'string' ? body : '',
    hasBody: typeof body === 'string' && body.trim() !== '',
    notes: pageNotes(rec)
  };
}

function summarizeMicrosite(rec) {
  const body = firstValue(rec, 'body');
  return {
    sourceType: 'microsite',
    attachments: [],
    nid: String(rec.entity_id),
    uuid: firstValue(rec, 'uuid') || '',
    title: cleanTitle(firstValue(rec, 'title')),
    alias: aliasOf(rec),
    published: rec.is_published === true,
    typeTermId: firstValue(rec, 'field_microsite_type') != null ? String(firstValue(rec, 'field_microsite_type')) : '',
    bodyHtml: typeof body === 'string' ? body : '',
    hasBody: typeof body === 'string' && body.trim() !== '',
    notes: hasValue(rec, 'field_sections') ? ['Has sections (paragraphs)'] : []
  };
}

// One media entity: an image, a document, or a video link. url is the file on the old site.
function summarizeMedia(rec) {
  const img = fieldItems(rec, 'field_media_image')[0];
  const file = fieldItems(rec, 'field_media_file')[0];
  const video = firstValue(rec, 'field_media_oembed_video');
  const src = img || file || null;
  return {
    mid: String(rec.entity_id),
    uuid: firstValue(rec, 'uuid') || '',
    bundle: rec.bundle,
    kind: img ? 'image' : file ? 'file' : video ? 'video' : 'other',
    name: cleanTitle(firstValue(rec, 'name')),
    url: src && src.file_url ? String(src.file_url) : (video ? String(video) : ''),
    fileName: src && src.file_name ? String(src.file_name) : '',
    alt: img && img.alt ? cleanTitle(img.alt) : '',
    published: rec.is_published === true
  };
}

// Hosts the old site was served from: the canonical URL in page metatags, plus file URLs. Links to these are internal.
function oldSiteHosts(rawPages, media) {
  const hosts = new Map();
  const add = u => { try { const h = new URL(u).host.toLowerCase(); hosts.set(h, (hosts.get(h) || 0) + 1); } catch (e) { /* not a URL */ } };
  for (const r of rawPages || []) {
    for (const t of fieldItems(r, 'metatag')) if (t && t.attributes && t.attributes.rel === 'canonical') add(t.attributes.href);
  }
  for (const m of media) if (m.url && m.kind !== 'video') add(m.url);
  const list = [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  // www and bare domain are the same site.
  for (const h of list.slice()) { const other = h.startsWith('www.') ? h.slice(4) : 'www.' + h; if (!list.includes(other)) list.push(other); }
  return list;
}

// A page's sections (paragraphs), in field order. The export embeds each paragraph in field_sections;
// when it does not, the paragraph is looked up in www-paragraphs.json by id.
function sectionsOf(rec, paragraphById) {
  return fieldItems(rec, 'field_sections').map(it => {
    if (!it) return null;
    const p = it.entity && it.entity.fields ? it.entity : paragraphById.get(String(it.target_id));
    return p ? { pid: String(p.entity_id), bundle: p.bundle, rec: p } : { pid: String(it.target_id), bundle: null, rec: null };
  }).filter(Boolean);
}

// The FAQ sections a page shows: each names one FAQ category.
function faqSectionsOf(rec, paragraphById) {
  return sectionsOf(rec, paragraphById).filter(s => s.bundle === 'faqs' && s.rec).map(s => ({
    pid: s.pid,
    categoryId: firstValue(s.rec, 'field_faq_category') != null ? String(firstValue(s.rec, 'field_faq_category')) : '',
    collapsing: String(firstValue(s.rec, 'field_collapsing_options') || '')
  })).filter(s => s.categoryId);
}

// The "embedded pages" sections a page shows: a heading and the nodes it links to, in order.
// They become link cards in the page's right column.
function embeddedPagesOf(rec, paragraphById) {
  return sectionsOf(rec, paragraphById).filter(s => s.bundle === 'embedded_pages' && s.rec).map(s => ({
    pid: s.pid,
    header: cleanTitle(firstValue(s.rec, 'field_embed_header') || ''),
    nids: fieldItems(s.rec, 'field_embed_individual').map(it => it && (it.target_id != null ? it.target_id : it.entity_id)).filter(v => v != null).map(String),
    embedType: String(firstValue(s.rec, 'field_embed_type') || '')
  }));
}

function summarizeFaq(rec) {
  const body = firstValue(rec, 'body');
  return {
    nid: String(rec.entity_id),
    question: cleanTitle(firstValue(rec, 'title')),
    answerHtml: typeof body === 'string' ? body : '',
    categoryId: firstValue(rec, 'field_faq_category') != null ? String(firstValue(rec, 'field_faq_category')) : '',
    weight: Number(firstValue(rec, 'field_faq_weight')) || 0,
    micrositeIds: fieldItems(rec, 'og_audience').map(itemValue).filter(v => v != null).map(String),
    alias: aliasOf(rec),
    published: rec.is_published === true
  };
}

// FAQs in each category, in the order D10 lists them: weight, then question.
function faqsByCategory(faqs) {
  const map = new Map();
  for (const f of faqs) {
    if (!f.categoryId) continue;
    if (!map.has(f.categoryId)) map.set(f.categoryId, []);
    map.get(f.categoryId).push(f);
  }
  for (const list of map.values()) list.sort((a, b) => a.weight - b.weight || a.question.localeCompare(b.question) || Number(a.nid) - Number(b.nid));
  return map;
}

// "www-pages.json" -> "pages". Returns null for names that are not export files.
function exportKey(fileName) {
  const m = /(?:^|[\\/])www-([a-z_]+)\.json$/i.exec(String(fileName));
  return m ? m[1].toLowerCase() : null;
}

// files: [{name, text}]. Returns everything the later steps need plus counts and problems.
function loadExport(files) {
  const raw = {}, errors = [], warnings = [], counts = {};
  for (const f of files) {
    const key = exportKey(f.name);
    if (!key) { warnings.push('Ignored ' + f.name + ': not a www-*.json export file'); continue; }
    if (!KNOWN_FILES.includes(key)) warnings.push('Unrecognized export file ' + f.name + ' (loaded, not used)');
    if (raw[key]) { errors.push('Two files for www-' + key + '.json'); continue; }
    let data;
    try { data = JSON.parse(f.text); } catch (e) { errors.push(f.name + ' is not valid JSON: ' + e.message); continue; }
    if (!Array.isArray(data)) { errors.push(f.name + ' should hold a JSON array'); continue; }
    raw[key] = data;
    counts[key] = data.length;
  }
  for (const k of REQUIRED_FILES) if (!raw[k]) errors.push('Missing www-' + k + '.json');
  for (const k of KNOWN_FILES) if (!(k in counts)) counts[k] = null; // null = not loaded

  const pages = (raw.pages || []).filter(r => r && r.fields).map(summarizePage);
  const microsites = (raw.microsites || []).filter(r => r && r.fields).map(summarizeMicrosite);

  const msIds = new Set(microsites.map(m => m.nid));
  for (const p of pages) {
    if (!p.micrositeIds.length) warnings.push('Page ' + p.nid + ' "' + p.title + '" has no microsite');
    else if (p.micrositeIds.length > 1) warnings.push('Page ' + p.nid + ' "' + p.title + '" belongs to ' + p.micrositeIds.length + ' microsites');
    for (const id of p.micrositeIds) if (!msIds.has(id)) warnings.push('Page ' + p.nid + ' points at microsite ' + id + ', which is not in www-microsites.json');
  }

  const terms = {};
  for (const t of raw.taxonomy_terms || []) {
    const name = cleanTitle(firstValue(t, 'name'));
    if (t && t.entity_id != null) terms[String(t.entity_id)] = name;
  }

  const media = (raw.media || []).filter(r => r && r.fields).map(summarizeMedia);
  const hosts = oldSiteHosts(raw.pages, media);
  const origin = hosts.length ? 'https://' + hosts[0] : '';

  // FAQ sections on pages and microsites, and the FAQs themselves.
  const paragraphById = new Map((raw.paragraphs || []).filter(p => p && p.entity_id != null).map(p => [String(p.entity_id), p]));
  const rawByNid = new Map([...(raw.pages || []), ...(raw.microsites || [])].filter(r => r && r.fields).map(r => [String(r.entity_id), r]));
  for (const s of pages.concat(microsites)) {
    s.faqSections = faqSectionsOf(rawByNid.get(s.nid), paragraphById);
    s.embeddedPages = embeddedPagesOf(rawByNid.get(s.nid), paragraphById);
  }
  const faqs = (raw.faqs || []).filter(r => r && r.fields).map(summarizeFaq);
  const faqCategories = faqsByCategory(faqs);

  return { pages, microsites, media, faqs, faqCategories, terms, hosts, origin, counts, errors, warnings, raw };
}

module.exports = {
  KNOWN_FILES, REQUIRED_FILES, fieldItems, firstValue, hasValue, cleanTitle, classifyPage,
  summarizePage, summarizeMicrosite, summarizeMedia, summarizeFaq, faqsByCategory, sectionsOf, faqSectionsOf, embeddedPagesOf,
  oldSiteHosts, exportKey, loadExport
};

  },
  "lib/html": function (module, exports, require) {
'use strict';
// Small HTML parser for D10 body fields. Pure (no DOM), so the converter runs the same in the userscript
// and in node tests. Handles what CKEditor output contains: void tags, unclosed <p>/<li>/<td>, entities,
// comments, and raw-text <script>/<style>. Not a full HTML5 parser.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// Opening one of these closes an open <p> (HTML's implied end tags, the cases CKEditor output hits).
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·', copy: '©',
  reg: '®', trade: '™', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', times: '×',
  divide: '÷', laquo: '«', raquo: '»', sect: '§', para: '¶', cent: '¢', pound: '£',
  euro: '€', yen: '¥', shy: '­', zwnj: '‌', zwj: '‍', ensp: ' ', emsp: ' ', thinsp: ' ',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', Eacute: 'É', Ntilde: 'Ñ'
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '');
  }
  return attrs;
}

const el = (tag, attrs) => ({ type: 'element', tag, attrs: attrs || {}, children: [] });

// Returns a root element whose children are the parsed nodes: {type:'element', tag, attrs, children} | {type:'text', text}.
function parseHtml(html) {
  const root = el('#root');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const closeTo = tag => {
    for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; return true; }
    return false;
  };
  const inScope = (tag, stopAt) => {
    for (let i = stack.length - 1; i > 0; i--) { if (stack[i].tag === tag) return true; if (stopAt.includes(stack[i].tag)) return false; }
    return false;
  };
  const s = String(html || '');
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { addText(s.slice(i)); break; }
    if (lt > i) addText(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') { const e = s.indexOf('>', lt); i = e < 0 ? s.length : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(s.slice(lt));
    if (!m) { addText('<'); i = lt + 1; continue; }
    i = lt + m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1]) { // end tag
      if (tag === 'p' && !inScope('p', ['div', 'td', 'th', 'li', 'blockquote', 'table'])) { top().children.push(el('p')); continue; } // stray </p> = empty paragraph
      closeTo(tag);
      continue;
    }
    const node = el(tag, parseAttrs(m[3]));
    if (CLOSES_P.has(tag) && inScope('p', ['div', 'td', 'th', 'li', 'blockquote', 'table'])) closeTo('p');
    if (tag === 'li' && inScope('li', ['ul', 'ol'])) closeTo('li');
    // A new cell closes the open cell, and a new row closes the open row (without leaving the table).
    if (tag === 'td' || tag === 'th') { for (let k = stack.length - 1; k > 0 && stack[k].tag !== 'tr' && stack[k].tag !== 'table'; k--) if (stack[k].tag === 'td' || stack[k].tag === 'th') { stack.length = k; break; } }
    if (tag === 'tr') { for (let k = stack.length - 1; k > 0 && stack[k].tag !== 'table'; k--) if (stack[k].tag === 'tr') { stack.length = k; break; } }
    top().children.push(node);
    if (RAW.has(tag)) {
      const end = s.toLowerCase().indexOf('</' + tag, i);
      const body = s.slice(i, end < 0 ? s.length : end);
      if (body) node.children.push({ type: 'text', text: body });
      const close = end < 0 ? s.length : s.indexOf('>', end);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(node);
  }
  return root;

  function addText(t) {
    const kids = top().children;
    const text = decodeEntities(t);
    const last = kids[kids.length - 1];
    if (last && last.type === 'text') last.text += text; else kids.push({ type: 'text', text });
  }
}

module.exports = { parseHtml, decodeEntities, parseAttrs, VOID };

  },
  "lib/lexical": function (module, exports, require) {
'use strict';
// Converts D10 body HTML into what amplifyUpsertFreeformContent takes: Lexical JSON plus matching HTML.
// Node shapes for text, paragraph, heading, quote, link (decorated-link-node), table and image come from
// Streamline Demo Tool 0.2.0, which was checked against the editor. List and linebreak nodes use Lexical's
// standard shapes (docs/api.md marks them as needing a capture to confirm).
// Pure: links and images are resolved by functions the caller passes in. Anything that cannot be carried
// over is dropped and reported as a warning, never guessed.

const { parseHtml } = require('./html');

const FORMAT = { bold: 1, italic: 2, strikethrough: 4, underline: 8, code: 16, subscript: 32, superscript: 64 };
const TAG_FORMAT = {
  b: FORMAT.bold, strong: FORMAT.bold, i: FORMAT.italic, em: FORMAT.italic, cite: FORMAT.italic, dfn: FORMAT.italic, var: FORMAT.italic,
  u: FORMAT.underline, ins: FORMAT.underline, s: FORMAT.strikethrough, strike: FORMAT.strikethrough, del: FORMAT.strikethrough,
  sub: FORMAT.subscript, sup: FORMAT.superscript, code: FORMAT.code, kbd: FORMAT.code, tt: FORMAT.code, samp: FORMAT.code
};
// Inline wrappers that carry no format of their own: unwrapped (their style may still add bold/italic/underline).
const UNWRAP_INLINE = new Set(['span', 'font', 'small', 'big', 'mark', 'abbr', 'acronym', 'q', 'label', 'time', 'bdi', 'bdo', 'data', 'nobr', 'o:p']);
// Block wrappers: content becomes ordinary blocks.
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center', 'address', 'figure',
  'figcaption', 'dd', 'dt', 'dl', 'details', 'summary', 'fieldset', 'legend', 'li', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption', 'body', 'html']);
// Dropped with their content, and reported.
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'noscript',
  'video', 'audio', 'canvas', 'svg', 'map', 'area', 'head', 'meta', 'link', 'title', 'colgroup', 'col', 'source', 'track', 'picture']);

const textNode = (text, format) => ({ detail: 0, format: format || 0, mode: 'normal', style: '', text, type: 'text', version: 1 });
const paragraph = (children, format) => ({ children, direction: 'ltr', format: format == null ? 'start' : format, indent: 0, type: 'paragraph', version: 1, textFormat: 0, textStyle: '' });
const linebreak = () => ({ type: 'linebreak', version: 1 });

const ALIGN = { left: 'left', center: 'center', right: 'right', justify: 'justify', start: 'start', end: 'end' };
function alignOf(attrs) {
  const m = /text-align\s*:\s*([a-z]+)/i.exec(attrs.style || '');
  return ALIGN[(m ? m[1] : attrs.align || '').toLowerCase()] || null;
}
function styleFormat(attrs) {
  const st = (attrs.style || '').toLowerCase();
  let f = 0;
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(st)) f |= FORMAT.bold;
  if (/font-style\s*:\s*italic/.test(st)) f |= FORMAT.italic;
  if (/text-decoration[^;]*underline/.test(st)) f |= FORMAT.underline;
  if (/text-decoration[^;]*line-through/.test(st)) f |= FORMAT.strikethrough;
  return f;
}

// opts: {
//   resolveLink(href, attrs) -> { url, external, target? } | null   (null: drop the link, keep its text)
//   resolveImage(attrs)      -> { id, url, altText } | null           (null: drop the image)
//   resolveEmbed(attrs)      -> { kind: 'image', id, url, altText } | { kind: 'link', url, text, external } | null   (<drupal-media>)
// }
// Returns { json, html, warnings: [{code, detail}], links: [{href, url}] }
function convertHtml(input, opts) {
  opts = opts || {};
  const warnings = [];
  const warn = (code, detail) => warnings.push({ code, detail: String(detail || '') });
  const links = [];
  const root = parseHtml(input);

  const state = newState((atoms, ctx) => blockFromAtoms(atoms, 'paragraph', null, ctx));
  walk(root.children, { format: 0, link: null, align: null, pre: false, flat: false, inTable: false }, state);
  flush(state, {});
  let children = state.out;
  if (!children.length) children = [paragraph([])];
  const json = { root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } };
  return { json, html: renderBlocks(children), warnings, links };

  function newState(make) { return { out: [], buf: [], make }; }
  function flush(st, ctx) {
    const atoms = st.buf; st.buf = [];
    const made = st.make(atoms, ctx);
    if (made) st.out.push(made);
  }

  // Walks nodes, collecting inline atoms into st.buf and finished blocks into st.out.
  function walk(nodes, ctx, st) {
    for (const n of nodes) {
      if (n.type === 'text') { pushText(n.text, ctx, st); continue; }
      const t = n.tag;
      if (DROP.has(t)) { warn('dropped-' + t, describe(n)); continue; }
      if (t === 'br') { st.buf.push({ br: true, link: ctx.link }); continue; }
      if (t === 'wbr') continue;
      if (t === 'img') { image(n.attrs, ctx, st); continue; }
      if (t === 'drupal-media') { embed(n.attrs, ctx, st); continue; }
      if (t === 'a') { anchor(n, ctx, st); continue; }
      if (TAG_FORMAT[t] || UNWRAP_INLINE.has(t)) {
        walk(n.children, Object.assign({}, ctx, { format: ctx.format | (TAG_FORMAT[t] || 0) | styleFormat(n.attrs) }), st);
        continue;
      }
      if (t === 'hr') { flush(st, ctx); warn('dropped-hr', 'horizontal rule'); continue; }
      if (!ctx.flat && /^h[1-6]$/.test(t)) {
        flush(st, ctx);
        let tag = t;
        if (t === 'h1') { tag = 'h2'; warn('h1-demoted', textOf(n)); }
        const sub = newState(atoms => blockFromAtoms(atoms, 'heading', tag));
        walk(n.children, Object.assign({}, ctx, { format: ctx.format }), sub);
        flush(sub, ctx);
        st.out.push(...sub.out);
        continue;
      }
      if (!ctx.flat && t === 'blockquote') {
        flush(st, ctx);
        const sub = newState(atoms => blockFromAtoms(atoms, 'quote'));
        walk(n.children, ctx, sub);
        flush(sub, ctx);
        st.out.push(...sub.out);
        continue;
      }
      if (t === 'ul' || t === 'ol') {
        flush(st, ctx);
        if (ctx.flat) { walk(n.children, ctx, st); flush(st, ctx); continue; } // a list inside a table cell: flattened
        st.out.push(list(n, ctx, 0));
        continue;
      }
      if (t === 'table') {
        flush(st, ctx);
        if (ctx.inTable || ctx.flat) { warn('nested-table-flattened', textOf(n).slice(0, 80)); walk(n.children, ctx, st); flush(st, ctx); continue; }
        const tb = table(n, ctx);
        if (tb.caption) st.out.push(tb.caption);
        if (tb.node) st.out.push(tb.node);
        continue;
      }
      if (t === 'pre') {
        flush(st, ctx);
        walk(n.children, Object.assign({}, ctx, { pre: true }), st);
        flush(st, ctx);
        continue;
      }
      if (BLOCKS.has(t) || /^h[1-6]$/.test(t) || t === 'blockquote') {
        flush(st, ctx);
        const c = Object.assign({}, ctx, { align: alignOf(n.attrs) || ctx.align });
        walk(n.children, c, st);
        flush(st, c);
        continue;
      }
      warn('unwrapped-' + t, describe(n));
      walk(n.children, ctx, st);
    }
  }

  function pushText(text, ctx, st) {
    let s = text.replace(/ /g, ' ');
    if (ctx.pre) {
      s.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
        if (i) st.buf.push({ br: true, link: ctx.link });
        if (line) st.buf.push({ text: line, format: ctx.format, link: ctx.link, pre: true });
      });
      return;
    }
    s = s.replace(/[\s​]+/g, ' ');
    if (s) st.buf.push({ text: s, format: ctx.format, link: ctx.link });
  }

  function anchor(n, ctx, st) {
    const href = (n.attrs.href || '').trim();
    if (!href) { walk(n.children, ctx, st); return; } // named anchor
    const r = opts.resolveLink ? opts.resolveLink(href, n.attrs) : { url: href, external: /^https?:/i.test(href) };
    links.push({ href, url: r ? r.url : null });
    if (!r) { walk(n.children, ctx, st); return; }
    const target = r.target !== undefined ? r.target : (n.attrs.target === '_blank' ? '_blank' : null);
    walk(n.children, Object.assign({}, ctx, { link: { url: r.url, external: !!r.external, target } }), st);
  }

  function image(attrs, ctx, st) {
    const r = opts.resolveImage ? opts.resolveImage(attrs) : null;
    if (!r) { warn('dropped-image', attrs.src || ''); return; }
    flush(st, ctx);
    st.out.push(imageBlock(r));
  }

  function embed(attrs, ctx, st) {
    const r = opts.resolveEmbed ? opts.resolveEmbed(attrs) : null;
    if (!r) { warn('dropped-embed', attrs['data-entity-uuid'] || ''); return; }
    if (r.kind === 'image') { flush(st, ctx); st.out.push(imageBlock(r)); return; }
    const link = { url: r.url, external: !!r.external, target: null };
    st.buf.push({ text: r.text || r.url, format: ctx.format, link });
    links.push({ href: 'drupal-media:' + (attrs['data-entity-uuid'] || ''), url: r.url });
  }

  function imageBlock(r) {
    return paragraph([{ type: 'resizeable-image', altText: r.altText || '', imageId: r.id, version: 1, position: 'center', src: r.url, uncroppedSrc: r.url }]);
  }

  // Turns collected atoms into inline Lexical nodes: whitespace trimmed, adjacent text merged, links grouped.
  function inlineNodes(atoms) {
    const a = [];
    for (const x of atoms) {
      if (x.br) { a.push(x); continue; }
      let text = x.text;
      if (!x.pre) {
        const prev = a[a.length - 1];
        if (!prev || prev.br || /\s$/.test(prev.text)) text = text.replace(/^ +/, '');
      }
      if (text) a.push(Object.assign({}, x, { text }));
    }
    // Trailing spaces at the end and before line breaks.
    for (let i = a.length - 1; i >= 0; i--) {
      const next = a[i + 1];
      if (!a[i].br && !a[i].pre && (!next || next.br)) a[i] = Object.assign({}, a[i], { text: a[i].text.replace(/ +$/, '') });
    }
    const b = a.filter(x => x.br || x.text);
    while (b.length && b[b.length - 1].br) b.pop(); // trailing <br>
    while (b.length && b[0].br) b.shift();
    if (!b.some(x => !x.br)) return [];

    const out = [];
    let curLink = null, linkNode = null;
    const target = () => (linkNode ? linkNode.children : out);
    for (const x of b) {
      if (x.link !== curLink) {
        curLink = x.link;
        linkNode = curLink ? { children: [], direction: 'ltr', format: '', indent: 0, rel: null, target: curLink.target, title: null, type: 'decorated-link-node', url: curLink.url, version: 1, external: curLink.external } : null;
        if (linkNode) out.push(linkNode);
      }
      const into = target();
      if (x.br) { into.push(linebreak()); continue; }
      const last = into[into.length - 1];
      if (last && last.type === 'text' && last.format === x.format) last.text += x.text;
      else into.push(textNode(x.text, x.format));
    }
    return out.filter(n => n.type !== 'decorated-link-node' || n.children.length);
  }

  function blockFromAtoms(atoms, kind, tag, ctx) {
    const kids = inlineNodes(atoms);
    if (!kids.length) return null;
    if (kind === 'heading') return { children: kids, direction: 'ltr', format: 'start', indent: 0, tag, type: 'heading', version: 1 };
    if (kind === 'quote') return { children: kids, direction: 'ltr', format: 'start', indent: 0, type: 'quote', version: 1 };
    return paragraph(kids, (ctx && ctx.align) || 'start');
  }

  // Lexical lists: a nested list sits in its own listitem right after the item it belongs to.
  function list(n, ctx, depth) {
    const listType = n.tag === 'ol' ? 'number' : 'bullet';
    const start = n.tag === 'ol' ? Math.max(1, parseInt(n.attrs.start, 10) || 1) : 1;
    const items = [];
    let value = start;
    const lis = n.children.filter(c => !(c.type === 'text' && !c.text.trim()));
    for (const li of lis) {
      const kids = li.type === 'element' && li.tag === 'li' ? li.children : [li];
      const nested = [], rest = [];
      for (const k of kids) (k.type === 'element' && (k.tag === 'ul' || k.tag === 'ol') ? nested : rest).push(k);
      const sub = newState(atoms => atoms.length ? atoms : null);
      walk(rest, Object.assign({}, ctx, { flat: true }), sub);
      flush(sub, ctx);
      const joined = [];
      sub.out.forEach((atoms, i) => { if (i) joined.push({ br: true, link: null }); joined.push(...atoms); });
      const inl = inlineNodes(joined);
      if (inl.length || !nested.length) items.push({ children: inl, direction: 'ltr', format: '', indent: depth, type: 'listitem', value: value++, version: 1 });
      for (const nl of nested) items.push({ children: [list(nl, ctx, depth + 1)], direction: 'ltr', format: '', indent: depth, type: 'listitem', value, version: 1 });
    }
    return { children: items, direction: 'ltr', format: '', indent: 0, listType, start, tag: n.tag, type: 'list', version: 1 };
  }

  function table(n, ctx) {
    const rows = [];
    let caption = null;
    const collect = (nodes, inHead) => {
      for (const c of nodes) {
        if (c.type !== 'element') continue;
        if (c.tag === 'tr') rows.push({ el: c, inHead });
        else if (c.tag === 'thead') collect(c.children, true);
        else if (c.tag === 'tbody' || c.tag === 'tfoot') collect(c.children, false);
        else if (c.tag === 'caption') {
          const sub = newState(atoms => blockFromAtoms(atoms, 'paragraph'));
          walk(c.children, ctx, sub); flush(sub, ctx);
          caption = sub.out[0] || null;
        }
      }
    };
    collect(n.children, false);
    if (!rows.length) { warn('empty-table', ''); return { caption, node: null }; }
    const cellCtx = Object.assign({}, ctx, { inTable: true });
    const grid = rows.map(r => r.el.children.filter(c => c.type === 'element' && (c.tag === 'td' || c.tag === 'th')));
    const headerColumn = grid.length > 1 && grid.every(cells => cells[0] && cells[0].tag === 'th');
    let width = 0;
    const out = grid.map((cells, ri) => {
      const headerRow = rows[ri].inHead || (cells.length > 0 && cells.every(c => c.tag === 'th'));
      const lexCells = cells.map((c, ci) => {
        const sub = newState(atoms => { const k = inlineNodes(atoms); return k.length ? paragraph(k, '') : null; });
        walk(c.children, cellCtx, sub); flush(sub, cellCtx);
        let hs = 0;
        if (c.tag === 'th') { if (headerRow) hs |= 1; if (ci === 0 && headerColumn) hs |= 2; if (!hs) hs = 1; }
        const colSpan = Math.max(1, parseInt(c.attrs.colspan, 10) || 1), rowSpan = Math.max(1, parseInt(c.attrs.rowspan, 10) || 1);
        if (rowSpan > 1) warn('table-rowspan', 'row ' + (ri + 1));
        return {
          children: sub.out.length ? sub.out : [paragraph([], '')], colSpan, rowSpan, headerState: hs,
          backgroundColor: null, direction: 'ltr', format: '', indent: 0, type: 'tablecell', version: 1
        };
      });
      width = Math.max(width, lexCells.reduce((s, c) => s + c.colSpan, 0));
      return lexCells;
    });
    // Lexical needs every row to be as wide as the widest one.
    const tableRows = out.map(cells => {
      const have = cells.reduce((s, c) => s + c.colSpan, 0);
      for (let k = have; k < width; k++) cells.push({ children: [paragraph([], '')], colSpan: 1, rowSpan: 1, headerState: 0, backgroundColor: null, direction: 'ltr', format: '', indent: 0, type: 'tablecell', version: 1 });
      return { children: cells, direction: 'ltr', format: '', indent: 0, type: 'tablerow', version: 1 };
    });
    return { caption, node: { children: tableRows, colWidths: Array(width).fill(92), direction: 'ltr', format: '', indent: 0, type: 'table', version: 1 } };
  }

  function describe(n) { return '<' + n.tag + (n.attrs.src ? ' src="' + n.attrs.src + '"' : '') + '> ' + textOf(n).slice(0, 60); }
}

function textOf(n) {
  if (n.type === 'text') return n.text;
  return (n.children || []).map(textOf).join('').replace(/\s+/g, ' ').trim();
}

// ---------- HTML rendering from the Lexical tree (so html and json always agree) ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderInline(nodes) {
  return nodes.map(n => {
    if (n.type === 'linebreak') return '<br>';
    if (n.type === 'text') {
      let h = esc(n.text);
      const f = n.format;
      if (f & FORMAT.code) h = '<code>' + h + '</code>';
      if (f & FORMAT.subscript) h = '<sub>' + h + '</sub>';
      if (f & FORMAT.superscript) h = '<sup>' + h + '</sup>';
      if (f & FORMAT.strikethrough) h = '<s>' + h + '</s>';
      if (f & FORMAT.underline) h = '<u>' + h + '</u>';
      if (f & FORMAT.italic) h = '<em>' + h + '</em>';
      if (f & FORMAT.bold) h = '<strong>' + h + '</strong>';
      return h;
    }
    if (n.type === 'decorated-link-node') return '<a href="' + esc(n.url) + '"' + (n.target ? ' target="' + esc(n.target) + '"' : '') + '>' + renderInline(n.children) + '</a>';
    if (n.type === 'resizeable-image') return '<div class="freeform-editor-resizable-image-center"><img src="' + esc(n.src) + '" data-image-id="' + esc(n.imageId) + '" alt="' + esc(n.altText) + '"></div>';
    return '';
  }).join('');
}

const alignStyle = f => (f && f !== 'start' && f !== 'left' ? ' style="text-align: ' + f + ';"' : '');

function renderBlocks(blocks) {
  return blocks.map(b => {
    switch (b.type) {
      case 'paragraph':
        if (b.children.length === 1 && b.children[0].type === 'resizeable-image') return '<p class="freeform-editor-paragraph">' + renderInline(b.children) + '</p>';
        return '<p' + alignStyle(b.format) + '>' + renderInline(b.children) + '</p>';
      case 'heading': return '<' + b.tag + '>' + renderInline(b.children) + '</' + b.tag + '>';
      case 'quote': return '<blockquote>' + renderInline(b.children) + '</blockquote>';
      case 'list': return renderList(b);
      case 'table': return renderTable(b);
      default: return '';
    }
  }).join('');
}

function renderList(l) {
  const open = l.tag === 'ol' ? '<ol' + (l.start > 1 ? ' start="' + l.start + '"' : '') + '>' : '<ul>';
  const items = l.children.map(li => {
    if (li.children.length === 1 && li.children[0].type === 'list') return '<li>' + renderList(li.children[0]) + '</li>';
    return '<li>' + renderInline(li.children) + '</li>';
  }).join('');
  return open + items + '</' + l.tag + '>';
}

// Same table markup the editor writes (from 0.2.0).
function renderTable(t) {
  const cellStyle = 'border: 1px solid black; width: 75px; vertical-align: top; text-align: start;';
  const headStyle = cellStyle + ' background-color: rgb(242, 243, 245);';
  const cols = t.colWidths.map(w => '<col style="width: ' + w + 'px;">').join('');
  const rows = t.children.map((r, ri) => '<tr' + (ri === 0 ? ' dir="ltr"' : '') + '>' + r.children.map(c => {
    const span = (c.colSpan > 1 ? ' colspan="' + c.colSpan + '"' : '') + (c.rowSpan > 1 ? ' rowspan="' + c.rowSpan + '"' : '');
    const inner = c.children.map(p => '<p class="freeform-editor-paragraph">' + (p.children.length ? '<span style="white-space: pre-wrap;">' + renderInline(p.children) + '</span>' : '<br>') + '</p>').join('');
    return c.headerState
      ? '<th class="freeform-editor-table-cell freeform-editor-table-header" dir="ltr" style="' + headStyle + '"' + span + '>' + inner + '</th>'
      : '<td class="freeform-editor-table-cell" style="' + cellStyle + '"' + span + '>' + inner + '</td>';
  }).join('') + '</tr>').join('');
  return '<table class="freeform-editor-table"><colgroup>' + cols + '</colgroup><tbody>' + rows + '</tbody></table>';
}

module.exports = { convertHtml, renderBlocks, FORMAT, textOf };

  },
  "lib/links": function (module, exports, require) {
'use strict';
// Decides where every link and media reference in a D10 body points on the new site.
//   /node/N, old aliases, and absolute old-site page URLs -> the new page's URL, if that page is imported
//   /media/N, data-entity-uuid, /sites/.../files/...       -> the uploaded Streamline file or image, if uploaded
// Anything that cannot be resolved is pointed at the old site's absolute URL (so it still works until the old
// site is retired) and reported. Nothing is guessed. Pure: page and media lookups are passed in.

function normPath(p) {
  let s = String(p || '');
  try { s = decodeURI(s); } catch (e) { /* keep as is */ }
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return s || '/';
}

// Indexes built once per export.
function buildLinkIndex(exp) {
  const nodes = new Map();   // nid -> { sourceType, kind, title, alias }
  const aliases = new Map(); // normalized alias -> nid
  for (const p of exp.pages) { nodes.set(p.nid, { sourceType: 'page', kind: p.kind, title: p.title, alias: p.alias }); if (p.alias) aliases.set(normPath(p.alias), p.nid); }
  for (const m of exp.microsites) { nodes.set(m.nid, { sourceType: 'microsite', kind: 'microsite', title: m.title, alias: m.alias }); if (m.alias) aliases.set(normPath(m.alias), m.nid); }
  // Module records (jobs, bids, parks…) are nodes too; when they are imported, links to them go to their page.
  const { MODULES } = require('./modules');
  for (const [type, def] of Object.entries(MODULES)) {
    if (type === 'news') continue; // news items are page records, already above
    for (const r of (exp.raw && exp.raw[def.file]) || []) {
      if (!r || r.entity_id == null || !r.fields) continue;
      const nid = String(r.entity_id), t = r.fields.title && r.fields.title[0] && r.fields.title[0].value;
      const alias = (r.fields.path && r.fields.path[0] && r.fields.path[0].alias) || '';
      if (!nodes.has(nid)) nodes.set(nid, { sourceType: type, kind: type, title: String(t || ''), alias });
      if (alias) aliases.set(normPath(alias), nid);
    }
  }
  const media = new Map(), byUuid = new Map(), byPath = new Map();
  for (const m of exp.media || []) {
    media.set(m.mid, m);
    if (m.uuid) byUuid.set(m.uuid, m.mid);
    if (m.url && m.kind !== 'video') { try { byPath.set(normPath(new URL(m.url).pathname), m.mid); } catch (e) { /* bad url */ } }
  }
  return {
    nodes, aliases, media, byUuid, byPath, hosts: new Set((exp.hosts || []).map(h => h.toLowerCase())), origin: exp.origin || '',
    faqCategories: exp.faqCategories || new Map()
  };
}

// The plan key of the page a node becomes: page:N, microsite:N, news:N, jobs:N, …
const keyFor = (idx, nid) => { const n = idx.nodes.get(nid); return !n ? null : (n.kind === 'news' ? 'news:' : n.sourceType + ':') + nid; };

// Classifies an href without resolving it. Returns { type, nid?, mid?, path?, url } where type is
// 'node' | 'media' | 'file' | 'alias' | 'internal' | 'external' | 'special'.
function classify(idx, href, attrs) {
  const raw = String(href || '').trim();
  const uuid = attrs && attrs['data-entity-uuid'];
  if (uuid && idx.byUuid.has(uuid) && (!attrs['data-entity-type'] || attrs['data-entity-type'] === 'media')) return { type: 'media', mid: idx.byUuid.get(uuid), url: raw };
  if (/^(mailto:|tel:|sms:|#|javascript:)/i.test(raw)) return { type: 'special', url: raw };
  let path = raw, hash = '';
  if (/^(https?:)?\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw.startsWith('//') ? 'https:' + raw : raw); } catch (e) { return { type: 'external', url: raw }; }
    if (!idx.hosts.has(u.host.toLowerCase())) return { type: 'external', url: raw };
    path = u.pathname + u.search; hash = u.hash;
  } else if (!raw.startsWith('/')) {
    return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? { type: 'external', url: raw } : { type: 'internal', path: '/' + raw, url: raw };
  }
  const h = hash || (/#.*$/.exec(path) || [''])[0];
  const np = normPath(path);
  let m;
  if ((m = /^\/node\/(\d+)$/.exec(np))) return { type: 'node', nid: m[1], hash: h, url: raw };
  if ((m = /^\/media\/(\d+)(?:\/.*)?$/.exec(np))) return { type: 'media', mid: m[1], url: raw };
  if (idx.byPath.has(np)) return { type: 'media', mid: idx.byPath.get(np), url: raw };
  if (/^\/sites\/.+\/files\//.test(np) || /^\/system\/files\//.test(np)) return { type: 'file', path: path.replace(/[#].*$/, ''), url: raw };
  if (idx.aliases.has(np)) return { type: 'alias', nid: idx.aliases.get(np), hash: h, url: raw };
  return { type: 'internal', path: path.replace(/[#].*$/, ''), hash: h, url: raw };
}

// lookups: { pageUrl(key) -> url | null, media(mid) -> { url, kind, id, altText } | null }
// report(entry) is called once per link with { href, type, result, reason, target }.
function makeResolver(idx, lookups, report) {
  const rec = report || (() => {});
  const oldUrl = p => (idx.origin ? idx.origin + (p.startsWith('/') ? p : '/' + p) : p);

  function nodeTarget(c) {
    const key = keyFor(idx, c.nid);
    const n = idx.nodes.get(c.nid);
    const url = key && lookups.pageUrl ? lookups.pageUrl(key) : null;
    if (url) return done(c, { url: url + (c.hash || ''), external: false }, 'page', key);
    const why = !n ? 'links to node ' + c.nid + ', which is not in the export'
      : n.kind !== 'page' && n.kind !== 'microsite' ? 'links to a ' + n.kind + ' ("' + n.title + '"), not imported'
        : 'links to "' + n.title + '", which is not imported';
    return done(c, { url: oldUrl(n && n.alias ? n.alias : '/node/' + c.nid) + (c.hash || ''), external: true }, 'old-site', key, why);
  }
  function mediaTarget(c) {
    const m = idx.media.get(c.mid);
    const up = lookups.media ? lookups.media(c.mid) : null;
    if (up && up.url) return done(c, { url: up.url, external: false }, 'media', 'media:' + c.mid);
    if (!m) return done(c, { url: /^https?:/i.test(c.url) ? c.url : oldUrl(c.url || '/media/' + c.mid), external: true }, 'old-site', null, 'media ' + c.mid + ' is not in www-media.json');
    if (m.kind === 'video') return done(c, { url: m.url, external: true }, 'external', 'media:' + c.mid, 'video link kept as is');
    return done(c, { url: m.url, external: true }, 'old-site', 'media:' + c.mid, '"' + (m.name || m.fileName) + '" is not uploaded');
  }
  function done(c, result, outcome, target, reason) {
    rec({ href: c.url, type: c.type, result: result.url, outcome, target: target || '', reason: reason || '' });
    return result;
  }

  function resolveLink(href, attrs) {
    const c = classify(idx, href, attrs);
    switch (c.type) {
      case 'node': case 'alias': return nodeTarget(c);
      case 'media': return mediaTarget(c);
      case 'file': return done(c, { url: oldUrl(c.path), external: true }, 'old-site', '', 'file not found in www-media.json');
      case 'internal': return done(c, { url: oldUrl(c.path) + (c.hash || ''), external: true }, 'old-site', '', 'old-site path with no matching page');
      case 'special': return done(c, { url: c.url, external: false }, 'kept', '');
      default: return done(c, { url: c.url, external: true }, 'external', '');
    }
  }
  function resolveEmbed(attrs) {
    const c = classify(idx, '', attrs);
    if (c.type !== 'media') return null;
    const m = idx.media.get(c.mid);
    const up = lookups.media ? lookups.media(c.mid) : null;
    if (m && m.kind === 'image' && up && up.id) { rec({ href: 'drupal-media', type: 'media', result: up.url, outcome: 'media', target: 'media:' + c.mid, reason: '' }); return { kind: 'image', id: up.id, url: up.url, altText: m.alt || up.altText || '' }; }
    const r = mediaTarget(c);
    return { kind: 'link', url: r.url, external: r.external, text: m ? (m.name || m.fileName) : 'Document' };
  }
  return { resolveLink, resolveEmbed };
}

// Media a page's body and attachments point at (ids that exist in www-media.json), in first-seen order.
function referencedMedia(idx, html, attachments) {
  const out = [];
  const add = mid => { if (mid && idx.media.has(mid) && !out.includes(mid)) out.push(mid); };
  const re = /<(a|drupal-media|img)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const attrs = {};
    m[2].replace(/([\w-]+)\s*=\s*"([^"]*)"/g, (x, k, v) => { attrs[k.toLowerCase()] = v; });
    const c = classify(idx, attrs.href || attrs.src || '', attrs);
    if (c.type === 'media') add(c.mid);
  }
  for (const a of attachments || []) add(a);
  return out;
}

// HTML appended to a body for its file attachments, so they become ordinary links (rewritten like any other).
function attachmentsHtml(idx, ids) {
  const items = (ids || []).map(id => idx.media.get(id)).filter(Boolean);
  if (!items.length) return '';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return '<h2>Documents</h2><ul>' + items.map(m => '<li><a href="/media/' + esc(m.mid) + '">' + esc(m.name || m.fileName || 'Document') + '</a></li>').join('') + '</ul>';
}

module.exports = { normPath, buildLinkIndex, classify, makeResolver, referencedMedia, attachmentsHtml };

  },
  "lib/manifest": function (module, exports, require) {
'use strict';
// The run manifest: every object a run creates, keyed by the plan key (e.g. "page:41", "menu:page:41").
// Resume and undo work from this, so it is written after every single create.
// Pure data helpers; saving (localStorage, download) is the caller's job.

const FORMAT = 'streamline-importer-manifest';
const VERSION = 1;

// Page stages, in order. A page is only "done" at the last stage the run needs.
const PAGE_STAGES = ['created', 'section', 'content', 'promoted'];

function newManifest(info) {
  const now = new Date().toISOString();
  return {
    format: FORMAT, version: VERSION,
    runId: info.runId || ('run-' + now.replace(/[-:.TZ]/g, '').slice(0, 14)),
    host: info.host, createdAt: now, updatedAt: now,
    source: info.source || {}, options: info.options || {},
    menuName: info.menuName || 'primary', menuId: null,
    pages: {}, menuItems: {}, media: {}
  };
}

function parseManifest(text, expectedHost) {
  let m;
  try { m = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw new Error('Manifest is not valid JSON: ' + e.message); }
  if (!m || m.format !== FORMAT) throw new Error('This file is not an importer manifest');
  if (m.version !== VERSION) throw new Error('Manifest version ' + m.version + ' is not supported (expected ' + VERSION + ')');
  if (expectedHost && m.host !== expectedHost) throw new Error('This manifest belongs to ' + m.host + ', not ' + expectedHost);
  if (!m.pages || typeof m.pages !== 'object' || !m.menuItems || typeof m.menuItems !== 'object') throw new Error('Manifest is missing its pages or menu items');
  if (!m.media || typeof m.media !== 'object') m.media = {};
  return m;
}

const touch = m => { m.updatedAt = new Date().toISOString(); return m; };

function recordPage(m, key, data) {
  m.pages[key] = Object.assign({}, m.pages[key], data, { at: new Date().toISOString() });
  return touch(m);
}
function setPageStage(m, key, stage, extra) {
  if (!m.pages[key]) throw new Error('No page ' + key + ' in the manifest');
  if (!PAGE_STAGES.includes(stage)) throw new Error('Unknown page stage ' + stage);
  return recordPage(m, key, Object.assign({ stage }, extra || {}));
}
const pageStageAtLeast = (rec, stage) => !!rec && PAGE_STAGES.indexOf(rec.stage) >= PAGE_STAGES.indexOf(stage);

function recordMenuItem(m, key, data) {
  m.menuItems[key] = Object.assign({}, data, { at: new Date().toISOString() });
  return touch(m);
}
function recordMedia(m, mid, data) {
  m.media[mid] = Object.assign({}, data, { at: new Date().toISOString() });
  return touch(m);
}
function forgetMedia(m, mid) { delete m.media[mid]; return touch(m); }
function forgetPage(m, key) { delete m.pages[key]; return touch(m); }
function forgetMenuItem(m, key) { delete m.menuItems[key]; return touch(m); }

function summary(m) {
  const pages = Object.values(m.pages);
  return {
    runId: m.runId, host: m.host, source: m.source && m.source.label,
    pages: pages.length, promoted: pages.filter(p => p.stage === 'promoted').length,
    menuItems: Object.keys(m.menuItems).length, media: Object.keys(m.media || {}).length, updatedAt: m.updatedAt
  };
}

const isEmpty = m => !Object.keys(m.pages).length && !Object.keys(m.menuItems).length && !Object.keys(m.media || {}).length;

module.exports = {
  FORMAT, VERSION, PAGE_STAGES, newManifest, parseManifest, recordPage, setPageStage, pageStageAtLeast,
  recordMenuItem, recordMedia, forgetMedia, forgetPage, forgetMenuItem, summary, isEmpty
};

  },
  "lib/match": function (module, exports, require) {
'use strict';
// Matches site-map rows to D10 pages: by the row's old URL first, then by title when exactly one regular page
// or microsite has that title. Ambiguous or unmatched rows are never guessed; they are reported and become
// empty pages (or are skipped, per the option). A manual override CSV (Excel row -> D10 nid) settles them.
// Pure.

const { classify } = require('./links');

// Same normalization as the Build61 tool's normalizeForMatch.
const normalizeTitle = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

// Small CSV reader for override files (quotes, doubled quotes, CRLF, BOM).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// Override CSV: needs an "Excel row" column and a "D10 nid" column. A blank nid or "none" means
// "no D10 page: create it empty". The match report itself can be edited and loaded back.
function parseOverrides(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('The override file is empty');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const rc = head.findIndex(h => /^(excel\s*)?row$/.test(h) || h === 'sheet row');
  const nc = head.findIndex(h => /^(d10\s*)?nid$/.test(h) || h === 'd10 node id');
  if (rc < 0 || nc < 0) throw new Error('The override file needs "Excel row" and "D10 nid" columns');
  const map = new Map();
  for (const r of rows.slice(1)) {
    const row = parseInt(r[rc], 10);
    if (!row) continue;
    const v = String(r[nc] || '').trim();
    map.set(row, /^(none|-)?$/i.test(v) ? 'none' : v);
  }
  return map;
}

// built: sitemap.buildMenuTree output. Returns { tree, rows, counts } where tree is in the shape plan.buildPlan
// takes, and rows is the match report (one row per included sheet row).
// opts: { overrides: Map(row -> nid|'none'), unmatchedRows: 'empty-page' | 'skip' }
function matchSiteMap(built, exp, idx, opts) {
  opts = opts || {};
  const overrides = opts.overrides || new Map();
  const byNid = new Map();
  for (const p of exp.pages) byNid.set(p.nid, p);
  for (const m of exp.microsites) byNid.set(m.nid, m);
  const byTitle = new Map();
  const addTitle = s => { const k = normalizeTitle(s.title); if (!k) return; if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(s); };
  exp.pages.filter(p => p.kind === 'page').forEach(addTitle);
  exp.microsites.forEach(addTitle);

  const report = [];
  const counts = { url: 0, title: 0, override: 0, unmatched: 0, ambiguous: 0, notPage: 0, skipped: 0 };

  function match(n) {
    const out = { method: '', source: null, status: 'unmatched', reason: '', candidates: '' };
    if (overrides.has(n.row)) {
      const v = overrides.get(n.row);
      out.method = 'override';
      if (v === 'none') { out.status = 'unmatched'; out.reason = 'Override: no D10 page'; return out; }
      const s = byNid.get(String(v));
      if (!s) { out.reason = 'Override names nid ' + v + ', which is not in the export'; return out; }
      return Object.assign(out, { source: s, status: 'matched' });
    }
    if (n.url) {
      const c = classify(idx, n.url, {});
      if (c.type === 'node' || c.type === 'alias') {
        const s = byNid.get(c.nid);
        out.method = 'url';
        if (s) return Object.assign(out, { source: s, status: 'matched' });
        out.reason = 'URL points at node ' + c.nid + ', which is not in the export';
        return out;
      }
      if (c.type === 'external') out.reason = 'Old URL is on another site (' + n.url + ')';
      else if (c.type === 'media' || c.type === 'file') out.reason = 'Old URL is a file, not a page';
      else out.reason = 'Old URL matches no D10 page (' + n.url + ')';
    }
    const cands = byTitle.get(normalizeTitle(n.title)) || [];
    if (cands.length === 1) return Object.assign(out, { method: 'title', source: cands[0], status: 'matched', reason: out.reason });
    if (cands.length > 1) {
      return Object.assign(out, { method: 'title', status: 'ambiguous', reason: (out.reason ? out.reason + '; ' : '') + cands.length + ' D10 pages have this title', candidates: cands.map(s => s.nid + ' ' + s.alias).join(' | ') });
    }
    out.reason = out.reason || (n.url ? '' : 'No old URL in the sheet and no D10 page with this title');
    return out;
  }

  const convert = (nodes) => {
    const out = [];
    for (const n of nodes) {
      const r = match(n);
      let src = r.source;
      // News and events are not imported as pages: the row still gets a menu item and an empty page.
      if (src && src.sourceType === 'page' && src.kind !== 'page') {
        r.reason = 'Matches a ' + src.kind + ' item, which is not imported; created as an empty page';
        r.status = 'not-a-page'; src = null; counts.notPage++;
      }
      if (r.status === 'matched') counts[r.method]++;
      else if (r.status === 'ambiguous') counts.ambiguous++;
      else if (r.status === 'unmatched') counts.unmatched++;
      const skip = !src && opts.unmatchedRows === 'skip';
      report.push({
        row: n.row, level: n.level, title: n.title, path: n.path, url: n.url || '', method: r.method, status: r.status,
        nid: src ? src.nid : '', d10Title: src ? src.title : '', d10Type: src ? src.sourceType : '',
        action: skip ? 'skipped (and everything under it)' : src ? 'page with D10 content' : 'empty page',
        reason: r.reason, candidates: r.candidates, linkedOnly: n.linkedOnly ? 'yes' : ''
      });
      if (skip) { counts.skipped++; markSkipped(n.children); continue; }
      out.push({
        key: src ? src.sourceType + ':' + src.nid : 'row:' + n.row, menuKey: 'row:' + n.row, row: n.row,
        sourceType: src ? src.sourceType : 'row', source: src, title: n.title, children: convert(n.children)
      });
    }
    return out;
  };
  const markSkipped = nodes => { for (const n of nodes) { report.push({ row: n.row, level: n.level, title: n.title, path: n.path, url: n.url || '', method: '', status: 'parent-skipped', nid: '', d10Title: '', d10Type: '', action: 'skipped', reason: 'A parent row was skipped', candidates: '', linkedOnly: '' }); markSkipped(n.children); } };

  const tree = convert(built.tree);
  report.sort((a, b) => a.row - b.row);
  // The same D10 page in more than one row is allowed (several menu items, one page) but worth knowing.
  const seen = new Map();
  for (const r of report) if (r.nid) { if (seen.has(r.nid)) r.reason = (r.reason ? r.reason + '; ' : '') + 'Same D10 page as row ' + seen.get(r.nid); else seen.set(r.nid, r.row); }
  return { tree, rows: report, counts };
}

const MATCH_COLUMNS = [
  { key: 'row', label: 'Excel row' }, { key: 'level', label: 'Level' }, { key: 'title', label: 'Page' }, { key: 'path', label: 'Parent path' },
  { key: 'url', label: 'Old URL in sheet' }, { key: 'status', label: 'Status' }, { key: 'method', label: 'Matched by' },
  { key: 'nid', label: 'D10 nid' }, { key: 'd10Title', label: 'D10 title' }, { key: 'd10Type', label: 'D10 type' },
  { key: 'action', label: 'Will create' }, { key: 'reason', label: 'Notes' }, { key: 'candidates', label: 'Candidates (nid alias)' },
  { key: 'linkedOnly', label: 'Linked page only' }
];

module.exports = { normalizeTitle, parseCsv, parseOverrides, matchSiteMap, MATCH_COLUMNS };

  },
  "lib/modules": function (module, exports, require) {
'use strict';
// D10 module content (records that are not pages) imported as Streamline pages: one page per entry, built
// from its fields, plus one listing page per module that shows its entries as cards.
// Meetings, events and people (directory listings) are left out on purpose: Streamline is adding modules for them.
// Pure: takes the loaded export, returns entry summaries.

const { fieldItems, firstValue, cleanTitle } = require('./d10');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// D10 stores date-times in UTC ("2018-07-23T15:00:00"); they are shown in the site's time zone,
// e.g. "July 23, 2018 10:00 AM" in America/Chicago. Date-only values ("2023-07-01") are shown as written.
function formatDate(s, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return String(s || '');
  if (!m[4]) return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(d).map(p => [p.type, p.value]));
  return parts.month + ' ' + parts.day + ', ' + parts.year + ' ' + parts.hour + ':' + parts.minute + ' ' + parts.dayPeriod;
}
const isoDate = s => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || '')); return m ? m[1] : ''; };

// A D10 address field as lines of text.
function addressLines(rec, name) {
  const a = fieldItems(rec, name)[0];
  if (!a || typeof a !== 'object') return [];
  const city = [a.locality, a.administrative_area].filter(Boolean).join(', ') + (a.postal_code ? ' ' + a.postal_code : '');
  return [a.organization, a.address_line1, a.address_line2, a.address_line3, city.trim()].map(x => (x || '').trim()).filter(Boolean);
}

const termNames = (rec, name, terms) => fieldItems(rec, name).map(it => it && (it.target_id != null ? terms[String(it.target_id)] : null)).filter(Boolean);
const titleCase = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// One "Label: value" line per detail that has a value.
const detail = (label, value) => (value ? '<p><strong>' + esc(label) + ':</strong> ' + esc(value) + '</p>' : '');
const richDetail = (label, html) => (html && html.trim() ? '<h3>' + esc(label) + '</h3>' + html : '');
const addressHtml = lines => (lines.length ? '<p><strong>Address:</strong><br>' + lines.map(esc).join('<br>') + '</p>' : '');

// Each module: where its records are, what its listing page is called, and how an entry's page is built.
// details(rec, terms, tz) returns HTML placed above the body.
const MODULES = {
  news: {
    label: 'News', file: 'pages', order: 'date_published',
    filter: p => p.kind === 'news',
    details: () => ''
  },
  business_directory: {
    label: 'Business Directory', file: 'business_directory', order: 'alphabetical_by_title',
    details: rec => addressHtml(addressLines(rec, 'field_address'))
  },
  jobs: {
    label: 'Job Openings', file: 'jobs', order: 'alphabetical_by_title',
    details: (rec, terms, tz) => detail('Status', titleCase(firstValue(rec, 'field_job_status'))) + detail('Closing date', firstValue(rec, 'field_job_closing_date') && formatDate(firstValue(rec, 'field_job_closing_date'), tz))
  },
  bids_rfps: {
    label: 'Bids & RFPs', file: 'bids_rfps', order: 'alphabetical_by_title',
    details: (rec, terms, tz) => detail('Status', titleCase(firstValue(rec, 'field_bid_status'))) + detail('Due', firstValue(rec, 'field_date') && formatDate(firstValue(rec, 'field_date'), tz))
  },
  ordinances: {
    label: 'Ordinances & Resolutions', file: 'ordinances', order: 'alphabetical_by_title',
    // field_ordinance_resolution (1/0) is left out: the export does not say which value means which.
    details: (rec, terms) => detail('Number', firstValue(rec, 'field_ordinance_resolution_id')) + detail('Status', termNames(rec, 'field_ordinance_resolution_statu', terms).join(', '))
  },
  parks: {
    label: 'Parks', file: 'parks', order: 'alphabetical_by_title',
    details: (rec, terms) => addressHtml(addressLines(rec, 'field_address')) +
      detail('Amenities', termNames(rec, 'field_amenities', terms).join(', ')) +
      richDetail('Hours', firstValue(rec, 'field_hours') || '') +
      richDetail('Rules and regulations', firstValue(rec, 'field_rules_regulations') || '')
  },
  projects: {
    label: 'Projects', file: 'projects', order: 'alphabetical_by_title',
    details: (rec, terms) => detail('Status', termNames(rec, 'field_project_status', terms).join(', ')) +
      detail('Type', termNames(rec, 'field_project_type', terms).join(', ')) +
      detail('Project ID', firstValue(rec, 'field_project_id') !== firstValue(rec, 'title') ? firstValue(rec, 'field_project_id') : '') +
      detail('Date received', firstValue(rec, 'field_date_received') && formatDate(firstValue(rec, 'field_date_received'))) +
      addressHtml(addressLines(rec, 'field_address'))
  },
  standard_locations: {
    label: 'Locations', file: 'standard_locations', order: 'alphabetical_by_title',
    details: rec => addressHtml(addressLines(rec, 'field_address'))
  }
};
const MODULE_TYPES = Object.keys(MODULES);

// Entries of one module type, in the order its listing page shows them.
// Each: { key, type, nid, title, alias, published, bodyHtml, attachments, publishedAt, notes, micrositeIds }
// opts.timeZone: the site's IANA time zone for date-times (default UTC).
function moduleEntries(exp, type, opts) {
  const tz = (opts && opts.timeZone) || 'UTC';
  const def = MODULES[type];
  if (!def) throw new Error('Unknown module type ' + type);
  let entries;
  if (type === 'news') {
    // News items are page records; their summaries are already loaded.
    const raw = new Map((exp.raw.pages || []).map(r => [String(r.entity_id), r]));
    entries = exp.pages.filter(def.filter).map(p => ({
      key: 'news:' + p.nid, type, nid: p.nid, title: p.title, alias: p.alias, published: p.published,
      bodyHtml: p.bodyHtml, attachments: p.attachments, publishedAt: isoDate(firstValue(raw.get(p.nid), 'field_news_date')),
      micrositeIds: p.micrositeIds, notes: p.notes.filter(n => !/attachments/i.test(n))
    }));
    entries.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.title.localeCompare(b.title));
    return entries;
  }
  entries = (exp.raw[def.file] || []).filter(r => r && r.fields).map(rec => {
    const body = firstValue(rec, 'body');
    const notes = [];
    if (fieldItems(rec, 'field_sections').length) notes.push('Has sections (paragraphs)');
    if (fieldItems(rec, 'field_primary_image_video').length) notes.push('Has primary image/video');
    if (fieldItems(rec, 'field_location').length) notes.push('Has a map location');
    return {
      key: type + ':' + rec.entity_id, type, nid: String(rec.entity_id),
      title: cleanTitle(firstValue(rec, 'title')) || '(untitled ' + rec.entity_id + ')',
      alias: (fieldItems(rec, 'path')[0] || {}).alias || '', published: rec.is_published === true,
      bodyHtml: def.details(rec, exp.terms, tz) + (typeof body === 'string' ? body : ''),
      attachments: fieldItems(rec, 'field_file_attachments').map(it => it && (it.target_id != null ? it.target_id : it.entity_id)).filter(v => v != null).map(String),
      publishedAt: '', micrositeIds: fieldItems(rec, 'og_audience').map(it => it && it.target_id).filter(Boolean).map(String), notes
    };
  });
  entries.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base', numeric: true }));
  return entries;
}

// How many records each module type has, for the options screen.
function moduleCounts(exp) {
  const out = {};
  for (const t of MODULE_TYPES) out[t] = t === 'news' ? exp.pages.filter(p => p.kind === 'news').length : (exp.raw[MODULES[t].file] || []).length;
  return out;
}

module.exports = { MODULES, MODULE_TYPES, moduleEntries, moduleCounts, formatDate, addressLines };

  },
  "lib/navFromD10": function (module, exports, require) {
'use strict';
// Builds the primary menu tree from the D10 export alone (no site-map workbook):
// microsites on top, each microsite's pages under it, alphabetical. The export has no menu order,
// so the order is a placeholder and the report says so.

// Home microsites ("Home Page", "Home Page 2024") are skipped: the site already has a homepage.
const isHomeMicrosite = m => /^home\s*page\b/i.test(m.title) || /^\/home-page/i.test(m.alias);

const byTitle = (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base', numeric: true }) || Number(a.nid) - Number(b.nid);

// Stable keys tie plan, manifest and report together. They never depend on titles.
const micrositeKey = m => 'microsite:' + m.nid;
const pageKey = p => 'page:' + p.nid;

// opts.includeEmptyMicrosites: also create microsites that have no pages of their own.
// Returns { tree, skipped, warnings, count }.
// tree: [{ key, sourceType, source, title, children: [{ key, sourceType, source, title, children: [] }] }]
function buildNavFromD10(exp, opts) {
  opts = opts || {};
  const skipped = [], warnings = [];
  const skip = (src, reason, parent) => skipped.push({
    sourceType: src.sourceType, nid: src.nid, title: src.title, alias: src.alias,
    published: src.published, parent: parent || '', reason
  });

  const bySite = new Map();
  for (const p of exp.pages) {
    if (p.kind !== 'page') { skip(p, p.kind === 'news' ? 'News item (not a menu page; select the News module to import it)' : 'Event (not imported yet)'); continue; }
    if (p.micrositeIds.length !== 1) { skip(p, p.micrositeIds.length ? 'Belongs to more than one microsite' : 'No microsite'); continue; }
    const id = p.micrositeIds[0];
    if (!bySite.has(id)) bySite.set(id, []);
    bySite.get(id).push(p);
  }

  const known = new Set(exp.microsites.map(m => m.nid));
  for (const [id, list] of bySite) {
    if (!known.has(id)) for (const p of list) skip(p, 'Microsite ' + id + ' is not in www-microsites.json');
  }

  const tree = [];
  let count = 0;
  for (const m of exp.microsites.slice().sort(byTitle)) {
    const pages = (bySite.get(m.nid) || []).slice().sort(byTitle);
    if (isHomeMicrosite(m)) {
      skip(m, 'Home microsite (the site already has a homepage)');
      for (const p of pages) skip(p, 'Parent microsite skipped: "' + m.title + '"', m.title);
      continue;
    }
    if (!pages.length && !opts.includeEmptyMicrosites) { skip(m, 'Microsite has no pages'); continue; }
    if (!m.title) { warnings.push('Microsite ' + m.nid + ' has no title'); }
    const seen = new Map();
    const children = pages.map(p => {
      const t = p.title.toLowerCase();
      if (seen.has(t)) warnings.push('Two pages titled "' + p.title + '" under ' + m.title + ' (nids ' + seen.get(t) + ', ' + p.nid + ')');
      else seen.set(t, p.nid);
      if (!p.title) warnings.push('Page ' + p.nid + ' has no title');
      return { key: pageKey(p), sourceType: 'page', source: p, title: p.title || '(untitled ' + p.nid + ')', children: [] };
    });
    tree.push({ key: micrositeKey(m), sourceType: 'microsite', source: m, title: m.title || '(untitled ' + m.nid + ')', children });
    count += 1 + children.length;
  }
  return { tree, skipped, warnings, count };
}

// Keeps only the first `limit` pages (in tree order), with the microsites they sit under.
// Used for small test runs.
function limitTree(tree, limit) {
  if (!limit || limit < 1) return tree;
  const out = [];
  let left = limit;
  for (const top of tree) {
    if (left <= 0) break;
    if (!top.children.length) { out.push(top); left--; continue; }
    const kids = top.children.slice(0, left);
    left -= kids.length;
    out.push(Object.assign({}, top, { children: kids }));
  }
  return out;
}

module.exports = { buildNavFromD10, limitTree, isHomeMicrosite, micrositeKey, pageKey };

  },
  "lib/plan": function (module, exports, require) {
'use strict';
// Turns a menu tree (plus the module types chosen) into the exact list of things a run will create,
// and the dry-run report. Pure: the same input always gives the same plan, so resume can match work
// to the manifest by key.

const { referencedMedia } = require('./links');
const { MODULES, moduleEntries } = require('./modules');

const DEFAULT_OPTIONS = Object.freeze({
  menuSource: 'd10',            // 'd10' | 'workbook'
  pageContent: 'empty',         // 'empty' | 'content' (D10 body converted to freeform content)
  unpublishedSourceAs: 'unpublished', // how to import pages that are unpublished in D10: 'unpublished' | 'published'
  newsEvents: 'skip',           // news and events never become menu pages (news can be imported as a module)
  includeEmptyMicrosites: false,
  includeAttachments: true,     // content mode: list a page's file attachments under a "Documents" heading
  faqAccordions: true,          // content mode: a page's D10 FAQ sections become one accordion per question in the main column
  uploadMedia: true,            // upload the files and images pages link to, and point links at them
  pageUrlPattern: 'auto',       // page addresses for links between pages: 'auto' = each page's url from the CMS, or a pattern like /{slug}
  unmatchedRows: 'empty-page',  // workbook mode: rows with no D10 match become 'empty-page' | 'skip'
  embeddedPageCards: true,      // D10 "embedded pages" sections become link cards in the page's right column
  modules: [],                  // module types to import as pages (see lib/modules.js), e.g. ['news', 'jobs']
  moduleMenu: true,             // add each module's listing page to the primary menu
  timeZone: '',                 // the site's time zone for module date-times (D10 stores them in UTC)
  limit: 0                      // 0 = all pages; otherwise a small test run
});

// Options that must stay the same for the whole of a run (resume rebuilds the same plan).
const RUN_LOCKED = ['menuSource', 'pageContent', 'unpublishedSourceAs', 'includeAttachments', 'uploadMedia', 'unmatchedRows', 'faqAccordions',
  'embeddedPageCards', 'modules', 'moduleMenu', 'timeZone'];
const sameOption = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function normalizeOptions(o) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, o || {});
  if (!['d10', 'workbook'].includes(opts.menuSource)) throw new Error('Unknown menu source "' + opts.menuSource + '"');
  if (!['empty', 'content'].includes(opts.pageContent)) throw new Error('Unknown page content "' + opts.pageContent + '"');
  if (!['unpublished', 'published'].includes(opts.unpublishedSourceAs)) throw new Error('Bad unpublishedSourceAs: ' + opts.unpublishedSourceAs);
  if (opts.newsEvents !== 'skip') throw new Error('News and events can only be skipped for now');
  if (opts.pageUrlPattern !== 'auto' && !/\{slug\}/.test(opts.pageUrlPattern)) throw new Error('Page URL pattern must contain {slug}, e.g. /{slug}');
  opts.limit = Math.max(0, parseInt(opts.limit, 10) || 0);
  for (const k of ['includeEmptyMicrosites', 'includeAttachments', 'uploadMedia', 'faqAccordions', 'embeddedPageCards', 'moduleMenu']) opts[k] = !!opts[k];
  opts.modules = [...new Set(opts.modules || [])];
  for (const t of opts.modules) if (!MODULES[t]) throw new Error('Unknown module type "' + t + '"');
  opts.modules.sort((a, b) => Object.keys(MODULES).indexOf(a) - Object.keys(MODULES).indexOf(b));
  if (opts.pageContent === 'empty') opts.faqAccordions = false;
  // Module entries always get their content, so uploads stay possible in empty mode when modules are chosen.
  if (opts.pageContent === 'empty' && !opts.modules.length) opts.uploadMedia = false;
  return opts;
}

// tree: [{ key, sourceType, source, title, children }] from navFromD10 or the workbook matcher.
// source is the D10 page/microsite summary, or null for a workbook row with no D10 match (an empty page).
// idx: links.buildLinkIndex(exp), needed for media, FAQs and cards. exp: the loaded export, needed for modules.
// Returns { options, pages, menu, media, cardIssues }.
//   pages: one per distinct page key, parents first. Two menu items may point at the same page.
//          page.cards: [{ column: 'main'|'gutter', title, keys, orderBy, perPage }] = Teaser sections of link cards.
//   menu:  one per menu item; parentKey is another menu item's key, weight = sibling order.
//   media: media ids to upload.
//   cardIssues: embedded-pages links that cannot become cards, with the reason.
function buildPlan(tree, options, idx, exp) {
  const opts = normalizeOptions(options);
  const pages = [], menu = [], seen = new Set(), media = [], cardIssues = [];
  const addMedia = page => {
    if (!opts.uploadMedia || !idx || page.content !== 'content') return;
    const html = page.bodyHtml + page.faqs.map(q => q.answerHtml).join('');
    for (const mid of referencedMedia(idx, html, page.attachments)) if (!media.includes(mid)) media.push(mid);
  };

  const walk = (nodes, parentMenuKey, path) => {
    nodes.forEach((n, i) => {
      const src = n.source;
      if (!seen.has(n.key)) {
        seen.add(n.key);
        const published = src ? src.published : true;
        const withContent = opts.pageContent === 'content' && !!src;
        const page = {
          key: n.key, title: n.title, sourceType: n.sourceType, nid: src ? src.nid : '', alias: src ? src.alias : '',
          sourcePublished: published, unpublished: !published && opts.unpublishedSourceAs === 'unpublished',
          content: withContent ? 'content' : 'empty', hasBody: !!(src && src.hasBody), notes: (src && src.notes) || [],
          bodyHtml: withContent ? src.bodyHtml : '', attachments: withContent && opts.includeAttachments ? (src.attachments || []) : [],
          faqs: withContent && opts.faqAccordions ? faqsFor(src, idx) : [],
          cards: [], embedded: (opts.embeddedPageCards && src && src.embeddedPages) || [],
          row: n.row || null
        };
        pages.push(page);
        addMedia(page);
      }
      const menuKey = 'menu:' + (n.menuKey || n.key);
      menu.push({ key: menuKey, pageKey: n.key, parentKey: parentMenuKey, weight: i, title: n.title, level: path.length + 1, path: path.join(' > '), row: n.row || null });
      if (n.children && n.children.length) walk(n.children, menuKey, path.concat(n.title));
    });
  };
  walk(tree, null, []);

  // Modules: a listing page per type (cards for every entry) and a page per entry.
  let topWeight = tree.length;
  for (const type of opts.modules) {
    if (!exp) throw new Error('Module import needs the export');
    const def = MODULES[type];
    const all = moduleEntries(exp, type, { timeZone: opts.timeZone || 'UTC' });
    const entries = opts.limit ? all.slice(0, opts.limit) : all; // a test run takes the first few of each module
    const listKey = 'list:' + type;
    pages.push({
      key: listKey, title: def.label, sourceType: 'listing', nid: '', alias: '', sourcePublished: true, unpublished: false,
      content: 'empty', hasBody: false, notes: [], bodyHtml: '', attachments: [], faqs: [], embedded: [], row: null, moduleType: type,
      // Always manual: with any other order the CMS does not show the cards added to the section (sandbox,
      // 2026-10-29). The entries are already in the module's order (A-Z, news newest first).
      cards: entries.length ? [{ column: 'main', title: '', keys: entries.map(e => e.key), orderBy: 'manual', perPage: 12 }] : []
    });
    if (opts.moduleMenu) menu.push({ key: 'menu:' + listKey, pageKey: listKey, parentKey: null, weight: topWeight++, title: def.label, level: 1, path: '', row: null });
    for (const e of entries) {
      const page = {
        key: e.key, title: e.title, sourceType: type, nid: e.nid, alias: e.alias, sourcePublished: e.published,
        unpublished: !e.published && opts.unpublishedSourceAs === 'unpublished', content: 'content', hasBody: !!e.bodyHtml.trim(),
        notes: e.notes, bodyHtml: e.bodyHtml, attachments: opts.includeAttachments ? e.attachments : [], faqs: [], cards: [], embedded: [],
        row: null, moduleType: type, listKey, publishedAt: e.publishedAt
      };
      pages.push(page);
      addMedia(page);
    }
  }

  // Right-column cards from D10 "embedded pages" sections, now that every page key is known.
  const keys = new Set(pages.map(p => p.key));
  const keyOf = nid => { const n = idx && idx.nodes.get(nid); return !n ? null : (n.kind === 'news' ? 'news:' : n.sourceType + ':') + nid; };
  for (const p of pages) {
    for (const sec of p.embedded) {
      const found = [];
      for (const nid of sec.nids) {
        const k = keyOf(nid);
        if (k && keys.has(k)) { if (!found.includes(k)) found.push(k); continue; }
        const n = idx && idx.nodes.get(nid);
        cardIssues.push({ page: p.title, nid: p.nid, section: sec.header, target: nid, targetTitle: n ? n.title : '',
          reason: !n ? 'not in the export' : n.kind === 'news' || MODULES[n.kind] ? n.kind + ' item; select that module to import it' : 'that page is not imported' });
      }
      if (!sec.nids.length) cardIssues.push({ page: p.title, nid: p.nid, section: sec.header, target: '', targetTitle: '', reason: 'section lists no pages' });
      if (found.length) p.cards.push({ column: 'gutter', title: sec.header, keys: found, orderBy: 'manual', perPage: Math.max(found.length, 3) });
    }
    delete p.embedded;
  }
  return { options: opts, pages, menu, media, cardIssues };
}

// The published FAQs a page's D10 FAQ sections show, section by section, each in D10 order.
function faqsFor(src, idx) {
  const out = [];
  for (const sec of src.faqSections || []) {
    const list = (idx && idx.faqCategories.get(sec.categoryId)) || [];
    for (const f of list) if (f.published) out.push({ nid: f.nid, question: f.question, answerHtml: f.answerHtml, categoryId: sec.categoryId });
  }
  return out;
}

function bodyLabel(p) {
  if (p.sourceType === 'listing') return 'cards for ' + (p.cards[0] ? p.cards[0].keys.length : 0) + ' entries';
  if (p.content === 'content') return p.hasBody || p.attachments.length || p.faqs.length ? 'converted' : 'empty (no D10 body)';
  if (!p.nid) return 'empty (no D10 match)';
  return p.hasBody ? 'empty (D10 body not imported)' : 'empty';
}

// One row per planned page, menu items first (in menu order), then pages with no menu item (module entries).
// contentByKey (optional): page key -> { warnings, links } from the dry-run conversion.
function planReportRows(plan, contentByKey) {
  const pageByKey = new Map(plan.pages.map(p => [p.key, p]));
  const row = (p, m) => {
    const c = contentByKey && contentByKey.get(p.key);
    const count = o => c ? c.links.filter(l => l.outcome === o).length : '';
    const list = p.listKey ? pageByKey.get(p.listKey) : null;
    return {
      level: m ? m.level : '', menuPath: m ? m.path : (list ? 'listed on ' + list.title : ''), title: p.title, order: m ? m.weight + 1 : '', row: m && m.row ? m.row : '',
      sourceType: p.sourceType, nid: p.nid, oldUrl: p.alias,
      d10Published: p.nid ? (p.sourcePublished ? 'yes' : 'no') : '', importAs: p.unpublished ? 'unpublished' : 'published',
      body: bodyLabel(p), attachments: p.attachments.length || '', faqs: p.faqs.length || '',
      cards: p.cards.filter(x => x.column === 'gutter').reduce((s, x) => s + x.keys.length, 0) || '',
      linksToPages: count('page'), linksToMedia: count('media'), linksToOldSite: count('old-site'),
      dropped: c ? c.warnings.map(w => w.code).join(' ') : '',
      notes: p.notes.filter(n => p.content !== 'content' || !/attachments/i.test(n) || !p.attachments.length).join('; ')
    };
  };
  const inMenu = new Set(plan.menu.map(m => m.pageKey));
  return plan.menu.map(m => row(pageByKey.get(m.pageKey), m)).concat(plan.pages.filter(p => !inMenu.has(p.key)).map(p => row(p, null)));
}

// Plain-text outline of the tree for the preview pane.
function outline(plan, max) {
  const lines = plan.menu.map(m => '  '.repeat(m.level - 1) + (m.level === 1 ? '■ ' : '– ') + m.title);
  if (max && lines.length > max) return lines.slice(0, max).concat('… and ' + (lines.length - max) + ' more').join('\n');
  return lines.join('\n');
}

module.exports = { DEFAULT_OPTIONS, RUN_LOCKED, sameOption, normalizeOptions, buildPlan, planReportRows, outline };

  },
  "lib/reports": function (module, exports, require) {
'use strict';
// Reports on what the export holds and where it goes. Pure.

const { fieldItems, firstValue, cleanTitle } = require('./d10');

// One row per FAQ group (microsite + category): the D10 pages whose FAQ sections show it (they get accordions
// in content mode), the microsite it belongs to, and its questions in weight order.
function faqReport(exp) {
  const faqs = exp.raw.faqs || [];
  const ms = new Map(exp.microsites.map(m => [m.nid, m]));
  const shownOn = new Map();
  for (const p of exp.pages.concat(exp.microsites)) for (const sec of p.faqSections || []) {
    if (!shownOn.has(sec.categoryId)) shownOn.set(sec.categoryId, []);
    shownOn.get(sec.categoryId).push(p.title + ' (nid ' + p.nid + (p.kind && p.kind !== 'page' ? ', ' + p.kind + ', not imported' : '') + ')');
  }
  const groups = new Map();
  for (const f of faqs) {
    if (!f || !f.fields) continue;
    const msId = String(firstValue(f, 'og_audience') || '');
    const catId = String(firstValue(f, 'field_faq_category') || '');
    const key = msId + '|' + catId;
    if (!groups.has(key)) groups.set(key, { msId, catId, items: [] });
    groups.get(key).items.push({
      title: cleanTitle(firstValue(f, 'title')), weight: Number(firstValue(f, 'field_faq_weight')) || 0,
      alias: (fieldItems(f, 'path')[0] || {}).alias || '', published: f.is_published === true, nid: String(f.entity_id)
    });
  }
  return [...groups.values()].map(g => {
    const m = ms.get(g.msId);
    g.items.sort((a, b) => a.weight - b.weight || a.title.localeCompare(b.title));
    return {
      microsite: m ? m.title : (g.msId ? 'microsite ' + g.msId + ' (not in export)' : '(none)'), micrositeNid: g.msId,
      wouldGoOn: m ? m.title + ' (' + m.alias + ')' : '', category: exp.terms[g.catId] || (g.catId ? 'term ' + g.catId : '(none)'),
      onPages: (shownOn.get(g.catId) || []).join(' | ') || 'none (not shown on any page)',
      count: g.items.length, published: g.items.filter(i => i.published).length,
      questions: g.items.map(i => i.title).join(' | '), nids: g.items.map(i => i.nid).join(' '), oldUrls: g.items.map(i => i.alias).join(' ')
    };
  }).sort((a, b) => a.microsite.localeCompare(b.microsite) || a.category.localeCompare(b.category));
}

const FAQ_COLUMNS = [
  { key: 'microsite', label: 'Microsite' }, { key: 'micrositeNid', label: 'Microsite nid' }, { key: 'wouldGoOn', label: 'Would go on' },
  { key: 'category', label: 'FAQ category' }, { key: 'onPages', label: 'Shown on D10 pages (become accordions)' }, { key: 'count', label: 'FAQs' }, { key: 'published', label: 'Published' },
  { key: 'questions', label: 'Questions (in weight order)' }, { key: 'nids', label: 'FAQ nids' }, { key: 'oldUrls', label: 'Old URLs' }
];

// What is in the export but not imported, with counts, so nothing is lost silently.
function outOfScopeReport(exp) {
  const rows = [];
  const count = (type, recs, note) => {
    if (!recs) return;
    rows.push({ type, records: recs.length, published: recs.filter(r => r && r.is_published === true).length, note });
  };
  const r = exp.raw;
  count('FAQs', r.faqs, 'Imported as accordions on the pages whose FAQ sections show them (content mode). FAQs no page shows are not imported; see the FAQ report.');
  count('Meetings', r.meetings, 'Not imported yet (waiting for a Streamline meetings update).');
  count('Directory listings', r.directory_listings, 'People: not imported yet (waiting for a Streamline update).');
  count('Business directory', r.business_directory, 'Imported as pages when Business Directory is selected under Module content.');
  count('Parks', r.parks, 'Imported as pages when Parks is selected under Module content.');
  count('Bids and RFPs', r.bids_rfps, 'Imported as pages when Bids & RFPs is selected under Module content.');
  count('Jobs', r.jobs, 'Imported as pages when Job Openings is selected under Module content.');
  count('Ordinances', r.ordinances, 'Imported as pages when Ordinances & Resolutions is selected under Module content.');
  count('Projects', r.projects, 'Imported as pages when Projects is selected under Module content.');
  count('Property listings', r.property_listings, 'Not imported (no module yet; none in the sample exports).');
  count('Locations', r.standard_locations, 'Imported as pages when Locations is selected under Module content.');
  count('Paragraphs', r.paragraphs, 'Section content used by pages and microsites (field_sections). Not imported.');
  const news = exp.pages.filter(p => p.kind === 'news'), events = exp.pages.filter(p => p.kind === 'event');
  rows.push({ type: 'News items', records: news.length, published: news.filter(p => p.published).length, note: 'Imported as dated pages when News is selected under Module content; never menu pages.' });
  rows.push({ type: 'Events', records: events.length, published: events.filter(p => p.published).length, note: 'Not imported yet (waiting for a Streamline events update).' });
  const regular = exp.pages.filter(p => p.kind === 'page');
  const has = re => regular.filter(p => p.notes.some(n => re.test(n)));
  const pr = (type, list, note) => rows.push({ type, records: list.length, published: list.filter(p => p.published).length, note });
  pr('Pages with sections', has(/sections/i), 'Their field_sections (paragraph) content is not imported; only the body is.');
  pr('Pages that redirect', has(/^Redirect/), 'Imported as ordinary pages. Streamline has redirect pages (redirect/redirectUrl) for a later version.');
  pr('Pages with a primary image or video', has(/primary image/i), 'The primary image is not imported.');
  const layout = (r.microsites || []).filter(m => m && m.fields && Array.isArray(m.fields.layout_builder__layout) && m.fields.layout_builder__layout.length);
  rows.push({ type: 'Microsites with Layout Builder content', records: layout.length, published: layout.filter(m => m.is_published).length, note: 'Layout Builder content is not imported; only the microsite body is.' });
  const msSections = exp.microsites.filter(m => m.notes.length);
  rows.push({ type: 'Microsites with sections', records: msSections.length, published: msSections.filter(m => m.published).length, note: 'Their field_sections content is not imported.' });
  const videos = (exp.media || []).filter(m => m.kind === 'video');
  rows.push({ type: 'Video media', records: videos.length, published: videos.filter(m => m.published).length, note: 'Links to videos are kept as external links; videos are not uploaded.' });
  return rows;
}

const OUT_OF_SCOPE_COLUMNS = [
  { key: 'type', label: 'Content' }, { key: 'records', label: 'Records' }, { key: 'published', label: 'Published' }, { key: 'note', label: 'What happens' }
];

module.exports = { faqReport, FAQ_COLUMNS, outOfScopeReport, OUT_OF_SCOPE_COLUMNS };

  },
  "lib/schema": function (module, exports, require) {
'use strict';
// GraphQL schema introspection: the query, a printer to SDL text, and a check of the calls the importer relies on.
// Pure: the caller runs the query (userscript button or tools/introspect.js) and saves the output.

const INTROSPECTION = `query {
  __schema {
    queryType { name } mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: true) { name description isDeprecated args { name type { ...T } defaultValue } type { ...T } }
      inputFields { name type { ...T } defaultValue }
      enumValues(includeDeprecated: true) { name isDeprecated }
      interfaces { name } possibleTypes { name }
    }
  }
}
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

const typeRef = t => t.kind === 'NON_NULL' ? typeRef(t.ofType) + '!' : t.kind === 'LIST' ? '[' + typeRef(t.ofType) + ']' : t.name;
const baseName = t => typeRef(t).replace(/[!\[\]]/g, '');

function toSdl(schema) {
  const out = [];
  const desc = (d, ind) => d ? ind + '"""' + d.replace(/"""/g, '\\"""') + '"""\n' : '';
  for (const t of schema.types.filter(t => !t.name.startsWith('__')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (t.kind === 'SCALAR') { out.push(desc(t.description, '') + 'scalar ' + t.name); continue; }
    if (t.kind === 'ENUM') { out.push(desc(t.description, '') + 'enum ' + t.name + ' {\n' + t.enumValues.map(v => '  ' + v.name + (v.isDeprecated ? ' @deprecated' : '')).join('\n') + '\n}'); continue; }
    if (t.kind === 'UNION') { out.push('union ' + t.name + ' = ' + t.possibleTypes.map(p => p.name).join(' | ')); continue; }
    const kw = t.kind === 'INPUT_OBJECT' ? 'input' : t.kind === 'INTERFACE' ? 'interface' : 'type';
    const impl = t.interfaces && t.interfaces.length ? ' implements ' + t.interfaces.map(i => i.name).join(' & ') : '';
    const fields = (t.fields || t.inputFields || []).map(f => {
      const args = f.args && f.args.length ? '(' + f.args.map(a => a.name + ': ' + typeRef(a.type) + (a.defaultValue != null ? ' = ' + a.defaultValue : '')).join(', ') + ')' : '';
      return desc(f.description, '  ') + '  ' + f.name + args + ': ' + typeRef(f.type) + (f.defaultValue != null ? ' = ' + f.defaultValue : '') + (f.isDeprecated ? ' @deprecated' : '');
    });
    out.push(desc(t.description, '') + kw + ' ' + t.name + impl + ' {\n' + fields.join('\n') + '\n}');
  }
  return out.join('\n\n') + '\n';
}

// Plain-text report of what the importer needs from the schema.
function checkSchema(schema) {
  const T = n => schema.types.find(t => t.name === n);
  const field = (type, name) => ((T(type) || {}).fields || []).find(f => f.name === name);
  const q = n => field(schema.queryType.name, n);
  const mu = n => field(schema.mutationType && schema.mutationType.name, n);
  const lines = [];
  const show = (label, ok, extra) => lines.push((ok ? 'ok       ' : 'MISSING  ') + label + (extra ? '  ' + extra : ''));
  const sig = f => '(' + f.args.map(a => a.name + ': ' + typeRef(a.type)).join(', ') + ') -> ' + typeRef(f.type);

  lines.push('Calls the importer uses:');
  for (const n of ['amplifyUpsertPage', 'amplifyUpsertSectionInstance', 'amplifyUpsertFreeformContent', 'amplifyPromoteDraft', 'createFileUpload', 'createFile', 'createImage']) {
    const f = mu(n); show('mutation ' + n, !!f, f ? sig(f) : '');
  }
  for (const n of ['amplifyPages', 'amplifyDraft', 'images', 'files']) {
    const f = q(n); show('query ' + n, !!f, f ? sig(f) : '');
  }
  const pages = q('amplifyPages');
  if (pages) {
    const conn = baseName(pages.type);
    show(conn + '.pageInfo (paging)', !!field(conn, 'pageInfo'));
    show('amplifyPages(after:) argument', pages.args.some(a => a.name === 'after'));
  }

  const pageInput = (T('AmplifyUpsertPageMutationInput') || {}).inputFields || [];
  const inner = pageInput.find(f => f.name === 'amplifyPage');
  if (inner) {
    const it = T(baseName(inner.type));
    lines.push('', baseName(inner.type) + ' input fields (slug, parent, hidden marker candidates):');
    for (const f of (it && it.inputFields) || []) lines.push('  ' + f.name + ': ' + typeRef(f.type));
  }
  const upsert = mu('amplifyUpsertPage');
  if (upsert) {
    const payload = T(baseName(upsert.type));
    const pf = payload && (payload.fields || []).find(f => f.name === 'page');
    const pt = pf && T(baseName(pf.type));
    if (pt) {
      lines.push('', pt.name + ' fields (what a created page returns):');
      for (const f of pt.fields || []) lines.push('  ' + f.name + ': ' + typeRef(f.type));
    }
  }
  const named = (type, re) => ((T(type) || {}).fields || []).filter(f => re.test(f.name)).map(f => f.name + sig(f).replace(/^\(\)/, ''));
  lines.push('', 'Layout queries:', ...named(schema.queryType.name, /layout/i).map(s => '  ' + s));
  lines.push('', 'Image mutations (alt text):', ...named(schema.mutationType.name, /image/i).map(s => '  ' + s));
  lines.push('', 'Menu-related queries and mutations:', ...named(schema.queryType.name, /menu/i).concat(named(schema.mutationType.name, /menu/i)).map(s => '  ' + s));
  return lines.join('\n') + '\n';
}

module.exports = { INTROSPECTION, typeRef, toSdl, checkSchema };

  },
  "lib/sitemap": function (module, exports, require) {
'use strict';
// Site-map workbook parser. The rules are user6's (Streamline Demo Tool 0.5.0) and the user guide's, unchanged:
//   - a row's level is the tier column its name sits in; menu order is row order
//   - a 1 or x in Complete, Incomplete or Linked creates the page, even if another of them holds a 0
//   - only 0s, or no marks at all, skips it
//   - "Home" in the Global column is always skipped
//   - a skipped page takes its whole branch with it
// What changed: columns are found by their header text ("Global", "2nd"…, "Complete Pages", "Incomplete Pages",
// "Linked Pages", "Existing Website URLs"), so sheets where the tiers start in E instead of C still work.
// With no mark headers, user6's fixed layout is used (tiers C-J, marks K-M).
// Input is an array of rows (SheetJS sheet_to_json with header: 1). Pure.

const cell = (row, c) => (row && c != null && row[c] != null ? row[c] : '');
const norm = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
// A mark means create: a 1 (or an x). Blank and 0 never create on their own.
const isMark = v => { const t = String(v).trim().toLowerCase(); return t === 'x' || (t !== '' && Number(t) === 1); };
const lastIndexWhere = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i; return -1; };
const colLetter = c => { let s = ''; c++; while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; };

function findHeaderRow(aoa) {
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i] || [];
    for (let c = 0; c < row.length; c++) if (norm(row[c]) === 'global') return { row: i, col: c };
  }
  return null;
}

// Works out which column holds what. Returns { header, tiers: [c...], complete, incomplete, linked, url, layout, notes }.
function findColumns(aoa) {
  const h = findHeaderRow(aoa);
  if (!h) return null;
  const hdr = aoa[h.row] || [];
  const find = re => { for (let c = 0; c < hdr.length; c++) if (re.test(norm(hdr[c]))) return c; return null; };
  const tiers = [h.col];
  const ORD = ['2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
  for (let k = 0; k < ORD.length; k++) {
    const c = h.col + 1 + k;
    if (norm(cell(hdr, c)) === ORD[k] || norm(cell(hdr, c)) === ORD[k].replace(/\D/g, '')) tiers.push(c); else break;
  }
  const notes = [];
  let complete = find(/^complete\s*pages?$/), incomplete = find(/^incomplete\s*pages?$/), linked = find(/^linked\s*pages?$/);
  let layout = 'headers';
  if (complete == null && incomplete == null && linked == null) {
    // user6's fixed layout: tiers C-J, marks K, L, M.
    layout = 'fixed';
    complete = 10; incomplete = 11; linked = 12;
    tiers.length = 0;
    for (let c = 2; c <= 9; c++) tiers.push(c);
    notes.push('No "Complete Pages" header found; using the fixed layout (tiers C-J, marks K-M).');
  } else if (tiers.length < 8) {
    // Tiers without headers: assume they run up to the first mark column, as on the sheets seen so far.
    const firstMark = Math.min(...[complete, incomplete, linked].filter(c => c != null));
    for (let c = tiers[tiers.length - 1] + 1; c < firstMark && tiers.length < 8; c++) tiers.push(c);
  }
  // The old-site URL column can be labelled in the header row or in a row above it.
  let url = null;
  for (let r = 0; r <= h.row && url == null; r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < row.length; c++) if (/^existing\s*(web\s*)?(site\s*)?urls?$/.test(norm(row[c]))) { url = c; break; }
  }
  if (url == null) notes.push('No "Existing Website URLs" column found; rows will be matched by title only.');
  return { header: h.row, tiers, complete, incomplete, linked, url, layout, notes };
}

// One entry per named row, with its level and whether its own marks say to create it.
function parseMenuRows(aoa, cols) {
  const entries = [];
  for (let i = cols.header + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    let level = 0, title = '';
    for (let t = 0; t < cols.tiers.length; t++) {
      const v = String(cell(row, cols.tiers[t])).replace(/\s+/g, ' ').trim();
      if (v) { level = t + 1; title = v; break; }
    }
    if (!level) continue;
    const k = String(cell(row, cols.complete)).trim(), l = String(cell(row, cols.incomplete)).trim(), m = String(cell(row, cols.linked)).trim();
    let include = isMark(k) || isMark(l) || isMark(m); // a 1 in any of them wins over a 0 in another
    let reason = '';
    if (!include) reason = (k === '0' || l === '0' || m === '0')
      ? 'Marked 0 (Complete = ' + (k || 'blank') + ', Incomplete = ' + (l || 'blank') + ', Linked = ' + (m || 'blank') + ')'
      : 'No 1 or x in the Complete, Incomplete or Linked columns';
    if (level === 1 && title.toLowerCase() === 'home') { include = false; reason = 'Home (the site already has a homepage)'; }
    const url = cols.url != null ? String(cell(row, cols.url)).trim() : '';
    entries.push({ row: i + 1, level, title, include, reason, k, l, m, url, linkedOnly: isMark(m) && !isMark(k) && !isMark(l) });
  }
  return entries;
}

// Nested tree of included rows. A skipped page takes its whole subtree with it.
function buildMenuTree(entries) {
  const tree = [], stack = [], skipped = [];
  let count = 0, maxDepth = 0;
  for (const e of entries) {
    while (stack.length && stack[stack.length - 1].level >= e.level) stack.pop();
    const path = stack.map(s => s.title).join(' > ');
    const iSkip = lastIndexWhere(stack, s => !s.node);
    if (!e.include || iSkip >= 0) {
      const byParent = e.include && iSkip >= 0; // marked for creation, but an ancestor was skipped
      const anc = byParent ? stack[stack.findIndex(s => !s.node)] : null; // topmost skipped ancestor
      skipped.push({
        row: e.row, level: e.level, title: e.title, path, k: e.k, l: e.l, m: e.m,
        kind: byParent ? 'parent' : 'rule',
        reason: byParent ? 'Parent page skipped: "' + anc.title + '" (row ' + anc.row + ')' : e.reason
      });
      stack.push({ level: e.level, node: null, title: e.title, row: e.row });
      continue;
    }
    const node = { title: e.title, row: e.row, level: stack.length + 1, url: e.url, linkedOnly: e.linkedOnly, path, children: [] };
    const parent = stack.length ? stack[stack.length - 1] : null; // every ancestor is created at this point
    if (parent) parent.node.children.push(node); else tree.push(node);
    count++;
    maxDepth = Math.max(maxDepth, stack.length + 1);
    stack.push({ level: e.level, node, title: e.title, row: e.row });
  }
  return { tree, count, maxDepth, skipped };
}

// Picks the sheet: "Site Navigation" first, then any sheet with a Global header. sheets: [{ name, aoa }].
function readSiteMap(sheets) {
  const ordered = sheets.slice().sort((a, b) => (/site\s*navigation/i.test(b.name) ? 1 : 0) - (/site\s*navigation/i.test(a.name) ? 1 : 0));
  for (const s of ordered) {
    const cols = findColumns(s.aoa);
    if (!cols) continue;
    const entries = parseMenuRows(s.aoa, cols);
    const built = buildMenuTree(entries);
    if (!built.count) throw new Error('Found the structure on sheet "' + s.name + '", but no rows have a 1 or x in the Complete, Incomplete or Linked columns.');
    const describe = 'tiers ' + colLetter(cols.tiers[0]) + '-' + colLetter(cols.tiers[cols.tiers.length - 1]) +
      ', marks ' + [cols.complete, cols.incomplete, cols.linked].map(colLetter).join('/') + (cols.url != null ? ', old URLs ' + colLetter(cols.url) : '');
    return { sheetName: s.name, cols, columnsLabel: describe, entries, built };
  }
  throw new Error('Could not find the menu structure. Expected a "Global" header with the tiers to its right.');
}

module.exports = { isMark, findHeaderRow, findColumns, parseMenuRows, buildMenuTree, readSiteMap, colLetter };

  },
  "lib/sites": function (module, exports, require) {
'use strict';
// The list of sites the importer is turned on for. The userscript matches every https page, but does
// nothing at all on a site that is not in this list. Pure helpers; storage is the caller's (GM_getValue).

// "https://Foo.org/admin, bar.specialdistrict.org ; baz.gov" -> ['foo.org', 'bar.specialdistrict.org', 'baz.gov']
function parseSiteList(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const s = raw.trim();
    if (!s) continue;
    let host = s;
    try { if (/^[a-z]+:\/\//i.test(s)) host = new URL(s).host; } catch (e) { continue; }
    host = host.replace(/\/.*$/, '').toLowerCase();
    if (/^[a-z0-9.-]+(:\d+)?$/.test(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

const isEnabled = (list, host) => (list || []).includes(String(host || '').toLowerCase());

function withSite(list, host) { const h = String(host).toLowerCase(); return (list || []).includes(h) ? list.slice() : (list || []).concat(h); }
function withoutSite(list, host) { const h = String(host).toLowerCase(); return (list || []).filter(x => x !== h); }

module.exports = { parseSiteList, isEnabled, withSite, withoutSite };

  },
  "main": function (module, exports, require) {
'use strict';
// Userscript entry. The script is matched on every https page but only runs on the sites it is turned on for
// (Tampermonkey menu: Turn on D10 Importer for this site / Choose D10 Importer sites…). Everywhere else it does nothing.

const { openPanel, setPlatform } = require('./ui/panel');
const { SANDBOX_HOST } = require('./api/client');
const { parseSiteList, isEnabled, withSite, withoutSite } = require('./lib/sites');
const { makeDockItem } = require('./ui/dock');

/* global GM_xmlhttpRequest, GM_getResourceText */
// Old-site files are on another domain, so they are fetched with GM_xmlhttpRequest (@connect in the header).
function download(url) {
  if (typeof GM_xmlhttpRequest !== 'function') return Promise.reject(new Error('GM_xmlhttpRequest is not available (check the script\'s @grant)'));
  return new Promise((resolve, reject) => {
    const attempt = n => GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'blob', timeout: 120000,
      onload: r => {
        if (r.status >= 200 && r.status < 300 && r.response) return resolve(r.response);
        if ((r.status === 429 || r.status >= 500) && n < 3) return setTimeout(() => attempt(n + 1), 2000 * (n + 1));
        reject(new Error('HTTP ' + r.status));
      },
      onerror: () => (n < 3 ? setTimeout(() => attempt(n + 1), 2000 * (n + 1)) : reject(new Error('network error'))),
      ontimeout: () => (n < 3 ? attempt(n + 1) : reject(new Error('timed out')))
    });
    attempt(0);
  });
}

// The signed storage URL takes the bytes with Content-Type only (no cookie or XSRF header), as the CMS does.
async function storagePut(url, blob, type) {
  const r = await fetch(url, { method: 'PUT', body: blob, headers: { 'Content-Type': type }, credentials: 'omit' });
  return r.status;
}

// SheetJS (the spreadsheet reader) is only needed for site-map workbooks. Tampermonkey keeps a copy (@resource),
// and it is started here the first time a workbook is opened, instead of on every page the script runs on.
let xlsx = null;
function loadXlsx() {
  if (xlsx) return xlsx;
  if (typeof XLSX !== 'undefined') return (xlsx = XLSX); // the dev harness loads it with a script tag
  if (typeof GM_getResourceText !== 'function') throw new Error('The spreadsheet reader is not available (check the script header has @grant GM_getResourceText).');
  const code = GM_getResourceText('xlsx');
  if (!code) throw new Error('The spreadsheet reader (SheetJS) was not downloaded. Open the script in Tampermonkey and save it again while online.');
  xlsx = new Function(code + '\n;return XLSX;')();
  return xlsx;
}

setPlatform({ download, storagePut, loadXlsx });

const LOG = '[Importer] ';
const DOCK_CSS = 'display:block;width:calc(100% - 16px);margin:12px 8px;padding:8px 6px;background:#fff;color:#b3121b;border:0;border-radius:4px;font:600 13px/1.2 sans-serif;cursor:pointer;';
const FLOAT_CSS = 'position:fixed;right:16px;bottom:16px;z-index:2147483645;padding:10px 14px;background:#b3121b;color:#fff;border:0;border-radius:4px;font:600 14px/1.2 sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);';

function makeButton(css, floating) {
  const b = document.createElement('button');
  b.id = 'si-open';
  b.textContent = 'D10 Importer';
  if (floating) b.dataset.floating = '1';
  b.style.cssText = css;
  b.onclick = openPanel;
  return b;
}

// Puts the importer in the dock: as a dock item with an icon when the dock's items can be copied
// (see ui/dock.js), otherwise as the plain button under the menu. Returns true once it is in the dock.
function addButton() {
  const menu = document.getElementById('dock-menu');
  const host = menu ? menu.parentElement : null;
  const existing = document.getElementById('si-open');
  if (!host) return false;
  if (existing && !existing.dataset.floating) return true;
  if (existing) existing.remove();
  let item = null;
  try { item = makeDockItem(menu, openPanel); } catch (e) { console.warn(LOG + 'could not add a dock item, using a button instead', e); }
  if (item) console.log(LOG + 'added to the dock (copied from "' + item.dataset.siTemplate + '")');
  else host.appendChild(makeButton(DOCK_CSS, false));
  return true;
}

function addFloatingButton() {
  if (document.getElementById('si-open')) return;
  document.body.appendChild(makeButton(FLOAT_CSS, true));
  console.warn(LOG + '#dock-menu not found; showing a floating button instead.');
}

// ---------- Which sites the importer is on for ----------
/* global GM_getValue, GM_setValue, GM_registerMenuCommand */
const SITES_KEY = 'sites';
const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
// The test sandbox is on until the list is first changed. Without Tampermonkey storage (the dev harness),
// the importer is on for the current site.
const readSites = () => (hasGM ? GM_getValue(SITES_KEY, [SANDBOX_HOST]) : [location.host.toLowerCase()]);
const writeSites = list => { if (hasGM) GM_setValue(SITES_KEY, list); };

// Looks for the dock for up to 20 seconds, adds the item once, then stops. Nothing keeps running afterwards.
let started = false;
function addOnce(version) {
  if (started) return;
  started = true;
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (addButton()) { clearInterval(timer); console.log(LOG + 'v' + version + ' ready on ' + location.host); return; }
    if (tries >= 20) { clearInterval(timer); addFloatingButton(); }
  }, 1000);
}

function registerMenu(version) {
  if (typeof GM_registerMenuCommand !== 'function') return;
  const host = location.host.toLowerCase();
  if (isEnabled(readSites(), host)) {
    GM_registerMenuCommand('Open D10 Importer', () => openPanel());
    GM_registerMenuCommand('Turn off D10 Importer for ' + host, () => {
      writeSites(withoutSite(readSites(), host));
      const b = document.getElementById('si-open'); if (b) b.remove();
      alert('D10 Importer is off for ' + host + '. It will not run on this site until you turn it on again.');
    });
  } else {
    GM_registerMenuCommand('Turn on D10 Importer for ' + host, () => {
      writeSites(withSite(readSites(), host));
      addOnce(version);
      alert('D10 Importer is on for ' + host + '. It appears in the CMS dock (or as a red button) within a few seconds.');
    });
  }
  GM_registerMenuCommand('Choose D10 Importer sites…', () => {
    const now = readSites();
    const text = prompt('Sites the D10 Importer runs on, separated by commas (addresses or full URLs):', now.join(', '));
    if (text == null) return;
    const list = parseSiteList(text);
    writeSites(list);
    alert(list.length ? 'D10 Importer now runs on:\n' + list.join('\n') + '\n\nReload a site\'s page to see the change there.' : 'D10 Importer is now off for every site.');
  });
}

function start(version) {
  if (window.top !== window.self) return; // not inside frames
  registerMenu(version);
  if (!isEnabled(readSites(), location.host)) return; // not a site it is on for: nothing runs
  addOnce(version);
}

module.exports = { start };

  },
  "runner": function (module, exports, require) {
'use strict';
// Runs a plan against the CMS in resumable phases, and undoes a run, both from the manifest.
//   pages   - create each page (title, layout, publish state)
//   menu    - create menu items top-down, linked to their pages (poc_id), in plan order
//   media   - upload the files and images the pages link to (content mode, optional)
//   content - write each page's converted body, with /node and /media links pointing at the new site
//   cards   - Teasers sections of link cards: module listing pages, and right-column cards from D10 embedded pages
//   promote - promote each page's draft
// Every create is written to the manifest and saved before the next request, so a run that stops
// at any point can be resumed or undone. Running the same plan again only does what is missing.

const man = require('./lib/manifest');
const { INTERIOR_STANDARD_LAYOUT_ID } = require('./api/streamline');
const { RUN_LOCKED, sameOption } = require('./lib/plan');
const { buildPageContent, linkedPageKeys } = require('./lib/content');

class StopRequested extends Error { constructor() { super('Stopped by user'); this.name = 'StopRequested'; } }

// ctx: { api, manifest, save(manifest), log(msg), shouldStop(), idx (links.buildLinkIndex), download(url) -> Blob }
async function runPlan(plan, ctx) {
  const { api, manifest: m, log } = ctx;
  const save = () => ctx.save(m);
  const check = () => { if (ctx.shouldStop && ctx.shouldStop()) throw new StopRequested(); };
  if (m.startedAt && m.options) {
    const changed = RUN_LOCKED.filter(k => m.options[k] !== undefined && !sameOption(m.options[k], plan.options[k]));
    if (changed.length) throw new Error('This run was started with different options (' + changed.join(', ') + '). Use the same options to resume, or undo the run first.');
  }
  m.options = plan.options;
  const media = plan.media || [];
  const hasContent = plan.pages.some(p => p.content === 'content');
  const hasCards = plan.pages.some(p => p.cards && p.cards.length);
  const phases = ['pages', 'menu items'].concat(media.length ? ['media'] : [], hasContent ? ['content'] : [], hasCards ? ['link cards'] : [], ['promote drafts']);
  const phase = name => log('Phase ' + (phases.indexOf(name) + 1) + ' of ' + phases.length + ': ' + name);

  await resolveLayout(api, m, log);
  save();

  // ---- pages ----
  phase('pages');
  log('  ' + plan.pages.length + ' in the plan');
  if (m.startedAt) {
    // Resuming: drop manifest entries whose page no longer exists, so they are created again.
    const cmsPages = await api.listPages();
    const live = new Set(cmsPages.map(p => String(p.id)));
    for (const p of plan.pages) {
      const rec = m.pages[p.key];
      if (rec && !live.has(String(rec.streamlineId))) { log('  "' + p.title + '" is in the manifest but not in the CMS; it will be created again'); man.forgetPage(m, p.key); }
    }
    flagPossibleDuplicates(plan, m, cmsPages, log);
    save();
  } else {
    m.startedAt = new Date().toISOString();
    save();
  }
  let made = 0;
  for (const p of plan.pages) {
    check();
    if (m.pages[p.key]) continue;
    const page = await api.createPage({ title: p.title, unpublished: p.unpublished, layoutId: m.layout.id });
    man.recordPage(m, p.key, { streamlineId: page.id, slug: page.slug, title: p.title, nid: p.nid, sourceType: p.sourceType, unpublished: p.unpublished, stage: 'created' });
    save();
    made++;
    if (made % 25 === 0) log('  … ' + made + ' pages created');
  }
  log('  ' + made + ' created, ' + (plan.pages.length - made) + ' already done');

  // ---- menu ----
  phase('menu items');
  log('  ' + plan.menu.length + ' in the plan');
  if (!m.menuId) { m.menuId = await api.menuIdFor(m.menuName || 'primary'); save(); }
  const liveItems = await api.menuItems(m.menuId);
  // Top-level items go after the site's own top-level items instead of mixing in with them.
  // Fixed on the first run and kept in the manifest, so a resume puts items in the same places.
  if (m.topWeightBase == null) {
    const ours = new Set(Object.values(m.menuItems).map(r => String(r.id)));
    const theirs = liveItems.filter(i => i.parent_id == null && !ours.has(String(i.id))).map(i => Number(i.weight) || 0);
    m.topWeightBase = theirs.length ? Math.max(...theirs) + 1 : 0;
    save();
  }
  if (plan.menu.some(x => m.menuItems[x.key])) {
    const live = new Set(liveItems.map(i => String(i.id)));
    for (const x of plan.menu) {
      const rec = m.menuItems[x.key];
      if (rec && !live.has(String(rec.id))) { log('  menu item "' + x.title + '" is in the manifest but not in the CMS; it will be created again'); man.forgetMenuItem(m, x.key); }
    }
    save();
  }
  made = 0;
  for (const x of plan.menu) {
    check();
    if (m.menuItems[x.key]) continue;
    const page = m.pages[x.pageKey];
    if (!page) throw new Error('Menu item "' + x.title + '" has no page in the manifest');
    let parentId = null;
    if (x.parentKey) {
      const parent = m.menuItems[x.parentKey];
      if (!parent) throw new Error('Menu item "' + x.title + '" has no parent item in the manifest');
      parentId = parent.id;
    }
    const weight = x.parentKey ? x.weight : m.topWeightBase + x.weight;
    const item = await api.createMenuItem({ menuId: m.menuId, title: x.title, pageId: page.streamlineId, parentId, weight });
    man.recordMenuItem(m, x.key, { id: item.id, menuId: m.menuId, parentId, pageKey: x.pageKey, title: x.title, level: x.level });
    save();
    made++;
    if (made % 25 === 0) log('  … ' + made + ' menu items created');
  }
  log('  ' + made + ' created, ' + (plan.menu.length - made) + ' already done');

  // ---- media ----
  if (media.length) {
    phase('media');
    await uploadMediaPhase(media, ctx, check, save);
  }

  // ---- content ----
  if (hasContent) {
    phase('content');
    await contentPhase(plan, ctx, check, save);
  }

  // ---- link cards ----
  if (hasCards) {
    phase('link cards');
    await cardsPhase(plan, ctx, check, save);
  }

  // ---- promote ----
  phase('promote drafts');
  made = 0;
  for (const p of plan.pages) {
    check();
    const rec = m.pages[p.key];
    if (man.pageStageAtLeast(rec, 'promoted')) continue;
    const r = await api.promoteDraft(rec.streamlineId);
    man.setPageStage(m, p.key, 'promoted', { promoteResult: r });
    save();
    made++;
  }
  log('  ' + made + ' promoted');
  return man.summary(m);
}

async function uploadMediaPhase(media, ctx, check, save) {
  const { api, manifest: m, log, idx } = ctx;
  if (!ctx.download) throw new Error('Media upload needs a downloader (GM_xmlhttpRequest in the userscript)');
  let made = 0, failed = 0;
  for (const mid of media) {
    check();
    if (m.media[mid]) continue;
    const src = idx.media.get(mid);
    if (!src || !src.url || (src.kind !== 'image' && src.kind !== 'file')) continue;
    let blob;
    try { blob = await ctx.download(src.url); }
    catch (e) {
      // A source file that cannot be fetched is reported, not fatal: links to it stay on the old site.
      failed++;
      m.mediaFailures = Object.assign({}, m.mediaFailures, { [mid]: { url: src.url, error: e.message } });
      log('  ✗ could not download "' + (src.fileName || src.url) + '": ' + e.message);
      save();
      continue;
    }
    const up = await api.uploadMedia({ kind: src.kind, basename: src.fileName || src.url.split('/').pop() || ('media-' + mid), blob, altText: src.alt });
    man.recordMedia(m, mid, { kind: up.kind, streamlineId: up.id, url: up.url, altText: up.altText || '', name: src.name, fileName: src.fileName });
    if (m.mediaFailures && m.mediaFailures[mid]) delete m.mediaFailures[mid];
    save();
    made++;
    if (made % 10 === 0) log('  … ' + made + ' uploaded');
  }
  log('  ' + made + ' uploaded, ' + failed + ' could not be downloaded, ' + (media.length - made - failed) + ' already done or skipped');
}

async function contentPhase(plan, ctx, check, save) {
  const { api, manifest: m, log, idx } = ctx;
  const opts = { includeAttachments: plan.options.includeAttachments };
  await resolvePageUrls(plan, ctx, save);
  const pattern = plan.options.pageUrlPattern !== 'auto' ? plan.options.pageUrlPattern : null;
  const lookups = {
    pageUrl: key => {
      const r = m.pages[key];
      if (!r) return null;
      if (r.url) return r.url;
      return pattern && r.slug != null ? pattern.replace('{slug}', r.slug) : null;
    },
    media: mid => (m.media[mid] ? { url: m.media[mid].url, id: m.media[mid].streamlineId, altText: m.media[mid].altText } : null)
  };
  let written = 0, empty = 0, accordions = 0;
  for (const p of plan.pages) {
    check();
    const rec = m.pages[p.key];
    if (p.content !== 'content' || man.pageStageAtLeast(rec, 'content')) continue;
    const c = buildPageContent(p, idx, lookups, opts);
    if (c.empty && !c.faqs.length) { man.setPageStage(m, p.key, 'content', { contentEmpty: true }); save(); empty++; continue; }

    // The main column, looked up once per page and only when a section still has to be added.
    let mainId = null;
    const main = async () => {
      if (mainId) return mainId;
      const cols = await api.draftColumns(rec.streamlineId);
      const col = cols.find(x => x.columnType === 'main');
      if (!col) throw new Error('Page "' + p.title + '" has no main column (columns: ' + cols.map(x => x.columnType).join(', ') + ')');
      return (mainId = col.id);
    };

    // Body first (weight 1), then one accordion per FAQ, in D10 order. Each section id is saved as soon as it
    // exists, so a resume fills in the same sections instead of adding new ones.
    if (!c.empty) {
      if (!rec.sectionId) {
        man.setPageStage(m, p.key, 'section', { sectionId: await api.addSection(rec.streamlineId, 'Freeform', await main(), 1) });
        save();
      }
      await api.setFreeform(m.pages[p.key].sectionId, c.html, c.json);
    }
    const faqIds = (m.pages[p.key].faqSectionIds || []).slice();
    for (let i = 0; i < c.faqs.length; i++) {
      check();
      const q = c.faqs[i];
      if (!faqIds[i]) {
        faqIds[i] = await api.addSection(rec.streamlineId, 'Freeform', await main(), (c.empty ? 1 : 2) + i);
        man.recordPage(m, p.key, { faqSectionIds: faqIds.slice() });
        save();
      }
      await api.setFreeform(faqIds[i], q.html, q.json);
      await api.setFreeformPreferences(faqIds[i], { accordion: true, accordionTitle: q.question });
      accordions++;
    }
    const oldSite = c.links.filter(l => l.outcome === 'old-site').length;
    man.setPageStage(m, p.key, 'content', { contentWarnings: c.warnings.length, linksToOldSite: oldSite, faqs: c.faqs.length });
    save();
    written++;
    if (written % 25 === 0) log('  … ' + written + ' pages written');
  }
  log('  ' + written + ' written' + (accordions ? ' (' + accordions + ' FAQ accordions)' : '') + ', ' + empty + ' had no body');
}

// Teasers sections of link cards. Each section's id, and whether its cards were added, are saved as soon as they
// happen, so a resume finishes a half-done section instead of adding another.
async function cardsPhase(plan, ctx, check, save) {
  const { api, manifest: m, log } = ctx;
  let sections = 0, cards = 0;
  for (const p of plan.pages) {
    if (!p.cards || !p.cards.length) continue;
    const rec = m.pages[p.key];
    if (!rec || rec.cardsComplete) continue;
    check();
    let cols = null;
    const colId = async type => {
      cols = cols || await api.draftColumns(rec.streamlineId);
      const c = cols.find(x => x.columnType === type);
      if (!c) throw new Error('Page "' + p.title + '" has no ' + type + ' column (columns: ' + cols.map(x => x.columnType).join(', ') + ')');
      return c.id;
    };
    // Main-column cards go after the body and FAQ sections; right-column cards are the only sections there.
    const mainBase = 1 + (m.pages[p.key].sectionId ? 1 : 0) + ((m.pages[p.key].faqSectionIds || []).length);
    const ids = (m.pages[p.key].cardSectionIds || []).slice(), done = (m.pages[p.key].cardsDone || []).slice();
    let gutterIndex = 0, mainIndex = 0;
    for (let i = 0; i < p.cards.length; i++) {
      check();
      const card = p.cards[i];
      const weight = card.column === 'gutter' ? gutterIndex++ : mainBase + mainIndex++;
      if (!ids[i]) {
        ids[i] = await api.addSection(rec.streamlineId, 'Teasers', await colId(card.column), weight);
        man.recordPage(m, p.key, { cardSectionIds: ids.slice() });
        save();
        sections++;
      }
      await api.setTeaserPreferences(ids[i], { title: card.title || undefined, orderByIndex: card.orderBy, perPage: card.perPage });
      if (!done[i]) {
        const pocIds = card.keys.map(k => m.pages[k] && m.pages[k].streamlineId).filter(Boolean);
        await api.addTeasers(ids[i], pocIds);
        done[i] = true;
        man.recordPage(m, p.key, { cardsDone: done.slice() });
        save();
        cards += pocIds.length;
      }
    }
    man.recordPage(m, p.key, { cardsComplete: true });
    save();
  }
  log('  ' + sections + ' card sections, ' + cards + ' cards');
}

// Links between imported pages need each page's address on the new site. The CMS reports it on the page's
// record (GET /api/pocs/{id} -> url), so it is read from there for every page the content links to, and kept
// in the manifest. A "Page URL pattern" set in Options (e.g. /{slug}) is used instead when given.
async function resolvePageUrls(plan, ctx, save) {
  const { api, manifest: m, log, idx } = ctx;
  if (plan.options.pageUrlPattern !== 'auto') { log('  page addresses: ' + plan.options.pageUrlPattern + ' (from Options)'); return; }
  const keys = [...linkedPageKeys(plan, idx, { includeAttachments: plan.options.includeAttachments })].filter(k => m.pages[k] && !m.pages[k].url);
  for (const k of keys) {
    man.recordPage(m, k, { url: await api.pageUrl(m.pages[k].streamlineId) });
    save();
  }
  if (keys.length) log('  looked up ' + keys.length + ' page address(es) for links between pages');
}

// Finds the InteriorStandard layout on this site: the known id first, then by name. Never guesses between several.
async function resolveLayout(api, m, log) {
  if (m.layout && m.layout.id) return m.layout;
  const layouts = await api.listLayouts();
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let hit = layouts.filter(l => l.id === INTERIOR_STANDARD_LAYOUT_ID);
  if (!hit.length) hit = layouts.filter(l => norm(l.name) === 'interiorstandard');
  if (hit.length !== 1) {
    throw new Error((hit.length ? 'More than one' : 'No') + ' InteriorStandard layout on this site. Layouts: ' + layouts.map(l => l.name + ' (' + l.id + ')').join(', '));
  }
  m.layout = { id: hit[0].id, name: hit[0].name };
  log('Layout: ' + m.layout.name + ' (' + m.layout.id + ')');
  return m.layout;
}

// If a run stopped right after the CMS created a page but before the reply arrived, the page exists
// without a manifest entry, and this run will create it again. Such pages are flagged for a person
// to check, not adopted: a title match alone is not proof.
function flagPossibleDuplicates(plan, m, cmsPages, log) {
  const inManifest = new Set(Object.values(m.pages).map(r => String(r.streamlineId)));
  const wanted = new Map(plan.pages.filter(p => !m.pages[p.key]).map(p => [p.title.toLowerCase(), p]));
  const since = Date.parse(m.startedAt);
  const found = [];
  for (const c of cmsPages) {
    if (inManifest.has(String(c.id))) continue;
    const p = wanted.get(String(c.amplifyTitle || '').toLowerCase());
    if (!p) continue;
    const created = [c.draftPageVersion, c.activePageVersion].map(v => v && Date.parse(v.createdAt)).filter(Boolean);
    if (!created.length || Math.min(...created) < since) continue;
    found.push({ title: c.amplifyTitle, streamlineId: c.id, planKey: p.key });
  }
  if (found.length) {
    m.possibleDuplicates = (m.possibleDuplicates || []).concat(found);
    for (const f of found) log('  ⚠ "' + f.title + '" (' + f.streamlineId + ') was created after this run started but is not in the manifest. It may be a leftover from an interrupted request: check it, and delete it in the CMS if it is a duplicate.');
  }
}

// Removes everything the manifest says this tool created: menu items (deepest first), then pages.
// Entries are removed from the manifest as they go, so undo can also be resumed.
async function undoRun(ctx) {
  const { api, manifest: m, log } = ctx;
  const save = () => ctx.save(m);
  const keys = Object.keys(m.menuItems);
  if (keys.length) {
    const menuId = m.menuId || await api.menuIdFor(m.menuName || 'primary');
    log('Removing ' + keys.length + ' menu item(s)');
    // Re-read and delete until none are live. Children can be missed on a single pass (seen in user6).
    const ids = new Set(keys.map(k => String(m.menuItems[k].id)));
    const deepestFirst = (a, b) => (m.menuItems[b].level || 0) - (m.menuItems[a].level || 0);
    for (let pass = 0; pass < 3; pass++) {
      const live = new Map((await api.menuItems(menuId)).map(i => [String(i.id), i]));
      const targets = keys.filter(k => m.menuItems[k] && live.has(String(m.menuItems[k].id))).sort(deepestFirst);
      if (!targets.length) break;
      for (const k of targets) await api.softDeleteMenuItem(live.get(String(m.menuItems[k].id)));
    }
    const left = (await api.menuItems(menuId)).filter(i => ids.has(String(i.id)));
    if (left.length) throw new Error(left.length + ' imported menu item(s) still live: ' + left.slice(0, 5).map(i => i.title).join(', '));
    for (const k of keys) man.forgetMenuItem(m, k);
    save();
  }
  const pageKeys = Object.keys(m.pages);
  if (pageKeys.length) log('Removing ' + pageKeys.length + ' page(s)');
  for (const k of pageKeys) {
    const r = await api.deletePage(m.pages[k].streamlineId);
    if (r === 'gone') log('  "' + m.pages[k].title + '" was already gone');
    man.forgetPage(m, k);
    save();
  }
  const mediaIds = Object.keys(m.media || {});
  if (mediaIds.length) log('Removing ' + mediaIds.length + ' uploaded file(s) and image(s)');
  for (const mid of mediaIds) {
    try { await api.deleteMedia(m.media[mid].kind, m.media[mid].streamlineId); }
    catch (e) { if (!/not found|could not find|couldn.t find|does not exist/i.test(e.message)) throw e; log('  "' + (m.media[mid].fileName || mid) + '" was already gone'); }
    man.forgetMedia(m, mid);
    save();
  }
  log('Undo finished');
}

// Runs fn over items with up to n calls in flight. The API client still spaces out when each request starts;
// this only stops one slow server reply from holding up the next delete.
async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
const WIPE_PARALLEL = 4;

// Kinds of content "Erase this site" deletes. The homepage stays (the site needs it), and so do products
// (payments) and profiles, which are not page content.
const WIPE_POC_TYPES = ['page', 'event', 'meeting', 'group', 'external'];

// Clears a site for a fresh test import: every menu item in every menu, every page (not the homepage), and,
// when opts.media is set, every uploaded file and image. snapshot(obj) receives the full list of what is about
// to go before anything is deleted. Safe to run again after a stop: it only ever deletes what is still there.
async function wipeSite(api, opts, ctx) {
  const { log } = ctx;
  const check = () => { if (ctx.shouldStop && ctx.shouldStop()) throw new StopRequested(); };
  log('Reading the site…');
  const menus = await api.listMenus();
  const items = {};
  for (const mnu of menus) items[mnu.name] = await api.menuItems(mnu.id);
  const pocs = (await api.listAllPocs()).filter(p => WIPE_POC_TYPES.includes(p.pocTypeName) && p.canDelete !== false);
  const files = opts.media ? await api.listFiles() : [];
  const images = opts.media ? (await api.listImages()).filter(i => i.type !== 'Video') : [];
  ctx.snapshot({ host: ctx.host, takenAt: new Date().toISOString(), menus, menuItems: items, pages: pocs, files, images });
  const itemCount = Object.values(items).reduce((s, a) => s + a.length, 0);
  log('Deleting ' + itemCount + ' menu item(s) in ' + menus.length + ' menu(s), ' + pocs.length + ' page(s)' + (opts.media ? ', ' + files.length + ' file(s) and ' + images.length + ' image(s)' : '') + '.');

  // Menus first, children before parents, re-reading until none are left (as removeAllMenuItems does).
  let gone = 0;
  for (const mnu of menus) {
    for (let pass = 0; pass < 4; pass++) {
      const live = await api.menuItems(mnu.id);
      if (!live.length) break;
      const byId = new Map(live.map(i => [String(i.id), i]));
      const depth = i => { let d = 0, p = i.parent_id; while (p != null && byId.has(String(p)) && d < 20) { d++; p = byId.get(String(p)).parent_id; } return d; };
      // Deepest level first; the items of one level do not depend on each other, so they go in parallel.
      const levels = [...new Set(live.map(depth))].sort((a, b) => b - a);
      for (const lv of levels) {
        await pool(live.filter(i => depth(i) === lv), WIPE_PARALLEL, async it => {
          check();
          await api.softDeleteMenuItem(it);
          if (++gone % 25 === 0) log('  … ' + gone + ' / ' + itemCount + ' menu items');
        });
      }
    }
    const left = await api.menuItems(mnu.id);
    if (left.length) throw new Error(left.length + ' item(s) still in the ' + mnu.name + ' menu: ' + left.slice(0, 5).map(i => i.title).join(', '));
  }
  log('  menus cleared');

  let n = 0;
  await pool(pocs, WIPE_PARALLEL, async p => {
    check();
    await api.deletePage(p.id);
    if (++n % 25 === 0) log('  … ' + n + ' / ' + pocs.length + ' pages');
  });
  log('  ' + n + ' page(s) deleted');

  if (opts.media) {
    let f = 0, im = 0;
    const gone = e => { if (!/not found|could not find|couldn.t find/i.test(e.message)) throw e; };
    await pool(files, WIPE_PARALLEL, async x => { check(); await api.deleteMedia('file', x.id).catch(gone); if (++f % 25 === 0) log('  … ' + f + ' / ' + files.length + ' files'); });
    await pool(images, WIPE_PARALLEL, async x => { check(); await api.deleteMedia('image', x.id).catch(gone); if (++im % 25 === 0) log('  … ' + im + ' / ' + images.length + ' images'); });
    log('  ' + f + ' file(s) and ' + im + ' image(s) deleted');
  }

  // What is left, as a check.
  const pagesLeft = (await api.listAllPocs()).filter(p => WIPE_POC_TYPES.includes(p.pocTypeName) && p.canDelete !== false).length;
  if (pagesLeft) throw new Error(pagesLeft + ' page(s) are still on the site; run Erase again');
  return { menuItems: itemCount, pages: n, files: files.length, images: images.length };
}

// Removes every live item in a menu, after handing a snapshot to the caller (user6 behaviour).
async function removeAllMenuItems(api, menuName, snapshot, log) {
  const menuId = await api.menuIdFor(menuName);
  const items = await api.menuItems(menuId);
  snapshot({ menu: menuName, exportedAt: new Date().toISOString(), items });
  log('Removing all ' + items.length + ' item(s) from ' + menuName);
  for (let pass = 0; pass < 3; pass++) {
    const live = await api.menuItems(menuId);
    if (!live.length) break;
    for (const it of live) await api.softDeleteMenuItem(it);
  }
  const left = await api.menuItems(menuId);
  if (left.length) throw new Error(left.length + ' item(s) still live in ' + menuName + ': ' + left.slice(0, 5).map(i => i.title).join(', '));
}

module.exports = { runPlan, undoRun, removeAllMenuItems, wipeSite, WIPE_POC_TYPES, StopRequested };

  },
  "ui/dock": function (module, exports, require) {
'use strict';
// Adds "D10 Importer" to the CMS dock as a real dock item: an icon that shows when the dock is collapsed
// and a label that shows when it expands. Rather than guess the dock's markup and CSS, it copies an
// existing item (Support, or another plain item), swaps the icon and the label, and inserts the copy above
// the original, so the size, colours and collapse behaviour are the dock's own.

// Outline icon in the dock's style: a page with an arrow coming in from the left (an import).
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M9 9V3h7l5 5v13H9v-6"/><path d="M16 3v5h5"/><path d="M2 12h11"/><path d="M10 9l3 3-3 3"/><path d="M15 17h3"/></svg>';

// Items worth copying, in order of preference. Content and Sign Out are avoided: they are often
// highlighted (the current page, or a hover colour), and Sign Out's link must never be copied by mistake.
const TEMPLATES = ['Support', 'Preferences', 'Users', 'Engage', 'Menus', 'Compliance', 'Accessibility'];
const ICON_SELECTOR = 'svg, img, i, [class*="icon" i]';
const ACTIVE_CLASS = /^(active|selected|current|is-active|router-link-active|router-link-exact-active)$/i;

// The text node whose whole text is `label`, inside `root`.
function findText(root, label) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim() === label) return n;
  return null;
}

// From a label, climbs to the element that is one whole dock item: the smallest ancestor holding an icon
// too, then up through single-child wrappers (li > a > …) while staying inside the menu.
function itemFor(textNode, menu) {
  let el = textNode.parentElement;
  while (el && el !== menu && !el.querySelector(ICON_SELECTOR)) el = el.parentElement;
  if (!el || el === menu) return null;
  while (el.parentElement && el.parentElement !== menu && el.parentElement.children.length === 1) el = el.parentElement;
  return el;
}

function findTemplate(menu) {
  for (const label of TEMPLATES) {
    const t = findText(menu, label);
    const item = t && itemFor(t, menu);
    if (item) return { item, label };
  }
  return null;
}

// Copies the template item and turns it into the importer's item. Returns null when the dock does not look
// the way this expects, so the caller can fall back to a plain button.
function makeDockItem(menu, onOpen) {
  const tpl = findTemplate(menu);
  if (!tpl) return null;
  const oldIcon = tpl.item.querySelector(ICON_SELECTOR);
  const box = oldIcon.getBoundingClientRect();
  const iconColor = getComputedStyle(oldIcon).color;
  const copy = tpl.item.cloneNode(true);

  // Label.
  const text = findText(copy, tpl.label);
  if (!text) return null;
  text.nodeValue = text.nodeValue.replace(tpl.label, 'D10 Importer');

  // Icon: same class (so the dock's CSS sizes it), same size, the dock's icon colour.
  const icon = copy.querySelector(ICON_SELECTOR);
  const holder = document.createElement('span');
  holder.innerHTML = ICON_SVG;
  const svg = holder.firstChild;
  if (icon.getAttribute('class')) svg.setAttribute('class', icon.getAttribute('class'));
  if (box.width && box.height) { svg.style.width = box.width + 'px'; svg.style.height = box.height + 'px'; }
  svg.style.color = iconColor;
  svg.style.flexShrink = '0';
  icon.replaceWith(svg);

  // Nothing of the template's behaviour comes along: no link, no ids, no active state.
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      if (a.name === 'id' || a.name === 'href' || a.name === 'aria-current' || /routerlink|ng-reflect|data-testid/i.test(a.name)) el.removeAttribute(a.name);
    }
    if (el.classList) [...el.classList].filter(c => ACTIVE_CLASS.test(c)).forEach(c => el.classList.remove(c));
  }
  copy.id = 'si-open';
  copy.dataset.siTemplate = tpl.label;
  copy.setAttribute('role', 'button');
  copy.setAttribute('tabindex', '0');
  copy.setAttribute('title', 'D10 Importer');
  copy.style.cursor = 'pointer';
  // Capture phase, so the dock's own click handling (routing) never sees the click.
  const open = e => { e.preventDefault(); e.stopPropagation(); onOpen(); };
  copy.addEventListener('click', open, true);
  copy.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(e); }, true);

  tpl.item.parentElement.insertBefore(copy, tpl.item);
  return copy;
}

module.exports = { makeDockItem, findTemplate, ICON_SVG };

  },
  "ui/panel": function (module, exports, require) {
'use strict';
// The importer wizard: 1 Load, 2 Options, 3 Preview (dry run, no writes), 4 Run.
// Plus resume, undo, the API schema download, and the advanced "remove ALL primary items" from user6.

const d10 = require('../lib/d10');
const { buildNavFromD10, limitTree } = require('../lib/navFromD10');
const { buildPlan, planReportRows, outline, DEFAULT_OPTIONS } = require('../lib/plan');
const { toCsv, PLAN_COLUMNS, SKIPPED_COLUMNS, LINK_COLUMNS, MEDIA_COLUMNS, CARD_ISSUE_COLUMNS } = require('../lib/csv');
const { MODULES, MODULE_TYPES, moduleCounts } = require('../lib/modules');
const { buildLinkIndex } = require('../lib/links');
const { buildPageContent, placeholderLookups } = require('../lib/content');
const { readSiteMap } = require('../lib/sitemap');
const { matchSiteMap, parseOverrides, MATCH_COLUMNS } = require('../lib/match');
const { faqReport, FAQ_COLUMNS, outOfScopeReport, OUT_OF_SCOPE_COLUMNS } = require('../lib/reports');
const man = require('../lib/manifest');
const { makeClient, browserTransport, ApiError, SANDBOX_HOST } = require('../api/client');
const { streamlineApi } = require('../api/streamline');
const { runPlan, undoRun, removeAllMenuItems, wipeSite, StopRequested } = require('../runner');
const { INTROSPECTION, toSdl, checkSchema } = require('../lib/schema');

const RED = '#b3121b';
const MANIFEST_KEY = () => 'streamline-importer-manifest:' + location.host;

// The same user6 skip-report columns, so the user guide's description still fits.
const SITEMAP_SKIPPED_COLUMNS = [
  { key: 'row', label: 'Excel row' }, { key: 'level', label: 'Level' }, { key: 'title', label: 'Page' }, { key: 'path', label: 'Parent path' },
  { key: 'reason', label: 'Why skipped' }, { key: 'k', label: 'Complete' }, { key: 'l', label: 'Incomplete' }, { key: 'm', label: 'Linked' }
];

// ---------- Small DOM helpers ----------
const h = (tag, text, css) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (css) e.style.cssText = css; return e; };
const btn = (text, onclick, primary) => {
  const b = h('button', text, 'margin:6px 8px 0 0;padding:8px 14px;border-radius:4px;border:1px solid ' + RED + ';cursor:pointer;font:600 14px sans-serif;background:' + (primary ? RED + ';color:#fff' : '#fff;color:' + RED));
  b.onclick = onclick; return b;
};
const heading = t => h('div', t, 'margin:16px 0 6px;padding:8px 10px;background:#eceef2;border-left:4px solid ' + RED + ';border-radius:4px;font-size:15px;font-weight:700;color:#222;');
const box = css => h('div', '', 'background:#f6f6f6;border-radius:4px;padding:10px;font-size:13px;line-height:1.6;white-space:pre-line;' + (css || ''));
const note = t => h('div', t, 'font-size:12px;color:#666;margin:2px 0 0 24px;');
const hint = t => h('div', t, 'color:#555;font-size:13px;');

function saveFile(text, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
const saveCsv = (cols, rows, name) => saveFile(toCsv(cols, rows), name, 'text/csv;charset=utf-8');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Anywhere but the test sandbox, actions that change the CMS ask for the site's address to be typed,
// so a run cannot land on the wrong client's site by a stray click.
const isSandbox = () => location.host === SANDBOX_HOST;
function confirmChange(message) {
  if (isSandbox()) return confirm(message);
  const typed = prompt(message + '\n\nThis is a live site. Type ' + location.host + ' to confirm.');
  return typed != null && typed.trim().toLowerCase() === location.host.toLowerCase();
}
function siteBanner() {
  const b = h('div', '', 'border-radius:4px;padding:8px 10px;margin:0 0 8px;font-size:13px;font-weight:600;' +
    (isSandbox() ? 'background:#eef6ee;color:#225522;' : 'background:#fdecea;color:' + RED + ';border:1px solid #e0b4b4;'));
  b.textContent = isSandbox() ? 'Site: ' + location.host + ' (test sandbox)' : 'Live site: ' + location.host + '. Changes here are real; running, undoing and removing ask you to type this address.';
  return b;
}

function radio(name, options, value, onchange) {
  const wrap = h('div');
  for (const o of options) {
    const row = h('label', '', 'display:block;margin:4px 0;cursor:' + (o.disabled ? 'default' : 'pointer') + ';color:' + (o.disabled ? '#999' : '#222') + ';');
    const r = document.createElement('input');
    r.type = 'radio'; r.name = name; r.value = o.value; r.checked = o.value === value; r.disabled = !!o.disabled; r.style.marginRight = '8px';
    r.onchange = () => onchange(o.value);
    row.appendChild(r); row.appendChild(document.createTextNode(o.label));
    wrap.appendChild(row);
  }
  return wrap;
}
function checkbox(label, checked, onchange, disabled) {
  const row = h('label', '', 'display:block;margin:4px 0;cursor:pointer;color:' + (disabled ? '#999' : '#222') + ';');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!checked; cb.disabled = !!disabled; cb.style.marginRight = '8px';
  cb.onchange = () => onchange(cb.checked);
  row.appendChild(cb); row.appendChild(document.createTextNode(label));
  return row;
}
function filePicker(accept, multiple, folder, onFiles) {
  const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = !!multiple; i.style.display = 'none';
  if (folder) i.webkitdirectory = true;
  i.onchange = async () => { if (i.files.length) await onFiles(i.files); i.value = ''; };
  return i;
}

// ---------- Manifest storage ----------
function loadStoredManifest() {
  try { const t = localStorage.getItem(MANIFEST_KEY()); return t ? man.parseManifest(t, location.host) : null; } catch (e) { return null; }
}
function storeManifest(m) {
  try { localStorage.setItem(MANIFEST_KEY(), JSON.stringify(m)); } catch (e) { console.warn('[Importer] could not save the manifest to localStorage', e); }
}
function clearStoredManifest() { try { localStorage.removeItem(MANIFEST_KEY()); } catch (e) { /* storage unavailable */ } }

// ---------- State, kept while the tab stays open ----------
const state = {
  exp: null, idx: null, sourceLabel: '',
  siteMap: null, overrides: null, overridesLabel: '',
  nav: null, match: null, plan: null, preview: null,
  options: Object.assign({}, DEFAULT_OPTIONS, { unmatchedRows: 'empty-page' }),
  manifest: null, errors: []
};
let platform = {};

function api(log) {
  const client = makeClient(browserTransport(), { host: location.host, log });
  return streamlineApi(client, { storagePut: platform.storagePut });
}

function rebuildPlan() {
  state.nav = state.match = state.plan = state.preview = null;
  if (!state.exp) return;
  let tree;
  if (state.options.menuSource === 'workbook') {
    state.match = matchSiteMap(state.siteMap.built, state.exp, state.idx, { overrides: state.overrides || new Map(), unmatchedRows: state.options.unmatchedRows });
    tree = state.match.tree;
  } else {
    state.nav = buildNavFromD10(state.exp, state.options);
    tree = state.nav.tree;
  }
  state.plan = buildPlan(limitTree(tree, state.options.limit), state.options, state.idx, state.exp);
  state.preview = dryRunContent(state.plan);
}

// Converts every page the way the run will, with placeholder URLs, so the preview can show what happens to each link.
function dryRunContent(plan) {
  const byKey = new Map(), links = [], warnings = [];
  if (!plan.pages.some(p => p.content === 'content')) return { byKey, links, warnings };
  const lookups = placeholderLookups(plan);
  for (const p of plan.pages) {
    if (p.content !== 'content') continue;
    const c = buildPageContent(p, state.idx, lookups, { includeAttachments: plan.options.includeAttachments });
    byKey.set(p.key, c);
    for (const l of c.links) links.push(Object.assign({ page: p.title, nid: p.nid }, l));
    for (const w of c.warnings) warnings.push(p.title + ' (nid ' + p.nid + '): ' + w.code + ' ' + w.detail);
  }
  return { byKey, links, warnings };
}

async function readExportFiles(fileList) {
  const files = [];
  for (const f of fileList) if (d10.exportKey(f.name)) files.push({ name: f.name, text: await f.text() });
  if (!files.length) throw new Error('No www-*.json files in that selection.');
  return files;
}

// SheetJS is started on first use (see loadXlsx in main.js). Columns stay aligned to A even when the used range starts later.
async function readWorkbook(file) {
  const XLSX = platform.loadXlsx ? platform.loadXlsx() : (typeof window !== 'undefined' && window.XLSX);
  if (!XLSX) throw new Error('The spreadsheet reader (SheetJS) is not available.');
  const isCsv = /\.csv$/i.test(file.name);
  const wb = isCsv ? XLSX.read(await file.text(), { type: 'string' }) : XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheets = wb.SheetNames.map(name => {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return { name, aoa: [] };
    const rng = XLSX.utils.decode_range(ws['!ref']);
    rng.s.r = 0; rng.s.c = 0;
    return { name, aoa: XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, range: rng }) };
  });
  return Object.assign({ fileName: file.name }, readSiteMap(sheets));
}

function openPanel() {
  if (document.getElementById('si-overlay')) return;
  state.manifest = loadStoredManifest();
  // Resuming needs the same plan, so start from the options the recorded run used.
  if (state.manifest && !man.isEmpty(state.manifest) && state.manifest.options) Object.assign(state.options, state.manifest.options);
  const overlay = h('div', null, 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646;display:flex;align-items:center;justify-content:center;font:14px/1.4 sans-serif;');
  overlay.id = 'si-overlay';
  const panel = h('div', null, 'background:#fff;color:#222;width:min(760px,94vw);max-height:90vh;overflow:auto;border-radius:6px;padding:20px;box-shadow:0 8px 30px rgba(0,0,0,.3);');
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const clear = () => { panel.innerHTML = ''; };
  const title = (t, step) => {
    panel.appendChild(h('h2', t, 'margin:0 0 4px;font-size:18px;'));
    if (step) panel.appendChild(h('div', step, 'font-size:12px;color:#666;margin:0 0 10px;'));
  };
  const baseName = () => state.sourceLabel.replace(/\s*\(.*$/, '').replace(/[^\w.-]+/g, '_') || 'export';

  async function statusText() {
    const lines = [];
    try {
      const a = api(() => {});
      const items = await a.menuItems(await a.menuIdFor('primary'));
      lines.push('Primary nav: ' + items.length + ' item(s) in the menu');
    } catch (e) { lines.push('Could not read the primary menu: ' + e.message); }
    const m = state.manifest;
    if (m && !man.isEmpty(m)) {
      const s = man.summary(m);
      lines.push('Run recorded in this browser: ' + (s.source || s.runId) + ' (' + s.pages + ' pages, ' + s.promoted + ' promoted, ' + s.menuItems + ' menu items, ' + s.media + ' media), last saved ' + s.updatedAt);
    } else lines.push('No run recorded in this browser.');
    return lines.join('\n');
  }

  // ---- Step 1: Load ----
  function viewLoad() {
    clear();
    title('Drupal 10 → Streamline Importer', 'Step 1 of 4 · Load the D10 export (and, optionally, a site map)');
    panel.appendChild(siteBanner());
    const status = box();
    status.textContent = 'Checking…';
    statusText().then(t => { status.textContent = t; });
    panel.appendChild(status);

    panel.appendChild(heading('D10 export files'));
    panel.appendChild(hint('Choose the folder with the www-*.json files, or select the files. www-pages.json and www-microsites.json are required; www-media.json is needed for files and images.'));
    const summary = box('margin-top:8px;');
    const onExport = async list => {
      summary.textContent = 'Reading…';
      try {
        const files = await readExportFiles(list);
        state.exp = d10.loadExport(files);
        state.idx = buildLinkIndex(state.exp);
        const first = list[0];
        state.sourceLabel = (first.webkitRelativePath ? first.webkitRelativePath.split('/')[0] : 'selected files') + ' (' + files.length + ' files)';
      } catch (e) { state.exp = state.idx = null; summary.textContent = 'Could not read those files: ' + e.message; return; }
      render();
    };
    const folder = filePicker('', true, true, onExport), files = filePicker('.json', true, false, onExport);
    panel.appendChild(folder); panel.appendChild(files);
    panel.appendChild(btn('Choose folder', () => folder.click(), true));
    panel.appendChild(btn('Choose files', () => files.click()));
    panel.appendChild(summary);

    panel.appendChild(heading('Site map (optional)'));
    panel.appendChild(hint('Only needed to build the menu from a site-map workbook instead of the D10 data. Upload the .xlsx (or a CSV of the navigation sheet). An override CSV with "Excel row" and "D10 nid" columns fixes rows that do not match; the match report from the preview can be edited and loaded here.'));
    const smBox = box('margin-top:8px;');
    const sm = filePicker('.xlsx,.xlsm,.xls,.csv', false, false, async list => {
      smBox.textContent = 'Reading ' + list[0].name + '…';
      try { state.siteMap = await readWorkbook(list[0]); } catch (e) { state.siteMap = null; smBox.textContent = 'Could not use that file: ' + e.message; return; }
      render();
    });
    const ov = filePicker('.csv', false, false, async list => {
      try { state.overrides = parseOverrides(await list[0].text()); state.overridesLabel = list[0].name; } catch (e) { state.overrides = null; smBox.textContent = 'Could not use that override file: ' + e.message; return; }
      render();
    });
    panel.appendChild(sm); panel.appendChild(ov);
    panel.appendChild(btn('Choose site map', () => sm.click()));
    panel.appendChild(btn('Choose override CSV', () => ov.click()));
    panel.appendChild(btn('Clear site map', () => { state.siteMap = state.overrides = null; if (state.options.menuSource === 'workbook') state.options.menuSource = 'd10'; render(); }));
    panel.appendChild(smBox);

    function render() {
      if (!state.exp) summary.textContent = 'Nothing loaded.';
      else {
        const e = state.exp;
        const lines = ['Source: ' + state.sourceLabel];
        lines.push('Pages: ' + e.pages.length + ' records (' + e.pages.filter(p => p.kind === 'page').length + ' regular, ' +
          e.pages.filter(p => p.kind === 'news').length + ' news, ' + e.pages.filter(p => p.kind === 'event').length + ' events)');
        lines.push('Microsites: ' + e.microsites.length + ' · Media: ' + e.media.length + ' (' + e.media.filter(m => m.kind === 'file').length + ' files, ' + e.media.filter(m => m.kind === 'image').length + ' images)');
        lines.push('Old site: ' + (e.hosts.length ? e.hosts.join(', ') : 'not found (links to it cannot be recognised)'));
        const others = Object.entries(e.counts).filter(([k, v]) => v != null && !['pages', 'microsites', 'media'].includes(k)).map(([k, v]) => k + ' ' + v);
        if (others.length) lines.push('Also loaded (reports only): ' + others.join(', '));
        const missing = Object.entries(e.counts).filter(([, v]) => v == null).map(([k]) => k);
        if (missing.length) lines.push('Not loaded: ' + missing.join(', '));
        if (e.errors.length) lines.push('\nProblems:\n• ' + e.errors.join('\n• '));
        if (e.warnings.length) lines.push('\nWarnings (' + e.warnings.length + '):\n• ' + e.warnings.slice(0, 8).join('\n• ') + (e.warnings.length > 8 ? '\n• …' : ''));
        summary.textContent = lines.join('\n');
      }
      if (!state.siteMap) smBox.textContent = 'No site map loaded.' + (state.overrides ? '\nOverrides: ' + state.overridesLabel + ' (' + state.overrides.size + ' rows)' : '');
      else {
        const b = state.siteMap.built;
        smBox.textContent = [
          'File: ' + state.siteMap.fileName + ' (sheet "' + state.siteMap.sheetName + '": ' + state.siteMap.columnsLabel + ')',
          b.count + ' menu items marked for creation, up to ' + b.maxDepth + ' levels deep. ' + b.skipped.length + ' row(s) skipped by the marking rules.'
        ].concat(state.siteMap.cols.notes, state.overrides ? ['Overrides: ' + state.overridesLabel + ' (' + state.overrides.size + ' rows)'] : []).join('\n');
      }
    }
    render();

    const msg = h('div', '', 'margin-top:10px;color:' + RED + ';font-weight:600;');
    panel.appendChild(msg);
    const foot = h('div', '', 'margin-top:8px;');
    foot.appendChild(btn('Next: options', () => {
      if (!state.exp) { msg.textContent = 'Load the export first.'; return; }
      if (state.exp.errors.length) { msg.textContent = 'Fix the problems listed above first.'; return; }
      viewOptions();
    }, true));
    foot.appendChild(btn('Resume, undo, other actions', () => viewManage()));
    foot.appendChild(btn('Erase this site…', () => viewManage({ erase: true })));
    foot.appendChild(btn('Close', close));
    panel.appendChild(foot);
  }

  // ---- Step 2: Options ----
  function viewOptions() {
    clear();
    title('Options', 'Step 2 of 4 · Choose what to create');
    const o = state.options;
    const body = h('div');
    panel.appendChild(body);
    const draw = () => {
      body.innerHTML = '';
      body.appendChild(heading('Menu source'));
      body.appendChild(radio('si-menu', [
        { value: 'd10', label: 'Build the menu from the D10 data (microsites on top, their pages under them, alphabetical)' },
        { value: 'workbook', label: 'Build the menu from the site map' + (state.siteMap ? ' (' + state.siteMap.fileName + ')' : ' (load one in step 1)'), disabled: !state.siteMap }
      ], o.menuSource, v => { o.menuSource = v; draw(); }));
      if (o.menuSource === 'workbook') {
        body.appendChild(h('div', 'Rows with no matching D10 page', 'margin:8px 0 2px;font-weight:600;'));
        body.appendChild(radio('si-unmatched', [
          { value: 'empty-page', label: 'Create them as empty pages' },
          { value: 'skip', label: 'Skip them, and everything under them (listed in the match report)' }
        ], o.unmatchedRows, v => { o.unmatchedRows = v; }));
      } else {
        body.appendChild(checkbox('Also create microsites that have no pages', o.includeEmptyMicrosites, v => { o.includeEmptyMicrosites = v; }));
      }

      body.appendChild(heading('Pages'));
      body.appendChild(radio('si-content', [
        { value: 'empty', label: 'Create empty pages (title only)' },
        { value: 'content', label: 'Create pages with their D10 body content' }
      ], o.pageContent, v => { o.pageContent = v; draw(); }));
      if (o.pageContent === 'content') {
        body.appendChild(checkbox('List each page\'s file attachments under a "Documents" heading', o.includeAttachments, v => { o.includeAttachments = v; }));
        body.appendChild(checkbox('Upload the files and images pages link to, and point the links at them', o.uploadMedia, v => { o.uploadMedia = v; }));
        body.appendChild(note('Off: links to files keep pointing at the old site. Downloads come from the old site, so Tampermonkey asks once to allow it.'));
        body.appendChild(checkbox('Turn D10 FAQ sections into accordions (one per question, in the main column)', o.faqAccordions, v => { o.faqAccordions = v; }));
        body.appendChild(note('Streamline only allows link cards in the right column, so FAQs go under the page body.'));
        const row = h('label', '', 'display:block;margin:8px 0;');
        row.appendChild(document.createTextNode('Page URL pattern: '));
        const pat = document.createElement('input'); pat.type = 'text'; pat.value = o.pageUrlPattern === 'auto' ? '' : o.pageUrlPattern; pat.placeholder = 'auto (each page\'s address from the CMS)'; pat.style.cssText = 'width:280px;';
        pat.oninput = () => { o.pageUrlPattern = pat.value.trim() || 'auto'; };
        row.appendChild(pat);
        body.appendChild(row);
        body.appendChild(note('Used for links between imported pages. Leave blank: the tool reads each page\'s address from the CMS. Only set it (e.g. /{slug}) if that fails.'));
      }

      body.appendChild(heading('Right column'));
      body.appendChild(checkbox('Turn D10 "embedded pages" sections into link cards in the right column', o.embeddedPageCards, v => { o.embeddedPageCards = v; }));
      body.appendChild(note('Square cards (Teasers, card layout), titled with the section heading. Cards only link to pages this run imports.'));

      body.appendChild(heading('Module content'));
      body.appendChild(hint('Each entry becomes a page (details, body and attachments), listed as cards on a listing page per module. Meetings, events and people are not imported yet.'));
      const counts = moduleCounts(state.exp);
      for (const t of MODULE_TYPES) {
        const n = counts[t] || 0;
        body.appendChild(checkbox(MODULES[t].label + ' (' + n + ')', o.modules.includes(t), v => { o.modules = v ? o.modules.concat(t) : o.modules.filter(x => x !== t); }, !n));
      }
      body.appendChild(checkbox('Add each module listing page to the primary menu', o.moduleMenu, v => { o.moduleMenu = v; }));
      const tzRow = h('label', '', 'display:block;margin:8px 0;');
      tzRow.appendChild(document.createTextNode('Site time zone: '));
      const tz = document.createElement('input'); tz.type = 'text'; tz.style.cssText = 'width:220px;';
      if (!o.timeZone) { try { o.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { o.timeZone = 'UTC'; } }
      tz.value = o.timeZone;
      tz.oninput = () => { o.timeZone = tz.value.trim(); };
      tzRow.appendChild(tz);
      body.appendChild(tzRow);
      body.appendChild(note('D10 stores job closing and bid due times in UTC; they are shown in this zone, e.g. America/Chicago, America/Los_Angeles.'));

      body.appendChild(heading('Pages that are unpublished in D10'));
      body.appendChild(radio('si-unpub', [
        { value: 'unpublished', label: 'Import them as unpublished' },
        { value: 'published', label: 'Import them as published' }
      ], o.unpublishedSourceAs, v => { o.unpublishedSourceAs = v; }));
      body.appendChild(note('Pages published in D10 are always imported as published.'));

      body.appendChild(heading('News and events'));
      body.appendChild(radio('si-news', [{ value: 'skip', label: 'Skip them (listed in the skipped and out-of-scope reports)' }], 'skip', () => {}));

      body.appendChild(heading('Test run'));
      const limRow = h('label', '', 'display:block;margin:8px 0;');
      limRow.appendChild(document.createTextNode('Only the first '));
      const lim = document.createElement('input'); lim.type = 'number'; lim.min = '0'; lim.value = o.limit || ''; lim.placeholder = 'all'; lim.style.cssText = 'width:70px;margin:0 6px;';
      lim.oninput = () => { o.limit = Math.max(0, parseInt(lim.value, 10) || 0); };
      limRow.appendChild(lim); limRow.appendChild(document.createTextNode(' pages (blank = everything)'));
      body.appendChild(limRow);
    };
    draw();
    const msg = h('div', '', 'margin-top:10px;color:' + RED + ';font-weight:600;');
    panel.appendChild(msg);
    const foot = h('div', '', 'margin-top:12px;');
    foot.appendChild(btn('Next: preview', () => {
      try { rebuildPlan(); } catch (e) { msg.textContent = e.message; return; }
      viewPreview();
    }, true));
    foot.appendChild(btn('Back', viewLoad));
    panel.appendChild(foot);
  }

  // ---- Step 3: Preview (dry run) ----
  function viewPreview() {
    clear();
    title('Preview (dry run, nothing is written)', 'Step 3 of 4 · Check what will be created');
    const p = state.plan, o = p.options, pv = state.preview;
    const tops = p.menu.filter(m => m.level === 1).length;
    const lines = [
      'Will create ' + p.pages.length + ' pages and ' + p.menu.length + ' primary menu items (' + tops + ' at the top level).',
      'Pages imported as unpublished: ' + p.pages.filter(x => x.unpublished).length + '.',
      o.pageContent === 'content'
        ? 'Content: ' + [...pv.byKey.values()].filter(c => !c.empty).length + ' pages get their D10 body' + (o.includeAttachments ? ' and attachments' : '') + '; ' + (p.pages.length - [...pv.byKey.values()].filter(c => !c.empty || c.faqs.length).length) + ' stay empty (no body in D10).'
        : 'All pages are empty (title only).'
    ];
    const lists = p.pages.filter(x => x.sourceType === 'listing');
    if (lists.length) lines.push('Modules: ' + lists.map(l => l.title + ' (' + (l.cards[0] ? l.cards[0].keys.length : 0) + ')').join(', ') + '. Each entry is a page, listed as cards on its listing page' + (o.moduleMenu ? ', which gets a menu item' : '') + '.');
    const cardPages = p.pages.filter(x => x.cards.some(c => c.column === 'gutter'));
    if (cardPages.length) lines.push('Right-column cards: ' + cardPages.reduce((s, x) => s + x.cards.filter(c => c.column === 'gutter').reduce((t, c) => t + c.keys.length, 0), 0) + ' on ' + cardPages.length + ' page(s).');
    if (p.cardIssues.length) lines.push('Embedded-page links that cannot become cards: ' + p.cardIssues.length + ' (see the card report).');
    const faqPages = p.pages.filter(x => x.faqs && x.faqs.length);
    if (faqPages.length) lines.push('FAQ accordions: ' + faqPages.reduce((s, x) => s + x.faqs.length, 0) + ' on ' + faqPages.length + ' page(s): ' + faqPages.slice(0, 5).map(x => x.title + ' (' + x.faqs.length + ')').join(', ') + (faqPages.length > 5 ? ', …' : '') + '.');
    const missingAtt = pv.warnings.filter(w => /attachment-missing/.test(w)).length;
    if (missingAtt) lines.push('Attachments missing from www-media.json: ' + missingAtt + ' (no file to link to; listed in the warnings file).');
    if (p.media.length) lines.push('Media to upload: ' + p.media.length + ' (' + p.media.filter(mid => (state.idx.media.get(mid) || {}).kind === 'image').length + ' images).');
    if (pv.links.length) {
      const by = o2 => pv.links.filter(l => l.outcome === o2).length;
      lines.push('Links in content: ' + pv.links.length + ' · to new pages ' + by('page') + ' · to uploaded media ' + by('media') + ' · left on the old site ' + by('old-site') + ' · external ' + by('external') + ' · email/phone/anchors ' + by('kept') + '.');
    }
    const dropped = pv.warnings.filter(w => !/attachment-missing/.test(w)).length;
    if (dropped) lines.push('Markup dropped from content: ' + dropped + ' item(s) (scripts, iframes, rules…), listed in the warnings file.');
    if (state.match) {
      const c = state.match.counts;
      lines.push('Site map rows: matched by URL ' + c.url + ', by title ' + c.title + ', by override ' + c.override + ' · unmatched ' + c.unmatched + ' · ambiguous ' + c.ambiguous + ' · news/events ' + c.notPage + (c.skipped ? ' · skipped ' + c.skipped : '') + '.');
      lines.push('Menu order follows the site map.');
    } else {
      lines.push('Skipped: ' + state.nav.skipped.length + ' (news, events, Home microsites' + (o.includeEmptyMicrosites ? '' : ', microsites with no pages') + ').');
      lines.push('Menu order is alphabetical: the D10 export has no menu order.');
    }
    if (o.limit) lines.push('Test run: limited to the first ' + o.limit + ' pages.');
    const navWarn = state.nav ? state.nav.warnings : [];
    if (navWarn.length) lines.push('\nWarnings (' + navWarn.length + '):\n• ' + navWarn.slice(0, 6).join('\n• ') + (navWarn.length > 6 ? '\n• … (all in the warnings file)' : ''));
    const m = state.manifest;
    if (m && !man.isEmpty(m)) lines.push('\nA run is recorded in this browser. Running again resumes it: only what is missing is created.');
    panel.appendChild(box()).textContent = lines.join('\n');

    panel.appendChild(heading('Menu tree'));
    const tree = box('font-family:monospace;white-space:pre;max-height:240px;overflow:auto;');
    tree.textContent = outline(p);
    panel.appendChild(tree);

    if (pv.byKey.size) {
      panel.appendChild(heading('Content preview'));
      const sel = document.createElement('select'); sel.style.cssText = 'max-width:100%;';
      const withBody = p.pages.filter(x => pv.byKey.has(x.key) && (!pv.byKey.get(x.key).empty || pv.byKey.get(x.key).faqs.length));
      for (const x of withBody) { const op = document.createElement('option'); op.value = x.key; op.textContent = x.title + ' (nid ' + x.nid + ')' + (x.faqs.length ? ' · ' + x.faqs.length + ' FAQs' : ''); sel.appendChild(op); }
      const view = h('div', null, 'border:1px solid #ddd;border-radius:4px;padding:10px 14px;margin-top:6px;max-height:300px;overflow:auto;font-size:14px;line-height:1.5;');
      // The html is generated by the converter from escaped text, so it is safe to show here.
      // FAQs show as <details> so they open and close the way the accordions will.
      const qEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const show = () => {
        const c = pv.byKey.get(sel.value);
        view.innerHTML = !c ? '' : (c.empty ? '' : c.html) + c.faqs.map(f => '<details style="border:1px solid #2760b0;border-radius:4px;margin:8px 0;padding:6px 10px;"><summary style="cursor:pointer;font-weight:600;color:#2760b0;">' + qEsc(f.question) + '</summary>' + f.html + '</details>').join('');
      };
      sel.onchange = show;
      panel.appendChild(sel); panel.appendChild(view);
      show();
      panel.appendChild(note('Links show as [new page: …] or [uploaded media …] until the run knows the real URLs.'));
    }

    panel.appendChild(heading('Reports'));
    const base = baseName();
    panel.appendChild(btn('Dry-run report (CSV)', () => saveCsv(PLAN_COLUMNS, planReportRows(p, pv.byKey), 'dry-run-' + base + '.csv'), true));
    if (state.match) {
      panel.appendChild(btn('Match report (CSV)', () => saveCsv(MATCH_COLUMNS, state.match.rows, 'match-report-' + base + '.csv')));
      panel.appendChild(btn('Site map skipped rows (CSV)', () => saveCsv(SITEMAP_SKIPPED_COLUMNS, state.siteMap.built.skipped, 'skipped-pages-' + state.siteMap.fileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') + '.csv')));
    } else {
      panel.appendChild(btn('Skipped report (CSV)', () => saveCsv(SKIPPED_COLUMNS, state.nav.skipped, 'skipped-' + base + '.csv')));
    }
    if (pv.links.length) panel.appendChild(btn('Links report (CSV)', () => saveCsv(LINK_COLUMNS, pv.links, 'links-' + base + '.csv')));
    if (p.media.length) {
      const usedBy = new Map();
      for (const l of pv.links) if (l.target && l.target.startsWith('media:')) { const k = l.target.slice(6); usedBy.set(k, (usedBy.get(k) || new Set()).add(l.page)); }
      panel.appendChild(btn('Media report (CSV)', () => saveCsv(MEDIA_COLUMNS, p.media.map(mid => Object.assign({}, state.idx.media.get(mid), { usedBy: [...(usedBy.get(mid) || [])].join(' | ') })), 'media-' + base + '.csv')));
    }
    panel.appendChild(btn('FAQ report (CSV)', () => saveCsv(FAQ_COLUMNS, faqReport(state.exp), 'faqs-' + base + '.csv')));
    if (p.cardIssues.length) panel.appendChild(btn('Card report (CSV)', () => saveCsv(CARD_ISSUE_COLUMNS, p.cardIssues, 'cards-not-made-' + base + '.csv')));
    panel.appendChild(btn('Not imported (CSV)', () => saveCsv(OUT_OF_SCOPE_COLUMNS, outOfScopeReport(state.exp), 'not-imported-' + base + '.csv')));
    panel.appendChild(btn('Warnings (TXT)', () => saveFile(navWarn.concat(state.exp.warnings, pv.warnings).join('\r\n'), 'warnings-' + base + '.txt', 'text/plain;charset=utf-8')));

    const foot = h('div', '', 'margin-top:14px;');
    foot.appendChild(btn('Next: run', viewConfirm, true));
    foot.appendChild(btn('Back', viewOptions));
    panel.appendChild(foot);
  }

  // ---- Step 4: Confirm and run ----
  function viewConfirm() {
    clear();
    title('Confirm', 'Step 4 of 4 · This changes the CMS on ' + location.host);
    panel.appendChild(siteBanner());
    const p = state.plan, o = p.options;
    const steps = [
      'Create ' + p.pages.length + ' pages (InteriorStandard layout)',
      'Create ' + p.menu.length + ' primary menu items linked to those pages'
    ];
    if (p.media.length) steps.push('Download ' + p.media.length + ' files and images from the old site and upload them');
    if (o.pageContent === 'content' || o.modules.length) steps.push('Write each page\'s converted content, with links pointing at the new pages and media');
    const cardSecs = p.pages.reduce((n, x) => n + x.cards.length, 0);
    if (cardSecs) steps.push('Add ' + cardSecs + ' sections of link cards (module listing pages and right-column cards)');
    steps.push('Promote each page\'s draft');
    const ul = h('ul');
    steps.forEach(t => ul.appendChild(h('li', t)));
    panel.appendChild(ul);
    panel.appendChild(h('p', 'Existing menu items and pages are left alone. Everything created is recorded in a manifest (saved in this browser after every step) so the run can be resumed or undone.', 'font-size:13px;color:#555;'));
    const foot = h('div', '', 'margin-top:14px;');
    const go = btn('Confirm and run', () => viewProgress('run'), true);
    if (!isSandbox()) {
      // Live site: the button stays off until the site's address is typed.
      const row = h('label', '', 'display:block;margin:10px 0 0;font-size:13px;');
      row.appendChild(document.createTextNode('Type ' + location.host + ' to confirm: '));
      const typed = document.createElement('input'); typed.type = 'text'; typed.style.cssText = 'width:300px;';
      const sync = () => { const ok = typed.value.trim().toLowerCase() === location.host.toLowerCase(); go.disabled = !ok; go.style.opacity = ok ? '1' : '.4'; };
      typed.oninput = sync;
      row.appendChild(typed);
      panel.appendChild(row);
      sync();
    }
    foot.appendChild(go);
    foot.appendChild(btn('Back', viewPreview));
    panel.appendChild(foot);
  }

  // ---- Progress (run, undo, remove all) ----
  function viewProgress(kind, wipeOpts) {
    clear();
    title(kind === 'run' ? 'Running' : kind === 'undo' ? 'Undoing' : kind === 'wipe' ? 'Erasing ' + location.host : 'Removing all primary items');
    const logBox = box('font:13px/1.5 monospace;white-space:pre-wrap;max-height:360px;overflow:auto;');
    panel.appendChild(logBox);
    const log = msg => { logBox.textContent += msg + '\n'; logBox.scrollTop = logBox.scrollHeight; console.log('[Importer] ' + msg); };
    let stop = false;
    const stopBtn = btn('Stop after the current step', () => { stop = true; stopBtn.disabled = true; log('Stopping…'); });
    panel.appendChild(stopBtn);
    const foot = h('div', '', 'margin-top:14px;display:none;');
    panel.appendChild(foot);

    const a = api(log);
    const save = m => { storeManifest(m); };
    const done = ok => {
      stopBtn.remove();
      foot.style.display = 'block';
      foot.appendChild(h('p', ok ? 'Done. Refresh the CMS to see the changes.' : 'Stopped. Nothing is lost: resume or undo from "Resume, undo, other actions".', 'margin:0 0 6px;font-weight:600;'));
      if (state.manifest && !man.isEmpty(state.manifest)) foot.appendChild(btn('Download manifest', () => saveFile(JSON.stringify(state.manifest, null, 2), 'manifest-' + location.host + '-' + stamp() + '.json')));
      if (state.errors.length) foot.appendChild(btn('Download error log', () => saveFile(JSON.stringify(state.errors, null, 2), 'error-log-' + stamp() + '.json')));
      foot.appendChild(btn('Refresh CMS', () => location.reload(), true));
      foot.appendChild(btn('Close', close));
    };
    const fail = e => {
      if (e instanceof StopRequested) { log('■ Stopped by you.'); return done(false); }
      log('✗ ' + e.message);
      if (e instanceof ApiError) {
        state.errors.push({ at: new Date().toISOString(), message: e.message, detail: e.detail });
        log('Full request and response:\n' + JSON.stringify(e.detail, null, 2).slice(0, 4000));
        console.error('[Importer]', e.message, e.detail);
      } else console.error('[Importer]', e);
      done(false);
    };

    state.errors = [];
    if (kind === 'run') {
      if (!state.manifest || man.isEmpty(state.manifest)) {
        state.manifest = man.newManifest({ host: location.host, source: { label: state.sourceLabel, counts: state.exp.counts, siteMap: state.siteMap ? state.siteMap.fileName : null } });
      }
      log('Source: ' + state.sourceLabel + (state.siteMap && state.options.menuSource === 'workbook' ? ' + ' + state.siteMap.fileName : '') + ' · run ' + state.manifest.runId);
      runPlan(state.plan, { api: a, manifest: state.manifest, save, log, shouldStop: () => stop, idx: state.idx, download: platform.download })
        .then(s => {
          const fails = Object.keys(state.manifest.mediaFailures || {}).length, dup = (state.manifest.possibleDuplicates || []).length;
          log('✓ Finished: ' + s.pages + ' pages, ' + s.menuItems + ' menu items, ' + s.media + ' media' + (fails ? ' (' + fails + ' media could not be downloaded; see the manifest)' : '') + (dup ? ' · ' + dup + ' possible duplicate page(s) flagged above' : ''));
          done(true);
        }, fail);
    } else if (kind === 'undo') {
      undoRun({ api: a, manifest: state.manifest, save, log })
        .then(() => { clearStoredManifest(); log('✓ Removed everything this run created'); done(true); }, fail);
    } else if (kind === 'removeAll') {
      removeAllMenuItems(a, 'primary', snap => saveFile(JSON.stringify(snap, null, 2), 'snapshot-primary-' + stamp() + '.json'), log)
        .then(() => { log('✓ Primary menu is empty'); done(true); }, fail);
    } else if (kind === 'wipe') {
      wipeSite(a, wipeOpts, { log, shouldStop: () => stop, host: location.host, snapshot: snap => saveFile(JSON.stringify(snap, null, 2), 'erase-snapshot-' + location.host.replace(/[^\w.-]+/g, '_') + '-' + stamp() + '.json') })
        .then(s => {
          // Everything a recorded run made is gone too, so its manifest no longer means anything here.
          clearStoredManifest(); state.manifest = null;
          log('✓ Erased: ' + s.menuItems + ' menu items, ' + s.pages + ' pages' + (wipeOpts.media ? ', ' + s.files + ' files, ' + s.images + ' images' : '') + '. The homepage stays.');
          done(true);
        }, fail);
    }
  }

  // ---- Resume, undo, manifest, schema, remove all ----
  // opts.erase: open the "Erase this site" box and scroll to it (the first screen's Erase button).
  function viewManage(opts) {
    clear();
    title('Resume, undo, other actions');
    const status = box();
    status.textContent = 'Checking…';
    statusText().then(t => { status.textContent = t; });
    panel.appendChild(status);
    const msg = h('div', '', 'margin-top:8px;color:' + RED + ';font-weight:600;white-space:pre-line;');

    panel.appendChild(heading('Manifest'));
    panel.appendChild(hint('The manifest lists every page, menu item and media file a run created. It is saved in this browser automatically. Download it to keep a copy, or load one to resume or undo a run from another browser.'));
    const up = filePicker('.json', false, false, async list => {
      try {
        const m = man.parseManifest(await list[0].text(), location.host);
        if (state.manifest && !man.isEmpty(state.manifest) && !confirm('Replace the run recorded in this browser with the loaded manifest?')) return;
        state.manifest = m; storeManifest(m);
        if (m.options) Object.assign(state.options, m.options);
        viewManage();
      } catch (e) { msg.textContent = 'Could not use that manifest: ' + e.message; }
    });
    panel.appendChild(up);
    if (state.manifest) panel.appendChild(btn('Download manifest', () => saveFile(JSON.stringify(state.manifest, null, 2), 'manifest-' + location.host + '-' + stamp() + '.json')));
    panel.appendChild(btn('Load a manifest', () => up.click()));

    panel.appendChild(heading('Resume'));
    panel.appendChild(hint('Load the same export (and site map) and run again with the same options: only what is missing gets created.'));

    panel.appendChild(heading('Undo'));
    const hasRun = state.manifest && !man.isEmpty(state.manifest);
    panel.appendChild(hint(hasRun ? 'Removes the menu items, pages and uploaded media listed in the manifest, and nothing else.' : 'No run recorded, so there is nothing to undo.'));
    if (hasRun) panel.appendChild(btn('Undo this run', () => {
      const s = man.summary(state.manifest);
      if (confirmChange('Remove ' + s.menuItems + ' menu items, ' + s.pages + ' pages and ' + s.media + ' media created by this run?')) viewProgress('undo');
    }, true));

    panel.appendChild(heading('Developer'));
    panel.appendChild(hint('Reads the CMS API schema (read-only, nothing changes) and saves schema.graphql and schema-check.txt. Put both in the repo\'s docs folder.'));
    const schemaBtn = btn('Download API schema', async () => {
      schemaBtn.disabled = true; msg.textContent = 'Reading the schema…';
      try {
        const client = makeClient(browserTransport(), { host: location.host });
        const s = (await client.gql(INTROSPECTION)).__schema;
        saveFile(toSdl(s), 'schema.graphql', 'text/plain;charset=utf-8');
        saveFile(checkSchema(s), 'schema-check.txt', 'text/plain;charset=utf-8');
        msg.textContent = 'Saved schema.graphql and schema-check.txt (' + s.types.length + ' types).';
      } catch (e) {
        msg.textContent = 'Could not read the schema: ' + e.message;
        console.error('[Importer]', e.message, e.detail);
      }
      schemaBtn.disabled = false;
    });
    panel.appendChild(schemaBtn);

    const details = h('details', null, 'margin-top:14px;border:1px solid #e0b4b4;border-radius:4px;padding:8px 10px;');
    details.appendChild(h('summary', 'Advanced: remove ALL primary menu items', 'cursor:pointer;font-weight:600;color:' + RED + ';'));
    details.appendChild(h('p', 'Removes every item in the primary menu, including the site\'s own items. Pages are not deleted. A snapshot downloads first.', 'margin:8px 0 0;color:' + RED + ';'));
    details.appendChild(btn('Remove ALL primary items', () => { if (confirmChange('Remove every item in the primary menu of ' + location.host + '?')) viewProgress('removeAll'); }));
    panel.appendChild(details);

    // Erase this site: for clearing a test site between imports.
    const erase = h('details', null, 'margin-top:14px;border:2px solid ' + RED + ';border-radius:4px;padding:8px 10px;');
    erase.appendChild(h('summary', 'Erase this site (for test sites)', 'cursor:pointer;font-weight:700;color:' + RED + ';'));
    erase.appendChild(h('p', 'Deletes every menu item in every menu and every page on ' + location.host + ' (events, meetings and groups too), whoever made them. The homepage, forms, users and settings stay. A list of everything it deletes downloads first. Deleted pages cannot be brought back.', 'margin:8px 0;color:' + RED + ';'));
    const wipeMedia = checkbox('Also delete every uploaded file and image (site design images such as the header and homepage photos live there too)', false, () => {});
    erase.appendChild(wipeMedia);
    const wRow = h('label', '', 'display:block;margin:8px 0;font-size:13px;');
    const phrase = 'WIPE ' + location.host;
    wRow.appendChild(document.createTextNode('Type ' + phrase + ' to confirm: '));
    const wType = document.createElement('input'); wType.type = 'text'; wType.style.cssText = 'width:320px;';
    wRow.appendChild(wType);
    erase.appendChild(wRow);
    const wBtn = btn('Erase this site', () => {
      if (wType.value.trim() !== phrase) return;
      viewProgress('wipe', { media: wipeMedia.querySelector('input').checked });
    }, true);
    const wSync = () => { const ok = wType.value.trim() === phrase; wBtn.disabled = !ok; wBtn.style.opacity = ok ? '1' : '.4'; };
    wType.oninput = wSync; wSync();
    erase.appendChild(wBtn);
    panel.appendChild(erase);
    if (opts && opts.erase) { erase.open = true; setTimeout(() => { erase.scrollIntoView({ block: 'center' }); wType.focus(); }, 0); }

    panel.appendChild(msg);
    const foot = h('div', '', 'margin-top:14px;');
    foot.appendChild(btn('Back', viewLoad));
    foot.appendChild(btn('Close', close));
    panel.appendChild(foot);
  }

  viewLoad();
}

// platform: { download(url) -> Promise<Blob>, storagePut(url, blob, type) -> Promise<status> }, from main.js.
function setPlatform(p) { platform = p || {}; }

module.exports = { openPanel, setPlatform };

  }
  };
  const cache = {};
  // Resolves "./x", "../lib/y" relative to the requiring module, the way node does.
  function load(name) {
    if (cache[name]) return cache[name].exports;
    if (!defs[name]) throw new Error('Importer bundle: no module ' + name);
    const module = cache[name] = { exports: {} };
    const dir = name.split('/').slice(0, -1);
    defs[name](module, module.exports, rel => {
      const parts = dir.slice();
      for (const seg of rel.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
      return load(parts.join('/'));
    });
    return module.exports;
  }
  load('main').start("0.7.0");
})();
