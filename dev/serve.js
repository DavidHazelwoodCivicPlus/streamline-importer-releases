'use strict';
// Local static server for the UI harness: http://localhost:8765/dev/harness.html
// /sample/<site>/<file> serves the sample exports from SI_SAMPLE_ROOT (default: Downloads) so the
// harness can load them: the first folder named <site> holding www-pages.json, up to three levels down.
// /proxy?url=<https url> fetches an old-site file, standing in for Tampermonkey's GM_xmlhttpRequest when the
// built script is loaded into a sandbox page by hand. Listens on 127.0.0.1 only.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SAMPLE_ROOT = path.resolve(process.env.SI_SAMPLE_ROOT || path.join(require('os').homedir(), 'Downloads'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

// The export folder for a site name, searched breadth-first under SAMPLE_ROOT.
const found = new Map();
function sampleDir(site) {
  if (found.has(site)) return found.get(site);
  let level = [SAMPLE_ROOT], dir = null;
  for (let depth = 0; depth < 4 && !dir && level.length; depth++) {
    const next = [];
    for (const d of level) {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()); } catch (e) { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.name === site && fs.existsSync(path.join(p, 'www-pages.json'))) { dir = p; break; }
        next.push(p);
      }
      if (dir) break;
    }
    level = next;
  }
  found.set(site, dir);
  return dir;
}

// Old-site files for the hand-loaded script, following redirects.
function proxy(target, res, hops) {
  let u;
  try { u = new URL(target); } catch (e) { res.writeHead(400); return res.end('bad url'); }
  if (!/^https?:$/.test(u.protocol)) { res.writeHead(400); return res.end('bad url'); }
  (u.protocol === 'https:' ? https : http).get(u, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) { r.resume(); return proxy(new URL(r.headers.location, u).href, res, hops + 1); }
    res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'application/octet-stream' });
    r.pipe(res);
  }).on('error', e => { res.writeHead(502); res.end(e.message); });
}

http.createServer((req, res) => {
  // A sandbox page (https, public) may call this local server: allow it, including Chrome's private-network check.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', '*'); res.writeHead(204); return res.end(); }
  if (req.url.startsWith('/proxy?')) return proxy(new URLSearchParams(req.url.slice(7)).get('url') || '', res, 0);
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  const m = /^\/sample\/([\w-]+)\/(www-[\w]+\.json)$/.exec(url);
  if (m) file = sampleDir(m[1]) ? path.join(sampleDir(m[1]), m[2]) : '';
  else if (/^\/sample\/([\w-]+)\/$/.test(url)) {
    const dir = sampleDir(url.split('/')[2]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(dir ? fs.readdirSync(dir).filter(f => /^www-.*\.json$/.test(f)) : []));
  } else file = path.join(ROOT, path.normalize(url).replace(/^([\\/]\.\.)+/, ''));
  if (!file || (!file.startsWith(ROOT) && !file.startsWith(SAMPLE_ROOT))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8765, '127.0.0.1', () => console.log('Harness: http://localhost:8765/dev/harness.html'));
