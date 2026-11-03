'use strict';
// Page sections (text, image + text, files, slideshow), meetings, events, staff and FAQs as pages, and the
// right-column cards that link them. Made-up records in the export's shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const d10 = require('../src/lib/d10');
const { buildLinkIndex } = require('../src/lib/links');
const { buildNavFromD10 } = require('../src/lib/navFromD10');
const { buildPlan } = require('../src/lib/plan');
const { buildPageContent, placeholderLookups } = require('../src/lib/content');
const { moduleEntries, formatDate } = require('../src/lib/modules');
const { page, microsite } = require('./fixtures');

const para = (id, bundle, fields) => ({ target_id: id, entity: { entity_id: String(id), bundle, fields } });
const v = x => [{ value: x }];
const ref = (...ids) => ids.map(id => ({ target_id: id }));
const img = (mid, name) => ({ entity_id: String(mid), bundle: 'image', is_published: true, fields: { uuid: v('u' + mid), name: v(name), field_media_image: [{ file_url: 'https://old.example/files/' + name, file_name: name, alt: name + ' alt' }] } });
const doc = (mid, name) => ({ entity_id: String(mid), bundle: 'file', is_published: true, fields: { uuid: v('u' + mid), name: v(name), field_media_file: [{ file_url: 'https://old.example/files/' + name, file_name: name }] } });

function site() {
  const pages = [
    page(101, 'Parks', 10, { fields: {
      body: v('<p>Intro</p>'),
      field_primary_image_video: ref(900),
      field_sections: [
        para(1, 'text', { field_embed_header: v('Web Links'), field_header_type: v('h2'), field_collapsing_options: v('none'), field_text: v('<ul><li><a href="https://pay.example">Pay</a></li></ul>') }),
        para(2, 'image_text', { field_image: ref(901), field_position: v('left'), field_collapsing_options: v('none'), field_text: v('<p>Pool</p>') }),
        para(3, 'files', { field_embed_header: v('Forms'), field_header_type: v('h3'), field_collapsing_options: v('collapsed'), field_file_source: v('individual'), field_files: ref(950, 951) }),
        para(4, 'slideshow', { field_images: ref(901, 902), field_collapsing_options: v('none') }),
        para(5, 'embedded_directory_listings', { field_embed_header: v('Board Members'), field_embed_type: v('individual'), field_contact_info_individual: ref(702, 701) }),
        para(6, 'faqs', { field_embed_header: v('Questions'), field_faq_category: ref(77) })
      ] } }),
    page(102, 'Fair Day', 10, { fields: { field_smart_date: [{ value: '1704322800', end_value: '1704330000' }] } })
  ];
  const microsites = [microsite(10, 'Parks Department', '/parks')];
  const people = [701, 702, 703].map((nid, i) => ({ entity_id: String(nid), bundle: 'directory_listing', is_published: true, fields: {
    title: v(['Ann Smith', 'Bob Jones', 'Cy Lee'][i]), field_last_name: v(['Smith', 'Jones', 'Lee'][i]), field_position: v('Member'),
    field_email: v('p' + nid + '@town.example'), field_weight: v(String(i)), og_audience: ref(10) } }));
  const meetings = [{ entity_id: '801', bundle: 'meeting', is_published: true, fields: {
    title: v('Park Board'), og_audience: ref(10), field_smart_date: [{ value: '1704322800', end_value: '1704322800' }],
    field_agendas: ref(950), field_video_links: [{ uri: 'https://video.example/1', title: 'Recording' }] } }];
  const faqs = [{ entity_id: '601', bundle: 'faq', is_published: true, fields: { title: v('Can I swim?'), body: v('<p>Yes.</p>'), field_faq_category: ref(77), og_audience: ref(10) } },
    { entity_id: '602', bundle: 'faq', is_published: true, fields: { title: v('Dogs?'), body: v('<p>On a leash.</p>'), field_faq_category: ref(88), og_audience: ref(10) } }];
  const media = [img(900, 'park.jpg'), img(901, 'pool.jpg'), img(902, 'slide.jpg'), doc(950, 'form.pdf'), doc(951, 'rules.pdf')];
  return d10.loadExport([
    { name: 'www-pages.json', text: JSON.stringify(pages) }, { name: 'www-microsites.json', text: JSON.stringify(microsites) },
    { name: 'www-directory_listings.json', text: JSON.stringify(people) }, { name: 'www-meetings.json', text: JSON.stringify(meetings) },
    { name: 'www-faqs.json', text: JSON.stringify(faqs) }, { name: 'www-media.json', text: JSON.stringify(media) }
  ]);
}
const ALL = ['events', 'meetings', 'people', 'faqs'];
const plan = (opts, exp) => { exp = exp || site(); const idx = buildLinkIndex(exp); return { exp, idx, p: buildPlan(buildNavFromD10(exp).tree, Object.assign({ pageContent: 'content', timeZone: 'America/Chicago' }, opts), idx, exp) }; };

test('sections become main-column blocks in D10 order; collapsed ones become accordions', () => {
  const { idx, p } = plan({ modules: ALL });
  const parks = p.pages.find(x => x.title === 'Parks');
  assert.deepEqual(parks.blocks.map(b => [b.kind, b.accordion, b.title]), [['text', false, ''], ['image_text', false, ''], ['files', true, 'Forms'], ['slideshow', false, '']]);
  const c = buildPageContent(parks, idx, placeholderLookups(p), {});
  assert.match(c.html, /data-image-id="pending-900"[\s\S]*Intro/, 'primary image above the body');
  assert.match(c.blocks[0].html, /<h2>Web Links<\/h2>.*pay\.example/);
  assert.match(c.blocks[1].html, /pending-901[\s\S]*Pool/);
  assert.match(c.blocks[2].html, /form\.pdf[\s\S]*rules\.pdf/);
  assert.doesNotMatch(c.blocks[2].html, /<h3>Forms/, 'an accordion carries its heading as its title');
  assert.equal((c.blocks[3].html.match(/resizable-image/g) || []).length, 2);
  for (const mid of ['900', '901', '902', '950', '951']) assert.ok(p.media.includes(mid), 'uploads media ' + mid);
});

test('sections can be turned off', () => {
  const { p } = plan({ includeSections: false, modules: ALL });
  assert.deepEqual(p.pages.find(x => x.title === 'Parks').blocks, []);
});

test('staff, FAQ, meeting and event pages are linked from the right column of the pages that show them', () => {
  const { p } = plan({ modules: ALL });
  const titleOf = k => p.pages.find(x => x.key === k).title;
  const parks = p.pages.find(x => x.title === 'Parks');
  assert.deepEqual(parks.cards.map(c => [c.column, c.title, c.keys.map(titleOf)]), [
    ['gutter', 'Board Members', ['Bob Jones', 'Ann Smith']],
    ['gutter', 'Questions', ['Can I swim?']]
  ]);
  const ms = p.pages.find(x => x.title === 'Parks Department');
  assert.deepEqual(ms.cards.map(c => [c.title, c.keys.map(titleOf)]), [
    ['Staff', ['Ann Smith', 'Bob Jones', 'Cy Lee']],
    ['FAQs', ['Can I swim?', 'Dogs?']],
    ['Meetings', ['Park Board – January 3, 2024']],
    ['Events', ['Fair Day']]
  ]);
  // Floating: entries have no menu item; their listing pages do.
  const inMenu = new Set(p.menu.map(m => m.pageKey));
  assert.ok(!inMenu.has('people:701') && !inMenu.has('faqs:601') && !inMenu.has('meetings:801'));
  assert.ok(inMenu.has('list:people') && inMenu.has('list:meetings'));
  assert.equal(p.pages.find(x => x.title === 'Parks').faqs.length, 0, 'no accordions while FAQs are pages');
});

test('without the FAQs module, FAQ sections are accordions; without staff, staff sections are reported', () => {
  const { p } = plan({ modules: [] });
  const parks = p.pages.find(x => x.title === 'Parks');
  assert.deepEqual(parks.faqs.map(f => f.question), ['Can I swim?']);
  assert.deepEqual(parks.cards, []);
  assert.ok(p.cardIssues.some(i => /select Staff Directory/.test(i.reason)));
});

test('meeting, staff and event pages carry their details, files and links', () => {
  const exp = site();
  const meet = moduleEntries(exp, 'meetings', { timeZone: 'America/Chicago' })[0];
  assert.equal(meet.title, 'Park Board – January 3, 2024');
  assert.match(meet.bodyHtml, /When:<\/strong> January 3, 2024 5:00 PM/);
  assert.match(meet.bodyHtml, /<h2>Agenda<\/h2><ul><li><a href="\/media\/950">form\.pdf/);
  assert.match(meet.bodyHtml, /<h2>Video<\/h2>.*video\.example\/1.*Recording/);
  const ann = moduleEntries(exp, 'people', {}).find(e => e.title === 'Ann Smith');
  assert.match(ann.bodyHtml, /mailto:p701@town\.example/);
  const fair = moduleEntries(exp, 'events', { timeZone: 'America/Chicago' })[0];
  assert.match(fair.bodyHtml, /January 3, 2024 5:00 PM – 7:00 PM/);
  assert.equal(formatDate('1704322800', 'UTC'), 'January 3, 2024 11:00 PM');
});

test('a meeting title carries its date in the site time zone, like its When line', () => {
  const exp = site();
  // 1704322800 = Jan 3 2024 23:00 UTC = Jan 4 in Tokyo.
  assert.equal(moduleEntries(exp, 'meetings', { timeZone: 'Asia/Tokyo' })[0].title, 'Park Board – January 4, 2024');
  assert.equal(moduleEntries(exp, 'meetings', { timeZone: 'America/Chicago' })[0].title, 'Park Board – January 3, 2024');
});

test('a microsite lists only its 10 newest meetings; the rest are on the Meetings listing page', () => {
  const exp = site();
  const base = exp.raw.meetings[0];
  exp.raw.meetings = Array.from({ length: 14 }, (_, i) => Object.assign({}, base, { entity_id: String(900 + i),
    fields: Object.assign({}, base.fields, { field_smart_date: [{ value: String(1704322800 + i * 86400) }] }) }));
  const { p } = plan({ modules: ALL }, exp);
  const ms = p.pages.find(x => x.title === 'Parks Department');
  const meet = ms.cards.find(c => c.title === 'Meetings');
  assert.equal(meet.keys.length, 10);
  assert.equal(meet.keys[0], 'meetings:913', 'newest first');
  assert.equal(p.pages.find(x => x.key === 'list:meetings').cards[0].keys.length, 14);
});

test('a meeting short description that repeats the body is shown once', () => {
  const exp = site();
  Object.assign(exp.raw.meetings[0].fields, { body: v('<p>Regular meeting.</p>'), field_short_description: v('Regular meeting.') });
  const meet = moduleEntries(exp, 'meetings', {})[0];
  assert.equal((meet.bodyHtml.match(/Regular meeting\./g) || []).length, 1);
});
