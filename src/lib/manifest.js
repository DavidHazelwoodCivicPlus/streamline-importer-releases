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
