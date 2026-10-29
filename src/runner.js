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
  for (const mnu of menus) {
    for (let pass = 0; pass < 4; pass++) {
      const live = await api.menuItems(mnu.id);
      if (!live.length) break;
      const byId = new Map(live.map(i => [String(i.id), i]));
      const depth = i => { let d = 0, p = i.parent_id; while (p != null && byId.has(String(p)) && d < 20) { d++; p = byId.get(String(p)).parent_id; } return d; };
      for (const it of live.sort((a, b) => depth(b) - depth(a))) { check(); await api.softDeleteMenuItem(it); }
    }
    const left = await api.menuItems(mnu.id);
    if (left.length) throw new Error(left.length + ' item(s) still in the ' + mnu.name + ' menu: ' + left.slice(0, 5).map(i => i.title).join(', '));
  }
  log('  menus cleared');

  let n = 0;
  for (const p of pocs) {
    check();
    await api.deletePage(p.id);
    if (++n % 25 === 0) log('  … ' + n + ' / ' + pocs.length + ' pages');
  }
  log('  ' + n + ' page(s) deleted');

  if (opts.media) {
    let f = 0, im = 0;
    for (const x of files) { check(); await api.deleteMedia('file', x.id).catch(e => { if (!/not found|could not find|couldn.t find/i.test(e.message)) throw e; }); if (++f % 25 === 0) log('  … ' + f + ' / ' + files.length + ' files'); }
    for (const x of images) { check(); await api.deleteMedia('image', x.id).catch(e => { if (!/not found|could not find|couldn.t find/i.test(e.message)) throw e; }); if (++im % 25 === 0) log('  … ' + im + ' / ' + images.length + ' images'); }
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
