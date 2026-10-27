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
