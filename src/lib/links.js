'use strict';
// Decides where every link and media reference in a D10 body points on the new site.
//   /node/N, old aliases, and absolute old-site page URLs -> the new page's URL, if that page is imported
//   /media/N, data-entity-uuid, /sites/.../files/...       -> the uploaded Streamline file or image, if uploaded
// Anything that cannot be resolved is pointed at the old site's absolute URL (so it still works until the old
// site is retired) and reported. Nothing is guessed. Pure: page and media lookups are passed in.

function normPath(p) {
  let s = String(p || '');
  try { s = decodeURI(s); } catch (e) { /* keep as is */ }
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return s || '/';
}

// Indexes built once per export.
function buildLinkIndex(exp) {
  const nodes = new Map();   // nid -> { sourceType, kind, title, alias }
  const aliases = new Map(); // normalized alias -> nid
  for (const p of exp.pages) { nodes.set(p.nid, { sourceType: 'page', kind: p.kind, title: p.title, alias: p.alias }); if (p.alias) aliases.set(normPath(p.alias), p.nid); }
  for (const m of exp.microsites) { nodes.set(m.nid, { sourceType: 'microsite', kind: 'microsite', title: m.title, alias: m.alias }); if (m.alias) aliases.set(normPath(m.alias), m.nid); }
  const media = new Map(), byUuid = new Map(), byPath = new Map();
  for (const m of exp.media || []) {
    media.set(m.mid, m);
    if (m.uuid) byUuid.set(m.uuid, m.mid);
    if (m.url && m.kind !== 'video') { try { byPath.set(normPath(new URL(m.url).pathname), m.mid); } catch (e) { /* bad url */ } }
  }
  return {
    nodes, aliases, media, byUuid, byPath, hosts: new Set((exp.hosts || []).map(h => h.toLowerCase())), origin: exp.origin || '',
    faqCategories: exp.faqCategories || new Map()
  };
}

const keyFor = (idx, nid) => { const n = idx.nodes.get(nid); return n ? n.sourceType + ':' + nid : null; };

// Classifies an href without resolving it. Returns { type, nid?, mid?, path?, url } where type is
// 'node' | 'media' | 'file' | 'alias' | 'internal' | 'external' | 'special'.
function classify(idx, href, attrs) {
  const raw = String(href || '').trim();
  const uuid = attrs && attrs['data-entity-uuid'];
  if (uuid && idx.byUuid.has(uuid) && (!attrs['data-entity-type'] || attrs['data-entity-type'] === 'media')) return { type: 'media', mid: idx.byUuid.get(uuid), url: raw };
  if (/^(mailto:|tel:|sms:|#|javascript:)/i.test(raw)) return { type: 'special', url: raw };
  let path = raw, hash = '';
  if (/^(https?:)?\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw.startsWith('//') ? 'https:' + raw : raw); } catch (e) { return { type: 'external', url: raw }; }
    if (!idx.hosts.has(u.host.toLowerCase())) return { type: 'external', url: raw };
    path = u.pathname + u.search; hash = u.hash;
  } else if (!raw.startsWith('/')) {
    return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? { type: 'external', url: raw } : { type: 'internal', path: '/' + raw, url: raw };
  }
  const h = hash || (/#.*$/.exec(path) || [''])[0];
  const np = normPath(path);
  let m;
  if ((m = /^\/node\/(\d+)$/.exec(np))) return { type: 'node', nid: m[1], hash: h, url: raw };
  if ((m = /^\/media\/(\d+)(?:\/.*)?$/.exec(np))) return { type: 'media', mid: m[1], url: raw };
  if (idx.byPath.has(np)) return { type: 'media', mid: idx.byPath.get(np), url: raw };
  if (/^\/sites\/.+\/files\//.test(np) || /^\/system\/files\//.test(np)) return { type: 'file', path: path.replace(/[#].*$/, ''), url: raw };
  if (idx.aliases.has(np)) return { type: 'alias', nid: idx.aliases.get(np), hash: h, url: raw };
  return { type: 'internal', path: path.replace(/[#].*$/, ''), hash: h, url: raw };
}

// lookups: { pageUrl(key) -> url | null, media(mid) -> { url, kind, id, altText } | null }
// report(entry) is called once per link with { href, type, result, reason, target }.
function makeResolver(idx, lookups, report) {
  const rec = report || (() => {});
  const oldUrl = p => (idx.origin ? idx.origin + (p.startsWith('/') ? p : '/' + p) : p);

  function nodeTarget(c) {
    const key = keyFor(idx, c.nid);
    const n = idx.nodes.get(c.nid);
    const url = key && lookups.pageUrl ? lookups.pageUrl(key) : null;
    if (url) return done(c, { url: url + (c.hash || ''), external: false }, 'page', key);
    const why = !n ? 'links to node ' + c.nid + ', which is not in the export'
      : n.kind !== 'page' && n.kind !== 'microsite' ? 'links to a ' + n.kind + ' ("' + n.title + '"), not imported'
        : 'links to "' + n.title + '", which is not imported';
    return done(c, { url: oldUrl(n && n.alias ? n.alias : '/node/' + c.nid) + (c.hash || ''), external: true }, 'old-site', key, why);
  }
  function mediaTarget(c) {
    const m = idx.media.get(c.mid);
    const up = lookups.media ? lookups.media(c.mid) : null;
    if (up && up.url) return done(c, { url: up.url, external: false }, 'media', 'media:' + c.mid);
    if (!m) return done(c, { url: /^https?:/i.test(c.url) ? c.url : oldUrl(c.url || '/media/' + c.mid), external: true }, 'old-site', null, 'media ' + c.mid + ' is not in www-media.json');
    if (m.kind === 'video') return done(c, { url: m.url, external: true }, 'external', 'media:' + c.mid, 'video link kept as is');
    return done(c, { url: m.url, external: true }, 'old-site', 'media:' + c.mid, '"' + (m.name || m.fileName) + '" is not uploaded');
  }
  function done(c, result, outcome, target, reason) {
    rec({ href: c.url, type: c.type, result: result.url, outcome, target: target || '', reason: reason || '' });
    return result;
  }

  function resolveLink(href, attrs) {
    const c = classify(idx, href, attrs);
    switch (c.type) {
      case 'node': case 'alias': return nodeTarget(c);
      case 'media': return mediaTarget(c);
      case 'file': return done(c, { url: oldUrl(c.path), external: true }, 'old-site', '', 'file not found in www-media.json');
      case 'internal': return done(c, { url: oldUrl(c.path) + (c.hash || ''), external: true }, 'old-site', '', 'old-site path with no matching page');
      case 'special': return done(c, { url: c.url, external: false }, 'kept', '');
      default: return done(c, { url: c.url, external: true }, 'external', '');
    }
  }
  function resolveEmbed(attrs) {
    const c = classify(idx, '', attrs);
    if (c.type !== 'media') return null;
    const m = idx.media.get(c.mid);
    const up = lookups.media ? lookups.media(c.mid) : null;
    if (m && m.kind === 'image' && up && up.id) { rec({ href: 'drupal-media', type: 'media', result: up.url, outcome: 'media', target: 'media:' + c.mid, reason: '' }); return { kind: 'image', id: up.id, url: up.url, altText: m.alt || up.altText || '' }; }
    const r = mediaTarget(c);
    return { kind: 'link', url: r.url, external: r.external, text: m ? (m.name || m.fileName) : 'Document' };
  }
  return { resolveLink, resolveEmbed };
}

// Media a page's body and attachments point at (ids that exist in www-media.json), in first-seen order.
function referencedMedia(idx, html, attachments) {
  const out = [];
  const add = mid => { if (mid && idx.media.has(mid) && !out.includes(mid)) out.push(mid); };
  const re = /<(a|drupal-media|img)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const attrs = {};
    m[2].replace(/([\w-]+)\s*=\s*"([^"]*)"/g, (x, k, v) => { attrs[k.toLowerCase()] = v; });
    const c = classify(idx, attrs.href || attrs.src || '', attrs);
    if (c.type === 'media') add(c.mid);
  }
  for (const a of attachments || []) add(a);
  return out;
}

// HTML appended to a body for its file attachments, so they become ordinary links (rewritten like any other).
function attachmentsHtml(idx, ids) {
  const items = (ids || []).map(id => idx.media.get(id)).filter(Boolean);
  if (!items.length) return '';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return '<h2>Documents</h2><ul>' + items.map(m => '<li><a href="/media/' + esc(m.mid) + '">' + esc(m.name || m.fileName || 'Document') + '</a></li>').join('') + '</ul>';
}

module.exports = { normPath, buildLinkIndex, classify, makeResolver, referencedMedia, attachmentsHtml };
