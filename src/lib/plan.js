'use strict';
// Turns a menu tree (plus the module types chosen) into the exact list of things a run will create,
// and the dry-run report. Pure: the same input always gives the same plan, so resume can match work
// to the manifest by key.

const { referencedMedia } = require('./links');
const { MODULES, moduleEntries } = require('./modules');

const DEFAULT_OPTIONS = Object.freeze({
  menuSource: 'd10',            // 'd10' | 'workbook'
  pageContent: 'empty',         // 'empty' | 'content' (D10 body converted to freeform content)
  unpublishedSourceAs: 'unpublished', // how to import pages that are unpublished in D10: 'unpublished' | 'published'
  newsEvents: 'skip',           // news and events never become menu pages (news can be imported as a module)
  includeEmptyMicrosites: false,
  includeAttachments: true,     // content mode: list a page's file attachments under a "Documents" heading
  faqAccordions: true,          // content mode: a page's D10 FAQ sections become one accordion per question in the main column
  uploadMedia: true,            // upload the files and images pages link to, and point links at them
  pageUrlPattern: 'auto',       // page addresses for links between pages: 'auto' = each page's url from the CMS, or a pattern like /{slug}
  unmatchedRows: 'empty-page',  // workbook mode: rows with no D10 match become 'empty-page' | 'skip'
  embeddedPageCards: true,      // D10 "embedded pages" sections become link cards in the page's right column
  modules: [],                  // module types to import as pages (see lib/modules.js), e.g. ['news', 'jobs']
  moduleMenu: true,             // add each module's listing page to the primary menu
  timeZone: '',                 // the site's time zone for module date-times (D10 stores them in UTC)
  limit: 0                      // 0 = all pages; otherwise a small test run
});

// Options that must stay the same for the whole of a run (resume rebuilds the same plan).
const RUN_LOCKED = ['menuSource', 'pageContent', 'unpublishedSourceAs', 'includeAttachments', 'uploadMedia', 'unmatchedRows', 'faqAccordions',
  'embeddedPageCards', 'modules', 'moduleMenu', 'timeZone'];
const sameOption = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function normalizeOptions(o) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, o || {});
  if (!['d10', 'workbook'].includes(opts.menuSource)) throw new Error('Unknown menu source "' + opts.menuSource + '"');
  if (!['empty', 'content'].includes(opts.pageContent)) throw new Error('Unknown page content "' + opts.pageContent + '"');
  if (!['unpublished', 'published'].includes(opts.unpublishedSourceAs)) throw new Error('Bad unpublishedSourceAs: ' + opts.unpublishedSourceAs);
  if (opts.newsEvents !== 'skip') throw new Error('News and events can only be skipped for now');
  if (opts.pageUrlPattern !== 'auto' && !/\{slug\}/.test(opts.pageUrlPattern)) throw new Error('Page URL pattern must contain {slug}, e.g. /{slug}');
  opts.limit = Math.max(0, parseInt(opts.limit, 10) || 0);
  for (const k of ['includeEmptyMicrosites', 'includeAttachments', 'uploadMedia', 'faqAccordions', 'embeddedPageCards', 'moduleMenu']) opts[k] = !!opts[k];
  opts.modules = [...new Set(opts.modules || [])];
  for (const t of opts.modules) if (!MODULES[t]) throw new Error('Unknown module type "' + t + '"');
  opts.modules.sort((a, b) => Object.keys(MODULES).indexOf(a) - Object.keys(MODULES).indexOf(b));
  if (opts.pageContent === 'empty') opts.faqAccordions = false;
  // Module entries always get their content, so uploads stay possible in empty mode when modules are chosen.
  if (opts.pageContent === 'empty' && !opts.modules.length) opts.uploadMedia = false;
  return opts;
}

// tree: [{ key, sourceType, source, title, children }] from navFromD10 or the workbook matcher.
// source is the D10 page/microsite summary, or null for a workbook row with no D10 match (an empty page).
// idx: links.buildLinkIndex(exp), needed for media, FAQs and cards. exp: the loaded export, needed for modules.
// Returns { options, pages, menu, media, cardIssues }.
//   pages: one per distinct page key, parents first. Two menu items may point at the same page.
//          page.cards: [{ column: 'main'|'gutter', title, keys, orderBy, perPage }] = Teaser sections of link cards.
//   menu:  one per menu item; parentKey is another menu item's key, weight = sibling order.
//   media: media ids to upload.
//   cardIssues: embedded-pages links that cannot become cards, with the reason.
function buildPlan(tree, options, idx, exp) {
  const opts = normalizeOptions(options);
  const pages = [], menu = [], seen = new Set(), media = [], cardIssues = [];
  const addMedia = page => {
    if (!opts.uploadMedia || !idx || page.content !== 'content') return;
    const html = page.bodyHtml + page.faqs.map(q => q.answerHtml).join('');
    for (const mid of referencedMedia(idx, html, page.attachments)) if (!media.includes(mid)) media.push(mid);
  };

  const walk = (nodes, parentMenuKey, path) => {
    nodes.forEach((n, i) => {
      const src = n.source;
      if (!seen.has(n.key)) {
        seen.add(n.key);
        const published = src ? src.published : true;
        const withContent = opts.pageContent === 'content' && !!src;
        const page = {
          key: n.key, title: n.title, sourceType: n.sourceType, nid: src ? src.nid : '', alias: src ? src.alias : '',
          sourcePublished: published, unpublished: !published && opts.unpublishedSourceAs === 'unpublished',
          content: withContent ? 'content' : 'empty', hasBody: !!(src && src.hasBody), notes: (src && src.notes) || [],
          bodyHtml: withContent ? src.bodyHtml : '', attachments: withContent && opts.includeAttachments ? (src.attachments || []) : [],
          faqs: withContent && opts.faqAccordions ? faqsFor(src, idx) : [],
          cards: [], embedded: (opts.embeddedPageCards && src && src.embeddedPages) || [],
          row: n.row || null
        };
        pages.push(page);
        addMedia(page);
      }
      const menuKey = 'menu:' + (n.menuKey || n.key);
      menu.push({ key: menuKey, pageKey: n.key, parentKey: parentMenuKey, weight: i, title: n.title, level: path.length + 1, path: path.join(' > '), row: n.row || null });
      if (n.children && n.children.length) walk(n.children, menuKey, path.concat(n.title));
    });
  };
  walk(tree, null, []);

  // Modules: a listing page per type (cards for every entry) and a page per entry.
  let topWeight = tree.length;
  for (const type of opts.modules) {
    if (!exp) throw new Error('Module import needs the export');
    const def = MODULES[type];
    const all = moduleEntries(exp, type, { timeZone: opts.timeZone || 'UTC' });
    const entries = opts.limit ? all.slice(0, opts.limit) : all; // a test run takes the first few of each module
    const listKey = 'list:' + type;
    pages.push({
      key: listKey, title: def.label, sourceType: 'listing', nid: '', alias: '', sourcePublished: true, unpublished: false,
      content: 'empty', hasBody: false, notes: [], bodyHtml: '', attachments: [], faqs: [], embedded: [], row: null, moduleType: type,
      // Always manual: with any other order the CMS does not show the cards added to the section (sandbox,
      // 2026-10-29). The entries are already in the module's order (A-Z, news newest first).
      cards: entries.length ? [{ column: 'main', title: '', keys: entries.map(e => e.key), orderBy: 'manual', perPage: 12 }] : []
    });
    if (opts.moduleMenu) menu.push({ key: 'menu:' + listKey, pageKey: listKey, parentKey: null, weight: topWeight++, title: def.label, level: 1, path: '', row: null });
    for (const e of entries) {
      const page = {
        key: e.key, title: e.title, sourceType: type, nid: e.nid, alias: e.alias, sourcePublished: e.published,
        unpublished: !e.published && opts.unpublishedSourceAs === 'unpublished', content: 'content', hasBody: !!e.bodyHtml.trim(),
        notes: e.notes, bodyHtml: e.bodyHtml, attachments: opts.includeAttachments ? e.attachments : [], faqs: [], cards: [], embedded: [],
        row: null, moduleType: type, listKey, publishedAt: e.publishedAt
      };
      pages.push(page);
      addMedia(page);
    }
  }

  // Right-column cards from D10 "embedded pages" sections, now that every page key is known.
  const keys = new Set(pages.map(p => p.key));
  const keyOf = nid => { const n = idx && idx.nodes.get(nid); return !n ? null : (n.kind === 'news' ? 'news:' : n.sourceType + ':') + nid; };
  for (const p of pages) {
    for (const sec of p.embedded) {
      const found = [];
      for (const nid of sec.nids) {
        const k = keyOf(nid);
        if (k && keys.has(k)) { if (!found.includes(k)) found.push(k); continue; }
        const n = idx && idx.nodes.get(nid);
        cardIssues.push({ page: p.title, nid: p.nid, section: sec.header, target: nid, targetTitle: n ? n.title : '',
          reason: !n ? 'not in the export' : n.kind === 'news' || MODULES[n.kind] ? n.kind + ' item; select that module to import it' : 'that page is not imported' });
      }
      if (!sec.nids.length) cardIssues.push({ page: p.title, nid: p.nid, section: sec.header, target: '', targetTitle: '', reason: 'section lists no pages' });
      if (found.length) p.cards.push({ column: 'gutter', title: sec.header, keys: found, orderBy: 'manual', perPage: Math.max(found.length, 3) });
    }
    delete p.embedded;
  }
  return { options: opts, pages, menu, media, cardIssues };
}

// The published FAQs a page's D10 FAQ sections show, section by section, each in D10 order.
function faqsFor(src, idx) {
  const out = [];
  for (const sec of src.faqSections || []) {
    const list = (idx && idx.faqCategories.get(sec.categoryId)) || [];
    for (const f of list) if (f.published) out.push({ nid: f.nid, question: f.question, answerHtml: f.answerHtml, categoryId: sec.categoryId });
  }
  return out;
}

function bodyLabel(p) {
  if (p.sourceType === 'listing') return 'cards for ' + (p.cards[0] ? p.cards[0].keys.length : 0) + ' entries';
  if (p.content === 'content') return p.hasBody || p.attachments.length || p.faqs.length ? 'converted' : 'empty (no D10 body)';
  if (!p.nid) return 'empty (no D10 match)';
  return p.hasBody ? 'empty (D10 body not imported)' : 'empty';
}

// One row per planned page, menu items first (in menu order), then pages with no menu item (module entries).
// contentByKey (optional): page key -> { warnings, links } from the dry-run conversion.
function planReportRows(plan, contentByKey) {
  const pageByKey = new Map(plan.pages.map(p => [p.key, p]));
  const row = (p, m) => {
    const c = contentByKey && contentByKey.get(p.key);
    const count = o => c ? c.links.filter(l => l.outcome === o).length : '';
    const list = p.listKey ? pageByKey.get(p.listKey) : null;
    return {
      level: m ? m.level : '', menuPath: m ? m.path : (list ? 'listed on ' + list.title : ''), title: p.title, order: m ? m.weight + 1 : '', row: m && m.row ? m.row : '',
      sourceType: p.sourceType, nid: p.nid, oldUrl: p.alias,
      d10Published: p.nid ? (p.sourcePublished ? 'yes' : 'no') : '', importAs: p.unpublished ? 'unpublished' : 'published',
      body: bodyLabel(p), attachments: p.attachments.length || '', faqs: p.faqs.length || '',
      cards: p.cards.filter(x => x.column === 'gutter').reduce((s, x) => s + x.keys.length, 0) || '',
      linksToPages: count('page'), linksToMedia: count('media'), linksToOldSite: count('old-site'),
      dropped: c ? c.warnings.map(w => w.code).join(' ') : '',
      notes: p.notes.filter(n => p.content !== 'content' || !/attachments/i.test(n) || !p.attachments.length).join('; ')
    };
  };
  const inMenu = new Set(plan.menu.map(m => m.pageKey));
  return plan.menu.map(m => row(pageByKey.get(m.pageKey), m)).concat(plan.pages.filter(p => !inMenu.has(p.key)).map(p => row(p, null)));
}

// Plain-text outline of the tree for the preview pane.
function outline(plan, max) {
  const lines = plan.menu.map(m => '  '.repeat(m.level - 1) + (m.level === 1 ? '■ ' : '– ') + m.title);
  if (max && lines.length > max) return lines.slice(0, max).concat('… and ' + (lines.length - max) + ' more').join('\n');
  return lines.join('\n');
}

module.exports = { DEFAULT_OPTIONS, RUN_LOCKED, sameOption, normalizeOptions, buildPlan, planReportRows, outline };
