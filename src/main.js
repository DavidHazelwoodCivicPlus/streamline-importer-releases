'use strict';
// Userscript entry. The script is matched on every https page, so it first checks that the page is a
// Streamline CMS admin page (the CMS dock), and does nothing anywhere else.

const { openPanel, setPlatform } = require('./ui/panel');
const { makeDockItem } = require('./ui/dock');

/* global GM_xmlhttpRequest */
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

setPlatform({ download, storagePut });

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

// Streamline admin pages carry a <dock> element (the CMS dock). A login cookie alone is not enough: many sites set XSRF-TOKEN.
const onSpecialDistrict = () => /(^|\.)specialdistrict\.org$/i.test(location.hostname);
const looksLikeStreamline = () => !!document.querySelector('dock') || (onSpecialDistrict() && /XSRF-TOKEN=/.test(document.cookie));

function addFloatingButton() {
  if (document.getElementById('si-open')) return;
  if (!looksLikeStreamline()) return;
  document.body.appendChild(makeButton(FLOAT_CSS, true));
  console.warn(LOG + '#dock-menu not found; showing a floating button instead.');
}

// The CMS can redraw its dock (navigating between admin screens); put the item back when that happens.
function keepInDock() {
  setInterval(() => { if (!document.getElementById('si-open')) addButton(); }, 3000);
}

function start(version) {
  if (window.top !== window.self) return; // not inside frames
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (addButton()) { clearInterval(timer); console.log(LOG + 'v' + version + ' ready on ' + location.host); keepInDock(); return; }
    if (tries === 10) addFloatingButton();
    // Not a Streamline page after 30 seconds: stop looking. A Streamline page keeps waiting for a late dock, up to 5 minutes.
    if ((tries >= 30 && !looksLikeStreamline()) || tries >= 300) clearInterval(timer);
  }, 1000);
}

module.exports = { start };
