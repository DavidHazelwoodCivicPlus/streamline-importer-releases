'use strict';
// Builds one page's freeform content (html + Lexical json) from its D10 body and attachments,
// with links resolved for the new site. Used for real by the runner and with placeholders by the dry run.

const { convertHtml } = require('./lexical');
const { makeResolver, attachmentsHtml } = require('./links');

// page: a plan page (bodyHtml, attachments). lookups: see links.makeResolver.
// Returns { html, json, warnings, links: [{href, type, result, outcome, target, reason}], empty }
function buildPageContent(page, idx, lookups, opts) {
  opts = opts || {};
  const source = (page.bodyHtml || '') + (opts.includeAttachments !== false ? attachmentsHtml(idx, page.attachments) : '');
  const links = [];
  const resolver = makeResolver(idx, lookups, e => links.push(e));
  const r = convertHtml(source, {
    resolveLink: resolver.resolveLink,
    resolveEmbed: resolver.resolveEmbed,
    resolveImage: () => null // bodies in the samples have no <img>; any that appear are reported
  });
  const empty = r.json.root.children.length === 1 && r.json.root.children[0].type === 'paragraph' && !r.json.root.children[0].children.length;
  // Attachments that point at media missing from www-media.json have no file to link to.
  const warnings = r.warnings.slice();
  if (opts.includeAttachments !== false) for (const id of page.attachments || []) if (!idx.media.has(id)) warnings.push({ code: 'attachment-missing', detail: 'media ' + id + ' is not in www-media.json' });
  return { html: r.html, json: r.json, warnings, links, empty };
}

// Dry-run lookups: say where links would go without knowing real URLs yet.
function placeholderLookups(plan) {
  const titles = new Map(plan.pages.map(p => [p.key, p.title]));
  const media = new Set(plan.media || []);
  return {
    pageUrl: key => (titles.has(key) ? '[new page: ' + titles.get(key) + ']' : null),
    media: mid => (media.has(mid) ? { url: '[uploaded media ' + mid + ']', id: 'pending-' + mid } : null)
  };
}

module.exports = { buildPageContent, placeholderLookups };
