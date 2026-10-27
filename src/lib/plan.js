'use strict';
// Turns a menu tree into the exact list of things a run will create, and the dry-run report.
// Pure: the same input always gives the same plan, so resume can match work to the manifest by key.

const { referencedMedia } = require('./links');

const DEFAULT_OPTIONS = Object.freeze({
  menuSource: 'd10',            // 'd10' | 'workbook'
  pageContent: 'empty',         // 'empty' | 'content' (D10 body converted to freeform content)
  unpublishedSourceAs: 'unpublished', // how to import pages that are unpublished in D10: 'unpublished' | 'published'
  newsEvents: 'skip',           // only option for now
  includeEmptyMicrosites: false,
  includeAttachments: true,     // content mode: list a page's file attachments under a "Documents" heading
  uploadMedia: true,            // content mode: upload the files and images pages link to, and point links at them
  pageUrlPattern: 'auto',       // how page URLs look on the new site; 'auto' = find out from an existing page
  unmatchedRows: 'empty-page',  // workbook mode: rows with no D10 match become 'empty-page' | 'skip'
  limit: 0                      // 0 = all pages; otherwise a small test run
});

// Options that must stay the same for the whole of a run (resume rebuilds the same plan).
const RUN_LOCKED = ['menuSource', 'pageContent', 'unpublishedSourceAs', 'includeAttachments', 'uploadMedia', 'unmatchedRows'];

function normalizeOptions(o) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, o || {});
  if (!['d10', 'workbook'].includes(opts.menuSource)) throw new Error('Unknown menu source "' + opts.menuSource + '"');
  if (!['empty', 'content'].includes(opts.pageContent)) throw new Error('Unknown page content "' + opts.pageContent + '"');
  if (!['unpublished', 'published'].includes(opts.unpublishedSourceAs)) throw new Error('Bad unpublishedSourceAs: ' + opts.unpublishedSourceAs);
  if (opts.newsEvents !== 'skip') throw new Error('News and events can only be skipped for now');
  if (opts.pageUrlPattern !== 'auto' && !/\{slug\}/.test(opts.pageUrlPattern)) throw new Error('Page URL pattern must contain {slug}, e.g. /{slug}');
  opts.limit = Math.max(0, parseInt(opts.limit, 10) || 0);
  for (const k of ['includeEmptyMicrosites', 'includeAttachments', 'uploadMedia']) opts[k] = !!opts[k];
  if (opts.pageContent === 'empty') opts.uploadMedia = false;
  return opts;
}

// tree: [{ key, sourceType, source, title, children }] from navFromD10 or the workbook matcher.
// source is the D10 page/microsite summary, or null for a workbook row with no D10 match (an empty page).
// idx: links.buildLinkIndex(exp), needed to list the media pages reference.
// Returns { options, pages, menu, media }.
//   pages: one per distinct page key, parents first. Two menu items may point at the same page.
//   menu:  one per tree node; parentKey is another menu item's key, weight = sibling order.
//   media: media ids to upload (content mode with uploadMedia).
function buildPlan(tree, options, idx) {
  const opts = normalizeOptions(options);
  const pages = [], menu = [], seen = new Set(), media = [];
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
          row: n.row || null
        };
        pages.push(page);
        if (withContent && opts.uploadMedia && idx) for (const mid of referencedMedia(idx, page.bodyHtml, page.attachments)) if (!media.includes(mid)) media.push(mid);
      }
      const menuKey = 'menu:' + (n.menuKey || n.key);
      menu.push({ key: menuKey, pageKey: n.key, parentKey: parentMenuKey, weight: i, title: n.title, level: path.length + 1, path: path.join(' > '), row: n.row || null });
      if (n.children && n.children.length) walk(n.children, menuKey, path.concat(n.title));
    });
  };
  walk(tree, null, []);
  return { options: opts, pages, menu, media };
}

function bodyLabel(p) {
  if (p.content === 'content') return p.hasBody || p.attachments.length ? 'converted' : 'empty (no D10 body)';
  if (!p.nid) return 'empty (no D10 match)';
  return p.hasBody ? 'empty (D10 body not imported)' : 'empty';
}

// One row per planned menu item, in menu order, for the dry-run report.
// contentByKey (optional): page key -> { warnings, links } from the dry-run conversion.
function planReportRows(plan, contentByKey) {
  const pageByKey = new Map(plan.pages.map(p => [p.key, p]));
  return plan.menu.map(m => {
    const p = pageByKey.get(m.pageKey);
    const c = contentByKey && contentByKey.get(p.key);
    const count = o => c ? c.links.filter(l => l.outcome === o).length : '';
    return {
      level: m.level, menuPath: m.path, title: m.title, order: m.weight + 1, row: m.row || '',
      sourceType: p.sourceType, nid: p.nid, oldUrl: p.alias,
      d10Published: p.nid ? (p.sourcePublished ? 'yes' : 'no') : '', importAs: p.unpublished ? 'unpublished' : 'published',
      body: bodyLabel(p), attachments: p.attachments.length || '',
      linksToPages: count('page'), linksToMedia: count('media'), linksToOldSite: count('old-site'),
      dropped: c ? c.warnings.map(w => w.code).join(' ') : '',
      notes: p.notes.filter(n => p.content !== 'content' || !/attachments/i.test(n) || !p.attachments.length).join('; ')
    };
  });
}

// Plain-text outline of the tree for the preview pane.
function outline(plan, max) {
  const lines = plan.menu.map(m => '  '.repeat(m.level - 1) + (m.level === 1 ? '■ ' : '– ') + m.title);
  if (max && lines.length > max) return lines.slice(0, max).concat('… and ' + (lines.length - max) + ' more').join('\n');
  return lines.join('\n');
}

module.exports = { DEFAULT_OPTIONS, RUN_LOCKED, normalizeOptions, buildPlan, planReportRows, outline };
