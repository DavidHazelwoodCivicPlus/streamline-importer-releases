'use strict';
// D10 module content (records that are not pages) imported as Streamline pages: one page per entry, built
// from its fields, plus one listing page per module that shows its entries as cards.
// Meetings, events, people (directory listings) and FAQs have no Streamline module that pages can use yet, so they
// are pages too, linked from the right column of the pages D10 showed them on (see lib/plan.js).
// Pure: takes the loaded export, returns entry summaries.

const { fieldItems, firstValue, cleanTitle, refIds, contentSectionsOf, embeddedPagesOf } = require('./d10');
const { mediaHtml, fileListHtml } = require('./sections');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// D10 stores date-times in UTC ("2018-07-23T15:00:00"); they are shown in the site's time zone,
// e.g. "July 23, 2018 10:00 AM" in America/Chicago. Date-only values ("2023-07-01") are shown as written.
function formatDate(s, timeZone) {
  if (isUnix(s)) return formatDate(new Date(Number(s) * 1000).toISOString(), timeZone); // smart dates: Unix seconds
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return String(s || '');
  if (!m[4]) return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(d).map(p => [p.type, p.value]));
  return parts.month + ' ' + parts.day + ', ' + parts.year + ' ' + parts.hour + ':' + parts.minute + ' ' + parts.dayPeriod;
}
const isUnix = s => /^\d{9,11}$/.test(String(s == null ? '' : s).trim());
const isoDate = s => { if (isUnix(s)) return new Date(Number(s) * 1000).toISOString().slice(0, 10); const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || '')); return m ? m[1] : ''; };

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

// "January 3, 2024 6:00 PM – 8:00 PM", from a smart date item ({value, end_value} in Unix seconds).
function smartDateText(item, tz) {
  if (!item || typeof item !== 'object' || !item.value) return '';
  const a = formatDate(String(item.value), tz);
  const b = item.end_value && String(item.end_value) !== String(item.value) ? formatDate(String(item.end_value), tz) : '';
  if (!b) return a;
  const day = x => x.replace(/ \d+:\d\d [AP]M$/, '');
  return day(a) === day(b) ? a + ' – ' + b.slice(day(b).length + 1) : a + ' – ' + b;
}
function datesHtml(rec, tz) {
  const items = fieldItems(rec, 'field_smart_date').filter(it => it && typeof it === 'object' && it.value);
  if (!items.length) return '';
  const more = items.slice(1, 25).map(it => esc(smartDateText(it, tz)));
  return detail('When', smartDateText(items[0], tz)) +
    (more.length ? '<p>Also on: ' + more.join('; ') + (items.length > 25 ? '; and ' + (items.length - 25) + ' more dates' : '') + '</p>' : '');
}
// First date, for sorting (newest first).
const sortDate = rec => { const it = fieldItems(rec, 'field_smart_date').find(x => x && x.value); return it ? isoDate(String(it.value)) : ''; };

// D10 link fields ({uri, title}) as a list.
function linkListHtml(rec, names) {
  const items = [];
  for (const n of names) for (const it of fieldItems(rec, n)) if (it && typeof it === 'object' && it.uri) items.push('<li><a href="' + esc(it.uri) + '">' + esc(cleanTitle(it.title) || it.uri) + '</a></li>');
  return items.length ? '<ul>' + items.join('') + '</ul>' : '';
}
const mediaBlocks = (ctx, ids) => ids.map(id => mediaHtml(ctx, id)).filter(Boolean).map(h => '<p>' + h + '</p>').join('');
const titled = (title, html) => (html ? '<h2>' + esc(title) + '</h2>' + html : '');
// Where it is: a link to the location's page (the conversion points it at the new page or the old site) and the address.
function locationHtml(rec, ctx, refField) {
  const nid = refIds(rec, refField)[0];
  const lines = addressLines(rec, 'field_address');
  if (!nid && !lines.length) return '';
  const link = nid ? '<a href="/node/' + esc(nid) + '">' + esc((ctx.titles && ctx.titles.get(nid)) || 'Location') + '</a>' : '';
  return '<p><strong>Location:</strong> ' + [link].concat(lines.map(esc)).filter(Boolean).join('<br>') + '</p>';
}
const tel = s => String(s).replace(/[^\d+]/g, '');

// Each module: where its records are, what its listing page is called, and how an entry's page is built.
// details(rec, terms, tz, ctx) returns HTML placed above the body, after(...) HTML below it.
// ctx: { media: mid -> media summary, titles: nid -> title }.
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
  },
  events: {
    label: 'Events', file: 'pages', order: 'date_published',
    filter: p => p.kind === 'event',
    details: (rec, terms, tz, ctx) => datesHtml(rec, tz) + locationHtml(rec, ctx, 'field_location_ref'),
    after: rec => richDetail('Contact', firstValue(rec, 'field_contact_information_body') || '')
  },
  meetings: {
    label: 'Meetings', file: 'meetings', order: 'date_published',
    // Most meetings share their board's name, so the date tells the pages (and their cards) apart.
    title: (rec, tz) => {
      const t = cleanTitle(firstValue(rec, 'title'));
      const it = fieldItems(rec, 'field_smart_date').find(x => x && x.value);
      return it ? t + ' – ' + formatDate(String(it.value), tz).replace(/ \d+:\d\d [AP]M$/, '') : t;
    },
    details: (rec, terms, tz, ctx) => {
      // The short description is often the body's first line again: shown only when the body does not say it.
      const short = cleanTitle(firstValue(rec, 'field_short_description') || '');
      const bodyText = cleanTitle(String(firstValue(rec, 'body') || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));
      return datesHtml(rec, tz) + locationHtml(rec, ctx, 'field_standard_location') + (short && !bodyText.includes(short) ? '<p>' + esc(short) + '</p>' : '');
    },
    after: (rec, terms, tz, ctx) =>
      titled('Agenda', fileListHtml(ctx, refIds(rec, 'field_agendas')) + linkListHtml(rec, ['field_agendas_links', 'field_agenda_link_html'])) +
      titled('Agenda Packet', fileListHtml(ctx, refIds(rec, 'field_packets_files')) + linkListHtml(rec, ['field_packets_links', 'field_packets_link_html'])) +
      titled('Minutes', fileListHtml(ctx, refIds(rec, 'field_minutes_files')) + linkListHtml(rec, ['field_minutes_links'])) +
      titled('Other Documents', fileListHtml(ctx, refIds(rec, 'field_other_meeting_files'))) +
      titled('Video', mediaBlocks(ctx, refIds(rec, 'field_meeting_video')) + linkListHtml(rec, ['field_video_links'])) +
      titled('Audio', linkListHtml(rec, ['field_audio_links']))
  },
  people: {
    label: 'Staff Directory', file: 'directory_listings', order: 'manual',
    title: rec => cleanTitle(firstValue(rec, 'title')) || cleanTitle([firstValue(rec, 'field_first_name'), firstValue(rec, 'field_last_name')].filter(Boolean).join(' ')),
    details: (rec, terms, tz, ctx) => {
      const v = n => { const x = firstValue(rec, n); return x == null ? '' : String(x).trim(); };
      return mediaBlocks(ctx, refIds(rec, 'field_primary_image_video')) +
        (v('field_position') ? '<p><strong>' + esc(v('field_position')) + '</strong></p>' : '') +
        (v('field_email') ? '<p><strong>Email:</strong> <a href="mailto:' + esc(v('field_email')) + '">' + esc(v('field_email')) + '</a></p>' : '') +
        (v('field_phone_number') ? '<p><strong>Phone:</strong> <a href="tel:' + esc(tel(v('field_phone_number'))) + '">' + esc(v('field_phone_number')) + '</a></p>' : '') +
        detail('Fax', v('field_fax_number')) + detail('Office hours', v('field_office_hours')) +
        locationHtml(rec, ctx, 'field_standard_location');
    },
    body: rec => firstValue(rec, 'field_profile') || ''
  },
  faqs: {
    label: 'FAQs', file: 'faqs', order: 'alphabetical_by_title',
    details: () => ''
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
  const ctx = moduleContext(exp);
  const newestFirst = (a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.title.localeCompare(b.title);
  let entries;
  if (def.file === 'pages') {
    // News items and events are page records; their summaries (with sections) are already loaded.
    const raw = new Map((exp.raw.pages || []).map(r => [String(r.entity_id), r]));
    entries = exp.pages.filter(def.filter).map(p => {
      const rec = raw.get(p.nid);
      return {
        key: type + ':' + p.nid, type, nid: p.nid, title: p.title, alias: p.alias, published: p.published,
        bodyHtml: def.details(rec, exp.terms, tz, ctx) + p.bodyHtml + (def.after ? def.after(rec, exp.terms, tz, ctx) : ''),
        attachments: p.attachments, sections: p.sections || [], embeddedPages: p.embeddedPages || [], faqSections: p.faqSections || [],
        primaryMediaId: p.primaryMediaId || '',
        publishedAt: type === 'news' ? isoDate(firstValue(rec, 'field_news_date')) : sortDate(rec),
        micrositeIds: p.micrositeIds, notes: p.notes.filter(n => !/attachments|sections|primary image/i.test(n))
      };
    });
    entries.sort(newestFirst);
    return entries;
  }
  entries = (exp.raw[def.file] || []).filter(r => r && r.fields).map(rec => {
    const body = def.body ? def.body(rec) : firstValue(rec, 'body');
    const notes = [];
    if (fieldItems(rec, 'field_location').length) notes.push('Has a map location');
    const sections = exp.paragraphById ? contentSectionsOf(rec, exp.paragraphById) : [];
    return {
      key: type + ':' + rec.entity_id, type, nid: String(rec.entity_id),
      title: (def.title ? def.title(rec, tz) : cleanTitle(firstValue(rec, 'title'))) || '(untitled ' + rec.entity_id + ')',
      alias: (fieldItems(rec, 'path')[0] || {}).alias || '', published: rec.is_published === true,
      bodyHtml: def.details(rec, exp.terms, tz, ctx) + (typeof body === 'string' ? body : '') + (def.after ? def.after(rec, exp.terms, tz, ctx) : ''),
      attachments: refIds(rec, 'field_file_attachments'), sections,
      embeddedPages: exp.paragraphById ? embeddedPagesOf(rec, exp.paragraphById) : [], faqSections: [],
      // People show their photo in the details; other records show it at the top of the page.
      primaryMediaId: type === 'people' ? '' : (refIds(rec, 'field_primary_image_video')[0] || ''),
      publishedAt: sortDate(rec), micrositeIds: refIds(rec, 'og_audience'), notes,
      // For linking and ordering cards (see lib/plan.js).
      weight: Number(firstValue(rec, 'field_weight')) || 0, lastName: cleanTitle(firstValue(rec, 'field_last_name') || ''),
      groupTermIds: refIds(rec, 'field_directory_list_group'),
      categoryId: refIds(rec, 'field_faq_category')[0] || ''
    };
  });
  if (def.order === 'date_published') entries.sort(newestFirst);
  else if (type === 'people') entries.sort((a, b) => (a.lastName || a.title).localeCompare(b.lastName || b.title, 'en', { sensitivity: 'base' }) || a.title.localeCompare(b.title));
  else entries.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base', numeric: true }));
  return entries;
}

// What module pages need from the rest of the export: media (for images and file links) and node titles (locations).
function moduleContext(exp) {
  if (exp._moduleContext) return exp._moduleContext;
  const titles = new Map();
  for (const file of ['pages', 'microsites', 'standard_locations', 'parks']) for (const r of exp.raw[file] || []) if (r && r.entity_id != null) titles.set(String(r.entity_id), cleanTitle(firstValue(r, 'title')));
  const ctx = { media: new Map((exp.media || []).map(m => [m.mid, m])), titles };
  Object.defineProperty(exp, '_moduleContext', { value: ctx, enumerable: false });
  return ctx;
}

// How many records each module type has, for the options screen.
function moduleCounts(exp) {
  const out = {};
  for (const t of MODULE_TYPES) out[t] = MODULES[t].filter ? exp.pages.filter(MODULES[t].filter).length : (exp.raw[MODULES[t].file] || []).length;
  return out;
}

module.exports = { MODULES, MODULE_TYPES, moduleEntries, moduleCounts, formatDate, addressLines };
