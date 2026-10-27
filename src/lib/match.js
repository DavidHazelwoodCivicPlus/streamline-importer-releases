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
