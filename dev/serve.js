'use strict';
// Local static server for the UI harness: http://localhost:8765/dev/harness.html
// /sample/<site>/<file> serves the sample exports from SI_SAMPLE_ROOT (default: Downloads) so the
// harness can load them. Listens on 127.0.0.1 only.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SAMPLE_ROOT = process.env.SI_SAMPLE_ROOT || path.join(require('os').homedir(), 'Downloads');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  const m = /^\/sample\/([\w-]+)\/(www-[\w]+\.json)$/.exec(url);
  if (m) file = path.join(SAMPLE_ROOT, m[1], m[1], m[2]);
  else if (/^\/sample\/([\w-]+)\/$/.test(url)) {
    const dir = path.join(SAMPLE_ROOT, url.split('/')[2], url.split('/')[2]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^www-.*\.json$/.test(f)) : []));
  } else file = path.join(ROOT, path.normalize(url).replace(/^([\\/]\.\.)+/, ''));
  if (!file.startsWith(ROOT) && !file.startsWith(path.resolve(SAMPLE_ROOT))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8765, '127.0.0.1', () => console.log('Harness: http://localhost:8765/dev/harness.html'));
