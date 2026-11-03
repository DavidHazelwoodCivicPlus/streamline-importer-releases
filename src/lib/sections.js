'use strict';
// D10 page sections (paragraphs) as Streamline main-column content: one block per section, in D10 order.
// Each block is HTML in the same shape a D10 body uses, so the usual conversion uploads its images and files
// and points its links at the new site:
//   images -> <drupal-media data-entity-uuid>     (an image in the freeform section)
//   files  -> <a href="/media/N">                  (a link to the uploaded file)
// A section D10 showed collapsed or open becomes an accordion titled with the section's heading.
// Embedded pages, staff (directory listings) and FAQ sections are not blocks: they become right-column cards.
// Pure.

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Bundles placed elsewhere (cards), not as main-column blocks.
const CARD_BUNDLES = ['embedded_pages', 'faqs', 'embedded_directory_listings'];

// A media item as body HTML: an image (or video link) embedded, or a document link.
function mediaHtml(idx, mid) {
  const m = idx.media.get(String(mid));
  if (!m) return '';
  if (m.kind === 'image' || m.kind === 'video') return m.uuid ? '<drupal-media data-entity-type="media" data-entity-uuid="' + esc(m.uuid) + '"></drupal-media>' : '';
  return '<a href="/media/' + esc(m.mid) + '">' + esc(m.name || m.fileName || 'Document') + '</a>';
}
const fileListHtml = (idx, ids) => {
  const items = ids.map(id => idx.media.get(String(id))).filter(Boolean);
  return items.length ? '<ul>' + items.map(m => '<li><a href="/media/' + esc(m.mid) + '">' + esc(m.name || m.fileName || 'Document') + '</a></li>').join('') + '</ul>' : '';
};
const headingTag = t => (/^h[2-6]$/.test(t) ? t : 'h2');

// sections: page summary .sections (d10.contentSectionsOf). Returns { blocks, warnings }.
//   blocks: [{ kind, title, accordion, html, pid }]  (title is the accordion title; otherwise the heading is in html)
function sectionBlocks(sections, idx) {
  const blocks = [], warnings = [];
  const missing = (s, mid) => { if (mid && !idx.media.has(String(mid))) warnings.push({ code: 'section-media-missing', detail: s.bundle + ' section ' + s.pid + ': media ' + mid + ' is not in www-media.json' }); };
  for (const s of sections || []) {
    if (CARD_BUNDLES.includes(s.bundle)) continue;
    let html = '';
    if (s.bundle === 'text') html = s.html;
    else if (s.bundle === 'image_text') {
      missing(s, s.imageId);
      // Streamline images sit on their own line, so a left or right image goes above its text.
      const img = s.imageId ? mediaHtml(idx, s.imageId) : '';
      const link = s.imageLink ? '<p><a href="' + esc(s.imageLink.url) + '">' + esc(s.imageLink.title || s.imageLink.url) + '</a></p>' : '';
      html = (img ? '<p>' + img + '</p>' : '') + link + s.html;
    } else if (s.bundle === 'files') {
      if (s.fileSource && s.fileSource !== 'individual') warnings.push({ code: 'section-files-by-category', detail: 'files section ' + s.pid + ' lists files by category; not imported' });
      s.mediaIds.forEach(mid => missing(s, mid));
      html = fileListHtml(idx, s.mediaIds);
    } else if (s.bundle === 'slideshow') {
      s.mediaIds.forEach(mid => missing(s, mid));
      html = s.html + s.mediaIds.map(mid => mediaHtml(idx, mid)).filter(Boolean).map(x => '<p>' + x + '</p>').join('');
    } else {
      warnings.push({ code: 'section-not-imported', detail: (s.bundle || 'unknown') + ' section ' + s.pid + ' is not imported' });
      continue;
    }
    if (!html.trim()) { warnings.push({ code: 'section-empty', detail: s.bundle + ' section ' + s.pid + (s.header ? ' "' + s.header + '"' : '') + ' has nothing to show' }); continue; }
    const accordion = (s.collapsing === 'open' || s.collapsing === 'collapsed') && !!s.header;
    const t = headingTag(s.headerType);
    blocks.push({ kind: s.bundle, pid: s.pid, accordion, title: accordion ? s.header : '', html: (!accordion && s.header ? '<' + t + '>' + esc(s.header) + '</' + t + '>' : '') + html });
  }
  return { blocks, warnings };
}

// The page's primary image (or video link) as HTML for the top of its body.
const primaryMediaHtml = (idx, mid) => { const h = mid ? mediaHtml(idx, mid) : ''; return h ? '<p>' + h + '</p>' : ''; };

module.exports = { sectionBlocks, primaryMediaHtml, mediaHtml, fileListHtml, CARD_BUNDLES, esc };
