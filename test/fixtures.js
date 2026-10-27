'use strict';
// Small made-up D10 records in the real export's shape. No client data.

const page = (nid, title, ms, extra) => ({
  entity_id: String(nid), entity_type: 'node', bundle: 'page', is_published: extra && 'published' in extra ? extra.published : true,
  fields: Object.assign({
    nid: [{ value: String(nid) }], uuid: [{ value: 'uuid-' + nid }], title: [{ value: title }],
    path: [{ alias: '/ms' + ms + '/page/' + title.toLowerCase().replace(/\W+/g, '-'), pid: '1', langcode: 'en' }],
    body: [{ value: '<p>' + title + '</p>' }],
    og_audience: ms == null ? [] : [{ target_id: String(ms) }],
    field_news_date: null, field_smart_date: []
  }, (extra && extra.fields) || {})
});

const microsite = (nid, title, alias, extra) => ({
  entity_id: String(nid), entity_type: 'node', bundle: 'microsite', is_published: true,
  fields: Object.assign({ nid: [{ value: String(nid) }], title: [{ value: title }], path: [{ alias }] }, (extra && extra.fields) || {})
});

function exportFiles() {
  const microsites = [
    microsite(1, 'Home Page', '/home-page'),
    microsite(10, 'Utilities', '/utilities'),
    microsite(20, 'About Us', '/about-us'),
    microsite(30, 'Police', '/police'),
    microsite(40, 'Empty Board ', '/bc-empty')
  ];
  const pages = [
    page(101, 'Water', 10), page(102, 'billing', 10), page(103, 'Alerts', 10, { published: false }),
    page(201, 'Welcome', 20), page(202, '  History   of Town ', 20, { fields: { body: [] } }),
    page(301, 'Press release', 30, { fields: { field_news_date: ['2017-08-25'] } }),
    page(302, 'Night Out', 30, { fields: { field_smart_date: [{ value: '1507525200', end_value: '1507525200' }] } }),
    page(303, 'Records', 30, { fields: { field_page_redirect: [{ uri: 'internal:/calendar' }] } }),
    page(401, 'Home extra', 1),
    page(501, 'Orphan', null),
    page(601, 'Lost', 999)
  ];
  return [
    { name: 'www-pages.json', text: JSON.stringify(pages) },
    { name: 'www-microsites.json', text: JSON.stringify(microsites) },
    { name: 'www-faqs.json', text: '[]' }
  ];
}

module.exports = { page, microsite, exportFiles };
