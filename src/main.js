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
