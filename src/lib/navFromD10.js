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
    if (p.kind !== 'page') { skip(p, p.kind === 'news' ? 'News item (modules are out of scope)' : 'Event (modules are out of scope)'); continue; }
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
