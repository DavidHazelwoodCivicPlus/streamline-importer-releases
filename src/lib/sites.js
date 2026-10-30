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
