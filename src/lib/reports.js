'use strict';
// Reports on what the export holds and where it goes. Pure.

const { fieldItems, firstValue, cleanTitle } = require('./d10');

// One row per FAQ group (microsite + category): the D10 pages whose FAQ sections show it (they get accordions
// in content mode), the microsite it belongs to, and its questions in weight order.
function faqReport(exp) {
  const faqs = exp.raw.faqs || [];
  const ms = new Map(exp.microsites.map(m => [m.nid, m]));
  const shownOn = new Map();
  for (const p of exp.pages.concat(exp.microsites)) for (const sec of p.faqSections || []) {
    if (!shownOn.has(sec.categoryId)) shownOn.set(sec.categoryId, []);
    shownOn.get(sec.categoryId).push(p.title + ' (nid ' + p.nid + (p.kind && p.kind !== 'page' ? ', ' + p.kind + ', not imported' : '') + ')');
  }
  const groups = new Map();
  for (const f of faqs) {
    if (!f || !f.fields) continue;
    const msId = String(firstValue(f, 'og_audience') || '');
    const catId = String(firstValue(f, 'field_faq_category') || '');
    const key = msId + '|' + catId;
    if (!groups.has(key)) groups.set(key, { msId, catId, items: [] });
    groups.get(key).items.push({
      title: cleanTitle(firstValue(f, 'title')), weight: Number(firstValue(f, 'field_faq_weight')) || 0,
      alias: (fieldItems(f, 'path')[0] || {}).alias || '', published: f.is_published === true, nid: String(f.entity_id)
    });
  }
  return [...groups.values()].map(g => {
    const m = ms.get(g.msId);
    g.items.sort((a, b) => a.weight - b.weight || a.title.localeCompare(b.title));
    return {
      microsite: m ? m.title : (g.msId ? 'microsite ' + g.msId + ' (not in export)' : '(none)'), micrositeNid: g.msId,
      wouldGoOn: m ? m.title + ' (' + m.alias + ')' : '', category: exp.terms[g.catId] || (g.catId ? 'term ' + g.catId : '(none)'),
      onPages: (shownOn.get(g.catId) || []).join(' | ') || 'none (not shown on any page)',
      count: g.items.length, published: g.items.filter(i => i.published).length,
      questions: g.items.map(i => i.title).join(' | '), nids: g.items.map(i => i.nid).join(' '), oldUrls: g.items.map(i => i.alias).join(' ')
    };
  }).sort((a, b) => a.microsite.localeCompare(b.microsite) || a.category.localeCompare(b.category));
}

const FAQ_COLUMNS = [
  { key: 'microsite', label: 'Microsite' }, { key: 'micrositeNid', label: 'Microsite nid' }, { key: 'wouldGoOn', label: 'Would go on' },
  { key: 'category', label: 'FAQ category' }, { key: 'onPages', label: 'Shown on D10 pages (become accordions)' }, { key: 'count', label: 'FAQs' }, { key: 'published', label: 'Published' },
  { key: 'questions', label: 'Questions (in weight order)' }, { key: 'nids', label: 'FAQ nids' }, { key: 'oldUrls', label: 'Old URLs' }
];

// What is in the export but not imported, with counts, so nothing is lost silently.
function outOfScopeReport(exp) {
  const rows = [];
  const count = (type, recs, note) => {
    if (!recs) return;
    rows.push({ type, records: recs.length, published: recs.filter(r => r && r.is_published === true).length, note });
  };
  const r = exp.raw;
  count('FAQs', r.faqs, 'Imported as accordions on the pages whose FAQ sections show them (content mode). FAQs no page shows are not imported; see the FAQ report.');
  count('Meetings', r.meetings, 'Not imported yet (waiting for a Streamline meetings update).');
  count('Directory listings', r.directory_listings, 'People: not imported yet (waiting for a Streamline update).');
  count('Business directory', r.business_directory, 'Imported as pages when Business Directory is selected under Module content.');
  count('Parks', r.parks, 'Imported as pages when Parks is selected under Module content.');
  count('Bids and RFPs', r.bids_rfps, 'Imported as pages when Bids & RFPs is selected under Module content.');
  count('Jobs', r.jobs, 'Imported as pages when Job Openings is selected under Module content.');
  count('Ordinances', r.ordinances, 'Imported as pages when Ordinances & Resolutions is selected under Module content.');
  count('Projects', r.projects, 'Imported as pages when Projects is selected under Module content.');
  count('Property listings', r.property_listings, 'Not imported (no module yet; none in the sample exports).');
  count('Locations', r.standard_locations, 'Imported as pages when Locations is selected under Module content.');
  count('Paragraphs', r.paragraphs, 'Section content used by pages and microsites (field_sections). Not imported.');
  const news = exp.pages.filter(p => p.kind === 'news'), events = exp.pages.filter(p => p.kind === 'event');
  rows.push({ type: 'News items', records: news.length, published: news.filter(p => p.published).length, note: 'Imported as dated pages when News is selected under Module content; never menu pages.' });
  rows.push({ type: 'Events', records: events.length, published: events.filter(p => p.published).length, note: 'Not imported yet (waiting for a Streamline events update).' });
  const regular = exp.pages.filter(p => p.kind === 'page');
  const has = re => regular.filter(p => p.notes.some(n => re.test(n)));
  const pr = (type, list, note) => rows.push({ type, records: list.length, published: list.filter(p => p.published).length, note });
  pr('Pages with sections', has(/sections/i), 'Their field_sections (paragraph) content is not imported; only the body is.');
  pr('Pages that redirect', has(/^Redirect/), 'Imported as ordinary pages. Streamline has redirect pages (redirect/redirectUrl) for a later version.');
  pr('Pages with a primary image or video', has(/primary image/i), 'The primary image is not imported.');
  const layout = (r.microsites || []).filter(m => m && m.fields && Array.isArray(m.fields.layout_builder__layout) && m.fields.layout_builder__layout.length);
  rows.push({ type: 'Microsites with Layout Builder content', records: layout.length, published: layout.filter(m => m.is_published).length, note: 'Layout Builder content is not imported; only the microsite body is.' });
  const msSections = exp.microsites.filter(m => m.notes.length);
  rows.push({ type: 'Microsites with sections', records: msSections.length, published: msSections.filter(m => m.published).length, note: 'Their field_sections content is not imported.' });
  const videos = (exp.media || []).filter(m => m.kind === 'video');
  rows.push({ type: 'Video media', records: videos.length, published: videos.filter(m => m.published).length, note: 'Links to videos are kept as external links; videos are not uploaded.' });
  return rows;
}

const OUT_OF_SCOPE_COLUMNS = [
  { key: 'type', label: 'Content' }, { key: 'records', label: 'Records' }, { key: 'published', label: 'Published' }, { key: 'note', label: 'What happens' }
];

module.exports = { faqReport, FAQ_COLUMNS, outOfScopeReport, OUT_OF_SCOPE_COLUMNS };
