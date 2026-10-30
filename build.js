'use strict';
// Bundles src/ (CommonJS modules) into one Tampermonkey userscript: dist/streamline-importer.user.js.
// Each module is wrapped in a function and registered under its path; a tiny require() resolves them.

const fs = require('fs');
const path = require('path');

const pkg = require('./package.json');
const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'dist', 'streamline-importer.user.js');
// Tampermonkey checks META_OUT (the header only) for a higher @version, then downloads OUT. Both are served
// from the public releases repo, so installs update themselves. See scripts/release.js.
const META_OUT = path.join(__dirname, 'dist', 'streamline-importer.meta.js');
const repo = pkg.releaseRepo;
const raw = file => 'https://raw.githubusercontent.com/' + repo.name + '/' + repo.branch + '/dist/' + file;

const header = `// ==UserScript==
// @name         Drupal 10 to Streamline Importer
// @namespace    civicplus.streamline.d10importer
// @version      ${pkg.version}
// @description  Create Streamline pages and the primary menu from a Drupal 10 export (www-*.json). Runs only on the Streamline sites you turn it on for (Tampermonkey menu).
// @match        https://*/*
// @resource     xlsx https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/${repo.name}
// @updateURL    ${raw('streamline-importer.meta.js')}
// @downloadURL  ${raw('streamline-importer.user.js')}
// ==/UserScript==
`;
const note = `// Built ${new Date().toISOString()}. Do not edit; edit src/ and run "npm run build".
`;

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listJs(p) : (e.name.endsWith('.js') ? [p] : []);
  });
}

const id = file => path.relative(SRC, file).replace(/\\/g, '/').replace(/\.js$/, '');
const modules = listJs(SRC).sort().map(f => `  ${JSON.stringify(id(f))}: function (module, exports, require) {\n${fs.readFileSync(f, 'utf8')}\n  }`);

const loader = `
(function () {
  'use strict';
  const defs = {
${modules.join(',\n')}
  };
  const cache = {};
  // Resolves "./x", "../lib/y" relative to the requiring module, the way node does.
  function load(name) {
    if (cache[name]) return cache[name].exports;
    if (!defs[name]) throw new Error('Importer bundle: no module ' + name);
    const module = cache[name] = { exports: {} };
    const dir = name.split('/').slice(0, -1);
    defs[name](module, module.exports, rel => {
      const parts = dir.slice();
      for (const seg of rel.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
      return load(parts.join('/'));
    });
    return module.exports;
  }
  load('main').start(${JSON.stringify(pkg.version)});
})();
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + note + loader);
fs.writeFileSync(META_OUT, header);
console.log('Wrote ' + path.relative(__dirname, OUT) + ' (' + modules.length + ' modules, ' + fs.statSync(OUT).size + ' bytes) and ' + path.relative(__dirname, META_OUT) + ' (v' + pkg.version + ')');
