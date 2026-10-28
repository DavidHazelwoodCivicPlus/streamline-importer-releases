'use strict';
// Reads the D10 export (www-*.json files) into plain page and microsite summaries.
// Pure: takes file text, returns data. No DOM, no network.

// The export files we know, keyed by the part after "www-". Empty arrays are valid.
const KNOWN_FILES = [
  'bids_rfps', 'business_directory', 'directory_listings', 'faqs', 'jobs', 'media', 'meetings',
  'microsites', 'ordinances', 'pages', 'paragraphs', 'parks', 'projects', 'property_listings',
  'standard_locations', 'taxonomy_terms'
];
const REQUIRED_FILES = ['pages', 'microsites'];

// D10 field values come as [{value: x}], [{target_id: x}], a bare ["x"], or (field_news_date in the Harvard
// export) a bare "x" with no array around it.
function fieldItems(rec, name) {
  const v = rec && rec.fields ? rec.fields[name] : null;
  if (Array.isArray(v)) return v;
  return v == null || v === '' ? [] : [v];
}
function itemValue(item) {
  if (item == null) return null;
  if (typeof item !== 'object') return item;
  if ('value' in item) return item.value;
  if ('target_id' in item) return item.target_id;
  if ('uri' in item) return item.uri;
  return null;
}
function firstValue(rec, name) {
  for (const it of fieldItems(rec, name)) {
    const v = itemValue(it);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}
const hasValue = (rec, name) => firstValue(rec, name) !== null;

const cleanTitle = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Same buckets as the Build61 tool: news wins over event, everything else is a regular page.
function classifyPage(rec) {
  if (hasValue(rec, 'field_news_date')) return 'news';
  if (hasValue(rec, 'field_smart_date')) return 'event';
  return 'page';
}

function aliasOf(rec) {
  const p = fieldItems(rec, 'path')[0];
  return p && p.alias ? String(p.alias) : '';
}

// Content on the D10 page that milestone 1 does not carry over. Listed so the report can show it.
function pageNotes(rec) {
  const notes = [];
  if (hasValue(rec, 'field_page_redirect')) notes.push('Redirect: ' + firstValue(rec, 'field_page_redirect'));
  if (hasValue(rec, 'field_sections')) notes.push('Has sections (paragraphs)');
  if (hasValue(rec, 'field_file_attachments')) notes.push('Has file attachments');
  if (hasValue(rec, 'field_primary_image_video')) notes.push('Has primary image/video');
  return notes;
}

// Media ids attached to a page (field_file_attachments), in field order.
function attachmentIds(rec) {
  return fieldItems(rec, 'field_file_attachments').map(it => it && (it.target_id != null ? it.target_id : it.entity_id)).filter(v => v != null).map(String);
}

function summarizePage(rec) {
  const body = firstValue(rec, 'body');
  return {
    attachments: attachmentIds(rec),
    sourceType: 'page',
    nid: String(rec.entity_id),
    uuid: firstValue(rec, 'uuid') || '',
    title: cleanTitle(firstValue(rec, 'title')),
    alias: aliasOf(rec),
    published: rec.is_published === true,
    micrositeIds: fieldItems(rec, 'og_audience').map(itemValue).filter(v => v != null).map(String),
    kind: classifyPage(rec),
    bodyHtml: typeof body === 'string' ? body : '',
    hasBody: typeof body === 'string' && body.trim() !== '',
    notes: pageNotes(rec)
  };
}

function summarizeMicrosite(rec) {
  const body = firstValue(rec, 'body');
  return {
    sourceType: 'microsite',
    attachments: [],
    nid: String(rec.entity_id),
    uuid: firstValue(rec, 'uuid') || '',
    title: cleanTitle(firstValue(rec, 'title')),
    alias: aliasOf(rec),
    published: rec.is_published === true,
    typeTermId: firstValue(rec, 'field_microsite_type') != null ? String(firstValue(rec, 'field_microsite_type')) : '',
    bodyHtml: typeof body === 'string' ? body : '',
    hasBody: typeof body === 'string' && body.trim() !== '',
    notes: hasValue(rec, 'field_sections') ? ['Has sections (paragraphs)'] : []
  };
}

// One media entity: an image, a document, or a video link. url is the file on the old site.
function summarizeMedia(rec) {
  const img = fieldItems(rec, 'field_media_image')[0];
  const file = fieldItems(rec, 'field_media_file')[0];
  const video = firstValue(rec, 'field_media_oembed_video');
  const src = img || file || null;
  return {
    mid: String(rec.entity_id),
    uuid: firstValue(rec, 'uuid') || '',
    bundle: rec.bundle,
    kind: img ? 'image' : file ? 'file' : video ? 'video' : 'other',
    name: cleanTitle(firstValue(rec, 'name')),
    url: src && src.file_url ? String(src.file_url) : (video ? String(video) : ''),
    fileName: src && src.file_name ? String(src.file_name) : '',
    alt: img && img.alt ? cleanTitle(img.alt) : '',
    published: rec.is_published === true
  };
}

// Hosts the old site was served from: the canonical URL in page metatags, plus file URLs. Links to these are internal.
function oldSiteHosts(rawPages, media) {
  const hosts = new Map();
  const add = u => { try { const h = new URL(u).host.toLowerCase(); hosts.set(h, (hosts.get(h) || 0) + 1); } catch (e) { /* not a URL */ } };
  for (const r of rawPages || []) {
    for (const t of fieldItems(r, 'metatag')) if (t && t.attributes && t.attributes.rel === 'canonical') add(t.attributes.href);
  }
  for (const m of media) if (m.url && m.kind !== 'video') add(m.url);
  const list = [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  // www and bare domain are the same site.
  for (const h of list.slice()) { const other = h.startsWith('www.') ? h.slice(4) : 'www.' + h; if (!list.includes(other)) list.push(other); }
  return list;
}

// A page's sections (paragraphs), in field order. The export embeds each paragraph in field_sections;
// when it does not, the paragraph is looked up in www-paragraphs.json by id.
function sectionsOf(rec, paragraphById) {
  return fieldItems(rec, 'field_sections').map(it => {
    if (!it) return null;
    const p = it.entity && it.entity.fields ? it.entity : paragraphById.get(String(it.target_id));
    return p ? { pid: String(p.entity_id), bundle: p.bundle, rec: p } : { pid: String(it.target_id), bundle: null, rec: null };
  }).filter(Boolean);
}

// The FAQ sections a page shows: each names one FAQ category.
function faqSectionsOf(rec, paragraphById) {
  return sectionsOf(rec, paragraphById).filter(s => s.bundle === 'faqs' && s.rec).map(s => ({
    pid: s.pid,
    categoryId: firstValue(s.rec, 'field_faq_category') != null ? String(firstValue(s.rec, 'field_faq_category')) : '',
    collapsing: String(firstValue(s.rec, 'field_collapsing_options') || '')
  })).filter(s => s.categoryId);
}

function summarizeFaq(rec) {
  const body = firstValue(rec, 'body');
  return {
    nid: String(rec.entity_id),
    question: cleanTitle(firstValue(rec, 'title')),
    answerHtml: typeof body === 'string' ? body : '',
    categoryId: firstValue(rec, 'field_faq_category') != null ? String(firstValue(rec, 'field_faq_category')) : '',
    weight: Number(firstValue(rec, 'field_faq_weight')) || 0,
    micrositeIds: fieldItems(rec, 'og_audience').map(itemValue).filter(v => v != null).map(String),
    alias: aliasOf(rec),
    published: rec.is_published === true
  };
}

// FAQs in each category, in the order D10 lists them: weight, then question.
function faqsByCategory(faqs) {
  const map = new Map();
  for (const f of faqs) {
    if (!f.categoryId) continue;
    if (!map.has(f.categoryId)) map.set(f.categoryId, []);
    map.get(f.categoryId).push(f);
  }
  for (const list of map.values()) list.sort((a, b) => a.weight - b.weight || a.question.localeCompare(b.question) || Number(a.nid) - Number(b.nid));
  return map;
}

// "www-pages.json" -> "pages". Returns null for names that are not export files.
function exportKey(fileName) {
  const m = /(?:^|[\\/])www-([a-z_]+)\.json$/i.exec(String(fileName));
  return m ? m[1].toLowerCase() : null;
}

// files: [{name, text}]. Returns everything the later steps need plus counts and problems.
function loadExport(files) {
  const raw = {}, errors = [], warnings = [], counts = {};
  for (const f of files) {
    const key = exportKey(f.name);
    if (!key) { warnings.push('Ignored ' + f.name + ': not a www-*.json export file'); continue; }
    if (!KNOWN_FILES.includes(key)) warnings.push('Unrecognized export file ' + f.name + ' (loaded, not used)');
    if (raw[key]) { errors.push('Two files for www-' + key + '.json'); continue; }
    let data;
    try { data = JSON.parse(f.text); } catch (e) { errors.push(f.name + ' is not valid JSON: ' + e.message); continue; }
    if (!Array.isArray(data)) { errors.push(f.name + ' should hold a JSON array'); continue; }
    raw[key] = data;
    counts[key] = data.length;
  }
  for (const k of REQUIRED_FILES) if (!raw[k]) errors.push('Missing www-' + k + '.json');
  for (const k of KNOWN_FILES) if (!(k in counts)) counts[k] = null; // null = not loaded

  const pages = (raw.pages || []).filter(r => r && r.fields).map(summarizePage);
  const microsites = (raw.microsites || []).filter(r => r && r.fields).map(summarizeMicrosite);

  const msIds = new Set(microsites.map(m => m.nid));
  for (const p of pages) {
    if (!p.micrositeIds.length) warnings.push('Page ' + p.nid + ' "' + p.title + '" has no microsite');
    else if (p.micrositeIds.length > 1) warnings.push('Page ' + p.nid + ' "' + p.title + '" belongs to ' + p.micrositeIds.length + ' microsites');
    for (const id of p.micrositeIds) if (!msIds.has(id)) warnings.push('Page ' + p.nid + ' points at microsite ' + id + ', which is not in www-microsites.json');
  }

  const terms = {};
  for (const t of raw.taxonomy_terms || []) {
    const name = cleanTitle(firstValue(t, 'name'));
    if (t && t.entity_id != null) terms[String(t.entity_id)] = name;
  }

  const media = (raw.media || []).filter(r => r && r.fields).map(summarizeMedia);
  const hosts = oldSiteHosts(raw.pages, media);
  const origin = hosts.length ? 'https://' + hosts[0] : '';

  // FAQ sections on pages and microsites, and the FAQs themselves.
  const paragraphById = new Map((raw.paragraphs || []).filter(p => p && p.entity_id != null).map(p => [String(p.entity_id), p]));
  const rawByNid = new Map([...(raw.pages || []), ...(raw.microsites || [])].filter(r => r && r.fields).map(r => [String(r.entity_id), r]));
  for (const s of pages.concat(microsites)) s.faqSections = faqSectionsOf(rawByNid.get(s.nid), paragraphById);
  const faqs = (raw.faqs || []).filter(r => r && r.fields).map(summarizeFaq);
  const faqCategories = faqsByCategory(faqs);

  return { pages, microsites, media, faqs, faqCategories, terms, hosts, origin, counts, errors, warnings, raw };
}

module.exports = {
  KNOWN_FILES, REQUIRED_FILES, fieldItems, firstValue, hasValue, cleanTitle, classifyPage,
  summarizePage, summarizeMicrosite, summarizeMedia, summarizeFaq, faqsByCategory, sectionsOf, faqSectionsOf,
  oldSiteHosts, exportKey, loadExport
};
