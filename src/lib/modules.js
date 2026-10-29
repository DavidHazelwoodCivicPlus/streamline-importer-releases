'use strict';
// D10 module content (records that are not pages) imported as Streamline pages: one page per entry, built
// from its fields, plus one listing page per module that shows its entries as cards.
// Meetings, events and people (directory listings) are left out on purpose: Streamline is adding modules for them.
// Pure: takes the loaded export, returns entry summaries.

const { fieldItems, firstValue, cleanTitle } = require('./d10');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// D10 stores date-times in UTC ("2018-07-23T15:00:00"); they are shown in the site's time zone,
// e.g. "July 23, 2018 10:00 AM" in America/Chicago. Date-only values ("2023-07-01") are shown as written.
function formatDate(s, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return String(s || '');
  if (!m[4]) return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(d).map(p => [p.type, p.value]));
  return parts.month + ' ' + parts.day + ', ' + parts.year + ' ' + parts.hour + ':' + parts.minute + ' ' + parts.dayPeriod;
}
const isoDate = s => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || '')); return m ? m[1] : ''; };

// A D10 address field as lines of text.
function addressLines(rec, name) {
  const a = fieldItems(rec, name)[0];
  if (!a || typeof a !== 'object') return [];
  const city = [a.locality, a.administrative_area].filter(Boolean).join(', ') + (a.postal_code ? ' ' + a.postal_code : '');
  return [a.organization, a.address_line1, a.address_line2, a.address_line3, city.trim()].map(x => (x || '').trim()).filter(Boolean);
}

const termNames = (rec, name, terms) => fieldItems(rec, name).map(it => it && (it.target_id != null ? terms[String(it.target_id)] : null)).filter(Boolean);
const titleCase = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// One "Label: value" line per detail that has a value.
const detail = (label, value) => (value ? '<p><strong>' + esc(label) + ':</strong> ' + esc(value) + '</p>' : '');
const richDetail = (label, html) => (html && html.trim() ? '<h3>' + esc(label) + '</h3>' + html : '');
const addressHtml = lines => (lines.length ? '<p><strong>Address:</strong><br>' + lines.map(esc).join('<br>') + '</p>' : '');

// Each module: where its records are, what its listing page is called, and how an entry's page is built.
// details(rec, terms, tz) returns HTML placed above the body.
const MODULES = {
  news: {
    label: 'News', file: 'pages', order: 'date_published',
    filter: p => p.kind === 'news',
    details: () => ''
  },
  business_directory: {
    label: 'Business Directory', file: 'business_directory', order: 'alphabetical_by_title',
    details: rec => addressHtml(addressLines(rec, 'field_address'))
  },
  jobs: {
    label: 'Job Openings', file: 'jobs', order: 'alphabetical_by_title',
    details: (rec, terms, tz) => detail('Status', titleCase(firstValue(rec, 'field_job_status'))) + detail('Closing date', firstValue(rec, 'field_job_closing_date') && formatDate(firstValue(rec, 'field_job_closing_date'), tz))
  },
  bids_rfps: {
    label: 'Bids & RFPs', file: 'bids_rfps', order: 'alphabetical_by_title',
    details: (rec, terms, tz) => detail('Status', titleCase(firstValue(rec, 'field_bid_status'))) + detail('Due', firstValue(rec, 'field_date') && formatDate(firstValue(rec, 'field_date'), tz))
  },
  ordinances: {
    label: 'Ordinances & Resolutions', file: 'ordinances', order: 'alphabetical_by_title',
    // field_ordinance_resolution (1/0) is left out: the export does not say which value means which.
    details: (rec, terms) => detail('Number', firstValue(rec, 'field_ordinance_resolution_id')) + detail('Status', termNames(rec, 'field_ordinance_resolution_statu', terms).join(', '))
  },
  parks: {
    label: 'Parks', file: 'parks', order: 'alphabetical_by_title',
    details: (rec, terms) => addressHtml(addressLines(rec, 'field_address')) +
      detail('Amenities', termNames(rec, 'field_amenities', terms).join(', ')) +
      richDetail('Hours', firstValue(rec, 'field_hours') || '') +
      richDetail('Rules and regulations', firstValue(rec, 'field_rules_regulations') || '')
  },
  projects: {
    label: 'Projects', file: 'projects', order: 'alphabetical_by_title',
    details: (rec, terms) => detail('Status', termNames(rec, 'field_project_status', terms).join(', ')) +
      detail('Type', termNames(rec, 'field_project_type', terms).join(', ')) +
      detail('Project ID', firstValue(rec, 'field_project_id') !== firstValue(rec, 'title') ? firstValue(rec, 'field_project_id') : '') +
      detail('Date received', firstValue(rec, 'field_date_received') && formatDate(firstValue(rec, 'field_date_received'))) +
      addressHtml(addressLines(rec, 'field_address'))
  },
  standard_locations: {
    label: 'Locations', file: 'standard_locations', order: 'alphabetical_by_title',
    details: rec => addressHtml(addressLines(rec, 'field_address'))
  }
};
const MODULE_TYPES = Object.keys(MODULES);

// Entries of one module type, in the order its listing page shows them.
// Each: { key, type, nid, title, alias, published, bodyHtml, attachments, publishedAt, notes, micrositeIds }
// opts.timeZone: the site's IANA time zone for date-times (default UTC).
function moduleEntries(exp, type, opts) {
  const tz = (opts && opts.timeZone) || 'UTC';
  const def = MODULES[type];
  if (!def) throw new Error('Unknown module type ' + type);
  let entries;
  if (type === 'news') {
    // News items are page records; their summaries are already loaded.
    const raw = new Map((exp.raw.pages || []).map(r => [String(r.entity_id), r]));
    entries = exp.pages.filter(def.filter).map(p => ({
      key: 'news:' + p.nid, type, nid: p.nid, title: p.title, alias: p.alias, published: p.published,
      bodyHtml: p.bodyHtml, attachments: p.attachments, publishedAt: isoDate(firstValue(raw.get(p.nid), 'field_news_date')),
      micrositeIds: p.micrositeIds, notes: p.notes.filter(n => !/attachments/i.test(n))
    }));
    entries.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.title.localeCompare(b.title));
    return entries;
  }
  entries = (exp.raw[def.file] || []).filter(r => r && r.fields).map(rec => {
    const body = firstValue(rec, 'body');
    const notes = [];
    if (fieldItems(rec, 'field_sections').length) notes.push('Has sections (paragraphs)');
    if (fieldItems(rec, 'field_primary_image_video').length) notes.push('Has primary image/video');
    if (fieldItems(rec, 'field_location').length) notes.push('Has a map location');
    return {
      key: type + ':' + rec.entity_id, type, nid: String(rec.entity_id),
      title: cleanTitle(firstValue(rec, 'title')) || '(untitled ' + rec.entity_id + ')',
      alias: (fieldItems(rec, 'path')[0] || {}).alias || '', published: rec.is_published === true,
      bodyHtml: def.details(rec, exp.terms, tz) + (typeof body === 'string' ? body : ''),
      attachments: fieldItems(rec, 'field_file_attachments').map(it => it && (it.target_id != null ? it.target_id : it.entity_id)).filter(v => v != null).map(String),
      publishedAt: '', micrositeIds: fieldItems(rec, 'og_audience').map(it => it && it.target_id).filter(Boolean).map(String), notes
    };
  });
  entries.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base', numeric: true }));
  return entries;
}

// How many records each module type has, for the options screen.
function moduleCounts(exp) {
  const out = {};
  for (const t of MODULE_TYPES) out[t] = t === 'news' ? exp.pages.filter(p => p.kind === 'news').length : (exp.raw[MODULES[t].file] || []).length;
  return out;
}

module.exports = { MODULES, MODULE_TYPES, moduleEntries, moduleCounts, formatDate, addressLines };
