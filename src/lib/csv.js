'use strict';
// CSV writer. Quoted and BOM-prefixed so Excel opens it cleanly (same format as the user6 skip report).

function toCsv(columns, rows) {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [columns.map(c => q(c.label)).join(',')]
    .concat(rows.map(r => columns.map(c => q(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(',')));
  return '﻿' + lines.join('\r\n');
}

const PLAN_COLUMNS = [
  { key: 'level', label: 'Level' }, { key: 'menuPath', label: 'Parent path' }, { key: 'title', label: 'Menu item / page' },
  { key: 'order', label: 'Order' }, { key: 'sourceType', label: 'D10 type' }, { key: 'nid', label: 'D10 nid' },
  { key: 'oldUrl', label: 'Old URL' }, { key: 'd10Published', label: 'Published in D10' }, { key: 'importAs', label: 'Import as' },
  { key: 'row', label: 'Sheet row' }, { key: 'body', label: 'Body' }, { key: 'attachments', label: 'Attachments' }, { key: 'faqs', label: 'FAQ accordions' },
  { key: 'linksToPages', label: 'Links to new pages' }, { key: 'linksToMedia', label: 'Links to uploaded media' },
  { key: 'linksToOldSite', label: 'Links left on old site' }, { key: 'dropped', label: 'Dropped markup' },
  { key: 'notes', label: 'Not carried over' }
];

// One row per link in converted content: where it pointed and where it points now.
const LINK_COLUMNS = [
  { key: 'page', label: 'Page' }, { key: 'nid', label: 'D10 nid' }, { key: 'href', label: 'Link in D10' },
  { key: 'type', label: 'Kind' }, { key: 'outcome', label: 'Now points to' }, { key: 'result', label: 'New link' },
  { key: 'reason', label: 'Why' }
];

// Media that will be (or was) uploaded.
const MEDIA_COLUMNS = [
  { key: 'mid', label: 'D10 media id' }, { key: 'kind', label: 'Kind' }, { key: 'name', label: 'Name' },
  { key: 'fileName', label: 'File' }, { key: 'alt', label: 'Alt text' }, { key: 'url', label: 'Old URL' },
  { key: 'usedBy', label: 'Used by pages' }
];

const SKIPPED_COLUMNS = [
  { key: 'sourceType', label: 'D10 type' }, { key: 'nid', label: 'D10 nid' }, { key: 'title', label: 'Title' },
  { key: 'alias', label: 'Old URL' }, { get: r => r.published ? 'yes' : 'no', label: 'Published in D10' },
  { key: 'parent', label: 'Parent' }, { key: 'reason', label: 'Why skipped' }
];

module.exports = { toCsv, PLAN_COLUMNS, SKIPPED_COLUMNS, LINK_COLUMNS, MEDIA_COLUMNS };
