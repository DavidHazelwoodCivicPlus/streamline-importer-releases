'use strict';
// A made-up D10 export ("Town of Maple Grove") that uses everything the importer handles, so a new user can
// import it, look at the result, and undo it: microsites and pages for the menu, bodies with links between
// pages, file links and embedded images, primary images, every kind of page section (text, accordions,
// image + text, files, slideshow, embedded pages, staff and FAQ sections), every module type, a microsite named
// like a listing (Events), an unpublished page, and right-column cards.
// Its files and images live on SAMPLE_HOST, which does not exist: the importer makes them in the browser
// instead of downloading them (see ui/sampleFiles.js). Pure: sampleExport(now) returns the www-*.json files.

const SAMPLE_HOST = 'sample-site.d10-importer.test';
const SAMPLE_LABEL = 'Sample site (Town of Maple Grove)';
const FILES = 'https://' + SAMPLE_HOST + '/sites/default/files/';

// Every sample file and image. color/label: how the made-up image looks; lines: the made-up PDF's text.
const SAMPLE_MEDIA = [
  { mid: 5001, kind: 'image', fileName: 'town-hall.jpg', name: 'Town Hall', label: 'Maple Grove Town Hall', color: '#2760b0' },
  { mid: 5002, kind: 'image', fileName: 'riverside-park.jpg', name: 'Riverside Park', label: 'Riverside Park', color: '#2e7d32' },
  { mid: 5003, kind: 'image', fileName: 'splash-pad.jpg', name: 'Splash pad', label: 'Splash pad', color: '#0288d1' },
  { mid: 5004, kind: 'image', fileName: 'trail.jpg', name: 'River trail', label: 'River trail', color: '#6d4c41' },
  { mid: 5005, kind: 'image', fileName: 'farmers-market.jpg', name: 'Farmers market', label: 'Farmers market', color: '#ef6c00' },
  { mid: 5006, kind: 'image', fileName: 'staff-mayor.jpg', name: 'Mayor Jordan Avery', label: 'Jordan Avery', color: '#5e35b1' },
  { mid: 5007, kind: 'image', fileName: 'staff-clerk.jpg', name: 'Clerk Sam Rivera', label: 'Sam Rivera', color: '#00897b' },
  { mid: 5008, kind: 'image', fileName: 'recycling.jpg', name: 'Recycling carts', label: 'Recycling carts', color: '#558b2f' },
  { mid: 5009, kind: 'image', fileName: 'main-street.jpg', name: 'Main Street', label: 'Main Street project', color: '#c62828' },
  { mid: 5101, kind: 'file', fileName: 'annual-budget.pdf', name: 'Annual Budget', lines: ['Town of Maple Grove', 'Annual Budget (sample file)'] },
  { mid: 5102, kind: 'file', fileName: 'audit-report.pdf', name: 'Audit Report', lines: ['Town of Maple Grove', 'Audit Report (sample file)'] },
  { mid: 5103, kind: 'file', fileName: 'shelter-rental-form.pdf', name: 'Shelter Rental Form', lines: ['Riverside Park', 'Shelter Rental Form (sample file)'] },
  { mid: 5104, kind: 'file', fileName: 'park-rules.pdf', name: 'Park Rules', lines: ['Maple Grove Parks', 'Park Rules (sample file)'] },
  { mid: 5105, kind: 'file', fileName: 'council-agenda.pdf', name: 'Council Agenda', lines: ['Town Council', 'Agenda (sample file)'] },
  { mid: 5106, kind: 'file', fileName: 'council-packet.pdf', name: 'Council Agenda Packet', lines: ['Town Council', 'Agenda Packet (sample file)'] },
  { mid: 5107, kind: 'file', fileName: 'council-minutes.pdf', name: 'Council Minutes', lines: ['Town Council', 'Minutes (sample file)'] },
  { mid: 5108, kind: 'file', fileName: 'recycling-guide.pdf', name: 'Recycling Guide', lines: ['Maple Grove Public Works', 'Recycling Guide (sample file)'] },
  { mid: 5109, kind: 'file', fileName: 'bid-specifications.pdf', name: 'Bid Specifications', lines: ['Main Street Paving', 'Bid Specifications (sample file)'] },
  { mid: 5110, kind: 'file', fileName: 'job-description.pdf', name: 'Job Description', lines: ['Parks Maintenance Worker', 'Job Description (sample file)'] },
  { mid: 5201, kind: 'video', name: 'Council meeting recording', url: 'https://www.youtube.com/watch?v=sample-maple-grove' }
];
const MEDIA_BY_FILE = new Map(SAMPLE_MEDIA.filter(m => m.fileName).map(m => [m.fileName, m]));
const sampleMediaFor = url => {
  try { const u = new URL(url); return u.host === SAMPLE_HOST ? MEDIA_BY_FILE.get(u.pathname.split('/').pop()) || null : null; } catch (e) { return null; }
};
const isSampleUrl = url => /^https:\/\/sample-site\.d10-importer\.test\//i.test(String(url || ''));

// ---------- record helpers (the export's shapes) ----------
const v = x => [{ value: x }];
const ref = (...ids) => ids.map(id => ({ target_id: String(id) }));
const link = (uri, title) => ({ uri, title });
const slug = s => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const addr = (line1, extra) => [Object.assign({ address_line1: line1, locality: 'Maple Grove', administrative_area: 'MN', postal_code: '55311', country_code: 'US' }, extra || {})];
const uuidOf = mid => 'sample-media-' + mid;
const img = mid => '<drupal-media data-entity-type="media" data-entity-uuid="' + uuidOf(mid) + '" data-align="center"></drupal-media>';
const fileLink = (mid, text) => '<a href="/media/' + mid + '">' + text + '</a>';
const nodeLink = (nid, text) => '<a href="/node/' + nid + '">' + text + '</a>';

let pid = 7000;
const para = (bundle, fields) => { const id = ++pid; return { target_id: String(id), entity: { entity_id: String(id), bundle, fields } }; };
const text = (header, html, collapsing, headerType) => para('text', { field_embed_header: v(header || ''), field_header_type: v(headerType || 'h2'), field_collapsing_options: v(collapsing || 'none'), field_text: v(html) });
const imageText = (mid, position, html, linkTo) => para('image_text', Object.assign({ field_image: ref(mid), field_position: v(position), field_collapsing_options: v('none'), field_text: v(html) }, linkTo ? { field_image_link: [linkTo] } : {}));
const files = (header, ...mids) => para('files', { field_embed_header: v(header), field_header_type: v('h2'), field_collapsing_options: v('none'), field_file_source: v('individual'), field_files: ref(...mids) });
const slideshow = (html, ...mids) => para('slideshow', { field_images: ref(...mids), field_text: v(html), field_collapsing_options: v('none') });
const embedded = (header, ...nids) => para('embedded_pages', { field_embed_header: v(header), field_embed_type: v('individual'), field_embed_individual: ref(...nids) });
const faqSection = (header, cat) => para('faqs', { field_embed_header: v(header), field_faq_category: ref(cat), field_collapsing_options: v('collapsed') });
const staffPeople = (header, ...nids) => para('embedded_directory_listings', { field_embed_header: v(header), field_embed_type: v('individual'), field_contact_info_individual: ref(...nids) });
const staffDept = (header, ms) => para('embedded_directory_listings', { field_embed_header: v(header), field_embed_type: v('department'), field_contact_info_department: ref(ms) });
const staffGroup = (header, term) => para('embedded_directory_listings', { field_embed_header: v(header), field_embed_type: v('custom_group'), field_contact_info_custom_group: ref(term) });

const node = (nid, bundle, title, alias, fields, published) => ({
  entity_id: String(nid), entity_type: 'node', bundle, is_published: published !== false,
  fields: Object.assign({ nid: v(String(nid)), uuid: v('sample-node-' + nid), title: v(title), path: [{ alias, langcode: 'en' }] }, fields || {})
});

// ---------- the export ----------
// now: ms. Dates are set around the day it is made, so there are always upcoming and past events and meetings.
function sampleExport(now) {
  pid = 7000;
  const day = Math.floor((now == null ? Date.now() : now) / 86400000) * 86400000;
  const at = (days, hour, minutes) => String(Math.floor((day + days * 86400000 + (hour || 0) * 3600000 + (minutes || 0) * 60000) / 1000));
  const iso = (days, hour) => new Date(day + days * 86400000 + (hour || 0) * 3600000).toISOString().slice(0, 19);
  const smart = (days, hour, hours) => ({ value: at(days, hour), end_value: at(days, hour + (hours || 1)) });

  // Terms: FAQ categories, a staff group, park amenities, project and ordinance statuses.
  const terms = [
    [901, 'Town Hall'], [902, 'Trash & Recycling'], [903, 'Parks'], [950, 'Public Works Crew'],
    [961, 'Playground'], [962, 'Restrooms'], [963, 'Picnic shelter'], [964, 'Trails'],
    [971, 'In progress'], [972, 'Road reconstruction'], [981, 'Adopted']
  ].map(([id, name]) => ({ entity_id: String(id), entity_type: 'taxonomy_term', bundle: 'tags', is_published: true, fields: { name: v(name) } }));

  const ms = (nid, title, fields) => node(nid, 'microsite', title, '/' + slug(title), fields);
  const microsites = [
    ms(100, 'Home Page', { body: v('<p>The homepage is not imported: the site already has one.</p>') }),
    ms(110, 'Town Government', {
      body: v('<p>Maple Grove is governed by a mayor and a four-member town council. Council meets on the first and third Monday of each month at ' + nodeLink(3001, 'Town Hall') + '.</p>'),
      field_primary_image_video: ref(5001),
      field_sections: [staffDept('Town Staff', 110), faqSection('Town Hall Questions', 901)]
    }),
    ms(120, 'Parks & Recreation', {
      body: v('<p>Twelve parks, eight miles of trails and programs for every age. See ' + nodeLink(1201, 'Riverside Park') + ' for our largest park, or browse every park on the ' + nodeLink(2601, 'Parks') + ' pages.</p>'),
      field_primary_image_video: ref(5002),
      field_sections: [faqSection('Park Questions', 903)]
    }),
    ms(130, 'Residents', { body: v('<p>Everything you need to live in Maple Grove: utilities, trash and recycling, and guides for new residents.</p>') }),
    ms(140, 'Events', { body: v('<p>Community events in Maple Grove. This page shows how a D10 microsite named like a listing page becomes that listing: every event is listed below.</p>') })
  ];

  const pg = (nid, msId, title, fields, published) => node(nid, 'page', title, '/' + slug(microsites.find(m => m.entity_id === String(msId)).fields.title[0].value) + '/page/' + slug(title),
    Object.assign({ og_audience: ref(msId), field_news_date: null, field_smart_date: [] }, fields || {}), published);

  const pages = [
    // ---- Town Government ----
    pg(1101, 110, 'Mayor & Council', {
      body: v('<p>The council sets town policy, adopts the budget and appoints the town clerk. Agendas and minutes are on the ' + nodeLink(2301, 'meeting pages') + '.</p>'),
      field_sections: [
        staffPeople('Council Members', 2101, 2103, 2104),
        text('How to address the council', '<p>Public comment is welcome at every regular meeting. Sign in before the meeting starts and keep comments to three minutes.</p>', 'collapsed', 'h3'),
        files('Budget documents', 5101, 5102)
      ]
    }),
    pg(1102, 110, 'Town Clerk', {
      body: v('<p>The clerk keeps the town\'s records, runs elections and issues licenses.</p>' +
        '<h2>Contact</h2><p>Email <a href="mailto:clerk@maplegrove.example">clerk@maplegrove.example</a> or call <a href="tel:+15555550100">555-555-0100</a>. ' +
        'The office is in ' + nodeLink(3001, 'Town Hall') + '.</p>' +
        '<h2>Records requests</h2><p>Most records are free. See the ' + fileLink(5102, 'latest audit report') + ' and the ' + fileLink(5101, 'annual budget') + ', or ask the ' + nodeLink(1101, 'council') + '.</p>' +
        '<p>' + img(5007) + '</p>' +
        '<p>State election information is on the <a href="https://www.sos.state.mn.us/">Secretary of State\'s site</a> (an external link, kept as it is).</p>'),
      field_primary_image_video: ref(5001),
      field_file_attachments: ref(5101)
    }),
    pg(1103, 110, 'Budget & Finance', {
      body: v('<p>The annual budget runs January to December. Questions go to the ' + nodeLink(1102, 'Town Clerk') + '.</p>'),
      field_sections: [
        text('Budget calendar', '<ul><li>August: departments submit requests</li><li>September: preliminary levy</li><li>December: final budget adopted</li></ul>', 'open', 'h2'),
        text('Where the money goes', '<p>Public safety 38%, public works 27%, parks 14%, administration 12%, debt 9%.</p>', 'collapsed', 'h2'),
        files('Reports', 5101, 5102)
      ]
    }),
    pg(1104, 110, 'Holiday Schedule (draft)', { body: v('<p>This page is unpublished in D10. It is imported published unless Options → "Pages that are unpublished in D10" says otherwise.</p>') }, false),
    // ---- Parks & Recreation ----
    pg(1201, 120, 'Riverside Park', {
      body: v('<p>Riverside Park sits on 40 acres along the river, with a splash pad, picnic shelters and the start of the river trail.</p>'),
      field_primary_image_video: ref(5002),
      field_sections: [
        imageText(5003, 'left', '<h3>Splash pad</h3><p>Open daily, Memorial Day to Labor Day, 10 AM to 8 PM. Free.</p>'),
        imageText(5004, 'right', '<h3>River trail</h3><p>A paved 3-mile loop. Dogs on leashes are welcome.</p>', link('internal:/node/2602', 'Mill Pond Trailhead')),
        slideshow('<p>Scenes from the park.</p>', 5002, 5003, 5004, 5005),
        files('Rentals', 5103, 5104)
      ]
    }),
    pg(1202, 120, 'Programs & Classes', {
      body: v('<p>Register online or at the ' + nodeLink(3002, 'Community Center') + '. Fee assistance is available.</p>'),
      field_sections: [
        text('Youth programs', '<p>Summer camps, swim lessons and T-ball for ages 4 to 14.</p>', 'collapsed', 'h3'),
        text('Adult programs', '<p>Pickleball leagues, yoga in the park and pottery classes.</p>', 'collapsed', 'h3'),
        text('Seniors', '<p>Walking club, card games and monthly lunches at the Community Center.</p>', 'collapsed', 'h3')
      ]
    }),
    pg(1203, 120, 'Facility Rentals', {
      body: v('<p>Shelters, the Community Center hall and athletic fields can be rented. Download the ' + fileLink(5103, 'shelter rental form') + '.</p>'),
      field_sections: [embedded('Places to rent', 2601, 2602, 3002, 1201), staffPeople('Rental Coordinator', 2105)]
    }),
    // ---- Residents ----
    pg(1301, 130, 'New Residents Guide', {
      body: v('<p>Welcome to Maple Grove! A few places to start:</p><ul>' +
        '<li>' + nodeLink(1302, 'Trash & Recycling') + ' (a page in the menu)</li>' +
        '<li>' + nodeLink(120, 'Parks & Recreation') + ' (a microsite)</li>' +
        '<li>' + nodeLink(1401, 'Leaf pickup starts soon') + ' (a news item)</li>' +
        '<li>' + nodeLink(1501, 'Farmers Market') + ' (an event)</li>' +
        '<li>' + nodeLink(2401, 'Parks Maintenance Worker') + ' (a job opening)</li>' +
        '<li><a href="https://' + SAMPLE_HOST + '/town-government/page/town-clerk">Town Clerk</a> (a full link to the old site, which becomes a link to the new page)</li>' +
        '<li>' + fileLink(5108, 'Recycling guide (PDF)') + ' (a file, uploaded)</li></ul>' +
        '<p>' + img(5009) + '</p>'),
      field_primary_image_video: ref(5009)
    }),
    pg(1302, 130, 'Trash & Recycling', {
      body: v('<p>Trash and recycling are picked up weekly. Put carts at the curb by 7 AM.</p><p>' + img(5008) + '</p>'),
      field_sections: [
        files('Guides', 5108),
        faqSection('Trash & Recycling FAQs', 902),
        staffGroup('Public Works Crew', 950)
      ]
    }),
    // ---- Events microsite: one ordinary page ----
    pg(1601, 140, 'Event Guidelines', { body: v('<p>Planning an event on town property? Apply 30 days ahead with the ' + nodeLink(1102, 'Town Clerk') + '.</p>') }),
    // ---- News (pages with a news date) ----
    pg(1401, 130, 'Leaf pickup starts soon', { field_news_date: v(iso(-2)), body: v('<p>Curbside leaf pickup runs for four weeks. Bag leaves in paper bags. See the ' + fileLink(5108, 'recycling guide') + '.</p>'), field_primary_image_video: ref(5008) }),
    pg(1402, 110, 'Council adopts next year\'s budget', { field_news_date: v(iso(-9)), body: v('<p>The council adopted the budget at its last meeting. Read the ' + fileLink(5101, 'annual budget') + '.</p>'), field_file_attachments: ref(5101) }),
    pg(1403, 120, 'Splash pad closes for the season', { field_news_date: v(iso(-30)), body: v('<p>Thanks for a great summer at ' + nodeLink(1201, 'Riverside Park') + '!</p>'), field_primary_image_video: ref(5003) }),
    pg(1404, 130, 'Main Street paving project update', { field_news_date: v(iso(-45)), body: v('<p>Paving is on schedule. See the ' + nodeLink(2701, 'project page') + '.</p>'), field_primary_image_video: ref(5009) }),
    // ---- Events (pages with dates): upcoming, recurring and past ----
    pg(1501, 140, 'Farmers Market', {
      field_smart_date: [smart(3, 15, 4), smart(10, 15, 4), smart(17, 15, 4), smart(24, 15, 4)],
      field_location_ref: ref(3001), field_contact_information_body: v('<p>Market manager: market@maplegrove.example</p>'),
      body: v('<p>Local produce, baked goods and crafts every week.</p>'), field_primary_image_video: ref(5005)
    }),
    pg(1502, 140, 'Fall Festival', { field_smart_date: [smart(12, 16, 5)], field_location_ref: ref(2601), body: v('<p>Hayrides, pumpkin carving and a chili cook-off at ' + nodeLink(1201, 'Riverside Park') + '.</p>') }),
    pg(1503, 140, 'Tree Lighting', { field_smart_date: [smart(40, 23, 2)], field_location_ref: ref(3001), body: v('<p>Hot cocoa and carols on the Town Hall lawn.</p>') }),
    pg(1504, 120, 'Trail Cleanup Day', { field_smart_date: [smart(6, 14, 3)], field_location_ref: ref(2602), body: v('<p>Gloves and bags provided.</p>') }),
    pg(1505, 140, 'Summer Concert Series', { field_smart_date: [smart(-60, 0, 2), smart(-53, 0, 2)], field_location_ref: ref(2601), body: v('<p>Thanks to everyone who came out this summer.</p>') }),
    pg(1506, 140, 'Spring Cleanup', { field_smart_date: [smart(-150, 14, 6)], body: v('<p>Free drop-off of bulky items.</p>') })
  ];

  // ---- Module records ----
  const rec = (nid, bundle, title, base, fields, published) => node(nid, bundle, title, '/' + base + '/' + slug(title), fields, published);
  const people = [
    [2101, 'Jordan Avery', 'Avery', 'Mayor', 110, 5006, 0], [2102, 'Sam Rivera', 'Rivera', 'Town Clerk', 110, 5007, 1],
    [2103, 'Priya Shah', 'Shah', 'Council Member', 110, null, 2], [2104, 'Marcus Lee', 'Lee', 'Council Member', 110, null, 3],
    [2105, 'Dana Brooks', 'Brooks', 'Recreation Coordinator', 120, null, 0], [2106, 'Chris Novak', 'Novak', 'Public Works Lead', 130, null, 0],
    [2107, 'Alex Kim', 'Kim', 'Equipment Operator', 130, null, 1]
  ].map(([nid, name, last, position, msId, photo, weight]) => rec(nid, 'directory_listing', name, 'directory', Object.assign({
    field_first_name: v(name.split(' ')[0]), field_last_name: v(last), field_position: v(position),
    field_email: v(slug(name).replace(/-/g, '.') + '@maplegrove.example'), field_phone_number: v('555-555-01' + String(nid).slice(-2)),
    field_office_hours: v('Monday to Friday, 8 AM to 4:30 PM'), field_weight: v(String(weight)), og_audience: ref(msId),
    field_standard_location: ref(3001), field_profile: v('<p>' + name + ' has served Maple Grove since 2019.</p>'),
    field_directory_list_group: nid >= 2106 ? ref(950) : []
  }, photo ? { field_primary_image_video: ref(photo) } : {})));

  const meeting = (nid, title, days, extra) => rec(nid, 'meeting', title, 'meetings', Object.assign({
    og_audience: ref(110), field_smart_date: [smart(days, 23, 2)], field_standard_location: ref(3001),
    field_short_description: v('Regular meeting of the ' + title + '.'), body: v('<p>The public is welcome. Agenda items are listed in the agenda below.</p>')
  }, extra || {}));
  const meetings = [
    meeting(2301, 'Town Council', 5, { field_agendas: ref(5105), field_packets_files: ref(5106) }),
    meeting(2302, 'Park Board', 9, { og_audience: ref(120), field_agendas: ref(5105) }),
    meeting(2303, 'Town Council', -9, { field_agendas: ref(5105), field_packets_files: ref(5106), field_minutes_files: ref(5107), field_meeting_video: ref(5201), field_audio_links: [link('https://www.example.com/maple-grove/council-audio.mp3', 'Audio recording')] }),
    meeting(2304, 'Planning Commission', -20, { field_minutes_files: ref(5107), field_video_links: [link('https://www.youtube.com/watch?v=sample-planning', 'Watch the meeting')], field_other_meeting_files: ref(5109) })
  ];

  const faq = (nid, q, a, cat, msId, weight) => rec(nid, 'faq', q, 'faq', { body: v(a), field_faq_category: ref(cat), og_audience: ref(msId), field_faq_weight: v(String(weight)) });
  const faqs = [
    faq(2201, 'When is Town Hall open?', '<p>Monday to Friday, 8 AM to 4:30 PM, except holidays.</p>', 901, 110, 0),
    faq(2202, 'How do I get a copy of a public record?', '<p>Ask the ' + nodeLink(1102, 'Town Clerk') + '. Most records are free.</p>', 901, 110, 1),
    faq(2203, 'What goes in the recycling cart?', '<p>Paper, cardboard, cans and plastic bottles. See the ' + fileLink(5108, 'recycling guide') + '.</p>', 902, 130, 0),
    faq(2204, 'My cart was missed. What do I do?', '<p>Call Public Works by noon the next day.</p>', 902, 130, 1),
    faq(2205, 'Can I bring my dog to the park?', '<p>Yes, on a leash of 6 feet or less.</p>', 903, 120, 0),
    faq(2206, 'Do I need a permit for a picnic?', '<p>Only for groups over 50. See ' + nodeLink(1203, 'Facility Rentals') + '.</p>', 903, 120, 1)
  ];

  const business = [
    rec(2501, 'business_directory', 'Grove Hardware', 'business', { field_address: addr('120 Main Street'), body: v('<p>Hardware, paint and garden supplies.</p>') }),
    rec(2502, 'business_directory', 'Maple Leaf Cafe', 'business', { field_address: addr('15 River Road'), body: v('<p>Breakfast and lunch, seven days a week.</p>') })
  ];
  const jobs = [
    rec(2401, 'job', 'Parks Maintenance Worker', 'jobs', { field_job_status: v('open'), field_job_closing_date: v(iso(21, 17)), body: v('<p>Full time. Mows, trims and maintains parks and trails. See the ' + fileLink(5110, 'job description') + '.</p>'), field_file_attachments: ref(5110) }),
    rec(2402, 'job', 'Seasonal Lifeguard', 'jobs', { field_job_status: v('closed'), field_job_closing_date: v(iso(-40, 17)), body: v('<p>Summer position at the splash pad.</p>') })
  ];
  const bids = [
    rec(2801, 'bid', 'Main Street Paving', 'bids', { field_bid_status: v('open'), field_date: v(iso(14, 14)), body: v('<p>Sealed bids are due at Town Hall.</p>'), field_file_attachments: ref(5109) }),
    rec(2802, 'bid', 'Snow Removal Services', 'bids', { field_bid_status: v('awarded'), field_date: v(iso(-60, 14)), body: v('<p>Awarded to the lowest responsible bidder.</p>') })
  ];
  const ordinances = [
    rec(2901, 'ordinance', 'Ordinance 2026-04: Parking on Main Street', 'ordinances', { field_ordinance_resolution_id: v('2026-04'), field_ordinance_resolution_statu: ref(981), body: v('<p>Limits parking on Main Street to two hours.</p>') }),
    rec(2902, 'ordinance', 'Resolution 2026-11: Fee Schedule', 'ordinances', { field_ordinance_resolution_id: v('2026-11'), field_ordinance_resolution_statu: ref(981), body: v('<p>Sets town fees for the coming year.</p>') })
  ];
  const parks = [
    rec(2601, 'park', 'Riverside Park Grounds', 'parks', { field_address: addr('500 River Road'), field_amenities: ref(961, 962, 963), field_hours: v('<p>6 AM to 10 PM</p>'), field_rules_regulations: v('<p>No glass containers. Dogs on leashes.</p>'), body: v('<p>The town\'s largest park. More on the ' + nodeLink(1201, 'Riverside Park') + ' page.</p>'), field_primary_image_video: ref(5002) }),
    rec(2602, 'park', 'Mill Pond Trailhead', 'parks', { field_address: addr('1 Mill Pond Lane'), field_amenities: ref(964, 962), field_hours: v('<p>Dawn to dusk</p>'), body: v('<p>Parking and the north end of the river trail.</p>'), field_primary_image_video: ref(5004) })
  ];
  const projects = [
    rec(2701, 'project', 'Main Street Reconstruction', 'projects', { field_project_status: ref(971), field_project_type: ref(972), field_project_id: v('PW-2026-01'), field_date_received: v(iso(-120)), field_address: addr('Main Street, 1st to 5th Avenue'), body: v('<p>New pavement, sidewalks and lighting. Bids: ' + nodeLink(2801, 'Main Street Paving') + '.</p>'), field_primary_image_video: ref(5009) })
  ];
  const locations = [
    rec(3001, 'standard_location', 'Town Hall', 'locations', { field_address: addr('100 Main Street'), body: v('<p>Council chambers are on the first floor.</p>') }),
    rec(3002, 'standard_location', 'Community Center', 'locations', { field_address: addr('250 Oak Avenue'), body: v('<p>Home of most recreation programs.</p>') })
  ];

  const media = SAMPLE_MEDIA.map(m => {
    const base = { entity_id: String(m.mid), entity_type: 'media', bundle: m.kind === 'image' ? 'image' : m.kind === 'file' ? 'document' : 'remote_video', is_published: true };
    const fields = { uuid: v(uuidOf(m.mid)), name: v(m.name) };
    if (m.kind === 'image') fields.field_media_image = [{ file_url: FILES + m.fileName, file_name: m.fileName, alt: m.name }];
    else if (m.kind === 'file') fields.field_media_file = [{ file_url: FILES + m.fileName, file_name: m.fileName }];
    else fields.field_media_oembed_video = v(m.url);
    return Object.assign(base, { fields });
  });

  const file = (name, data) => ({ name: 'www-' + name + '.json', text: JSON.stringify(data) });
  return [
    file('pages', pages), file('microsites', microsites), file('media', media), file('taxonomy_terms', terms),
    file('directory_listings', people), file('meetings', meetings), file('faqs', faqs), file('business_directory', business),
    file('jobs', jobs), file('bids_rfps', bids), file('ordinances', ordinances), file('parks', parks), file('projects', projects),
    file('standard_locations', locations)
  ];
}

// A one-page PDF with a few lines of text, for the sample's documents.
function samplePdf(lines) {
  const esc = s => String(s).replace(/[\\()]/g, c => '\\' + c);
  const stream = 'BT /F1 28 Tf 72 700 Td ' + lines.map((l, i) => (i ? '0 -40 Td ' : '') + '(' + esc(l) + ') Tj').join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return out;
}

module.exports = { SAMPLE_HOST, SAMPLE_LABEL, SAMPLE_MEDIA, sampleExport, sampleMediaFor, isSampleUrl, samplePdf };
