'use strict';
// The importer wizard: 1 Load, 2 Options, 3 Preview (dry run, no writes), 4 Run.
// Plus resume, undo, the API schema download, and the advanced "remove ALL primary items" from user6.

const d10 = require('../lib/d10');
const { buildNavFromD10, limitTree } = require('../lib/navFromD10');
const { buildPlan, planReportRows, outline, DEFAULT_OPTIONS } = require('../lib/plan');
const { toCsv, PLAN_COLUMNS, SKIPPED_COLUMNS, LINK_COLUMNS, MEDIA_COLUMNS } = require('../lib/csv');
const { buildLinkIndex } = require('../lib/links');
const { buildPageContent, placeholderLookups } = require('../lib/content');
const { readSiteMap } = require('../lib/sitemap');
const { matchSiteMap, parseOverrides, MATCH_COLUMNS } = require('../lib/match');
const { faqReport, FAQ_COLUMNS, outOfScopeReport, OUT_OF_SCOPE_COLUMNS } = require('../lib/reports');
const man = require('../lib/manifest');
const { makeClient, browserTransport, ApiError, SANDBOX_HOST } = require('../api/client');
const { streamlineApi } = require('../api/streamline');
const { runPlan, undoRun, removeAllMenuItems, StopRequested } = require('../runner');
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
  state.plan = buildPlan(limitTree(tree, state.options.limit), state.options, state.idx);
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

// SheetJS is loaded by the userscript's @require. Columns stay aligned to A even when the used range starts later.
async function readWorkbook(file) {
  if (typeof XLSX === 'undefined') throw new Error('The spreadsheet reader (SheetJS) did not load. Check that Tampermonkey is allowed to fetch @require scripts.');
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
    foot.appendChild(btn('Resume, undo, other actions', viewManage));
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
    if (o.pageContent === 'content') steps.push('Write each page\'s converted content, with links pointing at the new pages and media');
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
  function viewProgress(kind) {
    clear();
    title(kind === 'run' ? 'Running' : kind === 'undo' ? 'Undoing' : 'Removing all primary items');
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
    }
  }

  // ---- Resume, undo, manifest, schema, remove all ----
  function viewManage() {
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
