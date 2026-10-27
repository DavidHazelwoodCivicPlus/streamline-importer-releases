'use strict';
// Runs a plan against the CMS in resumable phases, and undoes a run, both from the manifest.
//   pages   - create each page (title, layout, publish state)
//   menu    - create menu items top-down, linked to their pages (poc_id), in plan order
//   media   - upload the files and images the pages link to (content mode, optional)
//   content - write each page's converted body, with /node and /media links pointing at the new site
//   promote - promote each page's draft
// Every create is written to the manifest and saved before the next request, so a run that stops
// at any point can be resumed or undone. Running the same plan again only does what is missing.

const man = require('./lib/manifest');
const { INTERIOR_STANDARD_LAYOUT_ID } = require('./api/streamline');
const { RUN_LOCKED } = require('./lib/plan');
const { buildPageContent } = require('./lib/content');

class StopRequested extends Error { constructor() { super('Stopped by user'); this.name = 'StopRequested'; } }

// ctx: { api, manifest, save(manifest), log(msg), shouldStop(), idx (links.buildLinkIndex), download(url) -> Blob }
async function runPlan(plan, ctx) {
  const { api, manifest: m, log } = ctx;
  const save = () => ctx.save(m);
  const check = () => { if (ctx.shouldStop && ctx.shouldStop()) throw new StopRequested(); };
  if (m.startedAt && m.options) {
    const changed = RUN_LOCKED.filter(k => m.options[k] !== undefined && m.options[k] !== plan.options[k]);
    if (changed.length) throw new Error('This run was started with different options (' + changed.join(', ') + '). Use the same options to resume, or undo the run first.');
  }
  m.options = plan.options;
  const media = plan.media || [];
  const hasContent = plan.pages.some(p => p.content === 'content');
  const phases = ['pages', 'menu items'].concat(media.length ? ['media'] : [], hasContent ? ['content'] : [], ['promote drafts']);
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
  const pattern = await resolvePageUrlPattern(api, m, plan.options, log);
  save();
  const lookups = {
    pageUrl: key => (m.pages[key] && m.pages[key].slug != null ? pattern.replace('{slug}', m.pages[key].slug) : null),
    media: mid => (m.media[mid] ? { url: m.media[mid].url, id: m.media[mid].streamlineId, altText: m.media[mid].altText } : null)
  };
  let written = 0, empty = 0;
  for (const p of plan.pages) {
    check();
    const rec = m.pages[p.key];
    if (p.content !== 'content' || man.pageStageAtLeast(rec, 'content')) continue;
    const c = buildPageContent(p, idx, lookups, { includeAttachments: plan.options.includeAttachments });
    if (c.empty) { man.setPageStage(m, p.key, 'content', { contentEmpty: true }); save(); empty++; continue; }
    let sectionId = rec.sectionId;
    if (!sectionId) {
      const cols = await api.draftColumns(rec.streamlineId);
      const main = cols.find(col => col.columnType === 'main');
      if (!main) throw new Error('Page "' + p.title + '" has no main column (columns: ' + cols.map(col => col.columnType).join(', ') + ')');
      sectionId = await api.addSection(rec.streamlineId, 'Freeform', main.id, 1);
      man.setPageStage(m, p.key, 'section', { sectionId });
      save();
    }
    await api.setFreeform(sectionId, c.html, c.json);
    const oldSite = c.links.filter(l => l.outcome === 'old-site').length;
    man.setPageStage(m, p.key, 'content', { contentWarnings: c.warnings.length, linksToOldSite: oldSite });
    save();
    written++;
    if (written % 25 === 0) log('  … ' + written + ' pages written');
  }
  log('  ' + written + ' written, ' + empty + ' had no body');
}

// Page URLs on the new site come from the slug, but the schema has no public URL field. With 'auto', the pattern
// is worked out by opening existing published pages under each candidate pattern and checking for their title.
const URL_PATTERNS = ['/{slug}', '/page/{slug}', '/pages/{slug}'];
async function resolvePageUrlPattern(api, m, options, log) {
  if (m.pageUrlPattern) return m.pageUrlPattern;
  if (options.pageUrlPattern && options.pageUrlPattern !== 'auto') {
    m.pageUrlPattern = options.pageUrlPattern;
    log('Page URLs: ' + m.pageUrlPattern + ' (from options)');
    return m.pageUrlPattern;
  }
  const ours = new Set(Object.values(m.pages).map(r => String(r.streamlineId)));
  const samples = (await api.listPages())
    .filter(p => !p.unpublished && p.slug && p.activePageVersion && !ours.has(String(p.id)) && /[a-z]{3}/i.test(p.amplifyTitle || ''))
    .slice(0, 3);
  const unescape = s => s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"');
  for (const pat of URL_PATTERNS) {
    for (const s of samples) {
      const r = await api.probe(pat.replace('{slug}', s.slug));
      if (r.status === 200 && unescape(r.text).toLowerCase().includes(String(s.amplifyTitle).toLowerCase())) {
        m.pageUrlPattern = pat;
        log('Page URLs: ' + pat + ' (checked against "' + s.amplifyTitle + '")');
        return pat;
      }
    }
  }
  throw new Error('Could not work out how page URLs look on this site' +
    (samples.length ? ' (tried ' + URL_PATTERNS.join(', ') + ' on ' + samples.map(s => '"' + s.amplifyTitle + '"').join(', ') + ')' : ' (no published pages to check against)') +
    '. Set "Page URL pattern" in Options, e.g. /{slug}.');
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

module.exports = { runPlan, undoRun, removeAllMenuItems, StopRequested };
