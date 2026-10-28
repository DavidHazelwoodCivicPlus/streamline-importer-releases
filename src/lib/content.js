'use strict';
// Builds one page's freeform content (html + Lexical json) from its D10 body and attachments, and one
// accordion per FAQ its D10 FAQ sections show, with links resolved for the new site.
// Used for real by the runner and with placeholders by the dry run.

const { convertHtml } = require('./lexical');
const { makeResolver, attachmentsHtml } = require('./links');

const isEmptyDoc = json => json.root.children.length === 1 && json.root.children[0].type === 'paragraph' && !json.root.children[0].children.length;

// page: a plan page (bodyHtml, attachments, faqs). lookups: see links.makeResolver.
// Returns { html, json, warnings, links: [{href, type, result, outcome, target, reason}], empty,
//           faqs: [{ nid, question, html, json }] }
// empty = the body (with its attachments) has nothing in it; the page may still have FAQs.
function buildPageContent(page, idx, lookups, opts) {
  opts = opts || {};
  const links = [];
  const resolver = makeResolver(idx, lookups, e => links.push(e));
  const convert = html => convertHtml(html, {
    resolveLink: resolver.resolveLink,
    resolveEmbed: resolver.resolveEmbed,
    resolveImage: () => null // bodies in the samples have no <img>; any that appear are reported
  });

  const r = convert((page.bodyHtml || '') + (opts.includeAttachments !== false ? attachmentsHtml(idx, page.attachments) : ''));
  // Attachments that point at media missing from www-media.json have no file to link to.
  const warnings = r.warnings.slice();
  if (opts.includeAttachments !== false) for (const id of page.attachments || []) if (!idx.media.has(id)) warnings.push({ code: 'attachment-missing', detail: 'media ' + id + ' is not in www-media.json' });

  const faqs = (page.faqs || []).map(f => {
    const a = convert(f.answerHtml || '');
    for (const w of a.warnings) warnings.push({ code: w.code, detail: 'FAQ "' + f.question + '": ' + w.detail });
    if (isEmptyDoc(a.json)) warnings.push({ code: 'faq-empty-answer', detail: 'FAQ "' + f.question + '" has no answer' });
    return { nid: f.nid, question: f.question, html: a.html, json: a.json };
  });

  return { html: r.html, json: r.json, warnings, links, empty: isEmptyDoc(r.json), faqs };
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

// Which imported pages the content links to (so the runner only looks up those pages' addresses).
function linkedPageKeys(plan, idx, opts) {
  const keys = new Set(plan.pages.map(p => p.key));
  const wanted = new Set();
  const lookups = { pageUrl: key => { if (keys.has(key)) wanted.add(key); return null; }, media: () => null };
  for (const p of plan.pages) if (p.content === 'content') buildPageContent(p, idx, lookups, opts);
  return wanted;
}

module.exports = { buildPageContent, placeholderLookups, linkedPageKeys };
