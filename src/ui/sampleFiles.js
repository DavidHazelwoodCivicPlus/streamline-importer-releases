'use strict';
// The sample site's images and documents, made in the browser: its old site (lib/sample.js SAMPLE_HOST) does not
// exist. Images are drawn on a canvas (a coloured picture with the image's name), documents are small PDFs.

const { sampleMediaFor, samplePdf } = require('../lib/sample');

function drawImage(m) {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 675;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, c.width, c.height);
  grad.addColorStop(0, m.color); grad.addColorStop(1, '#10223f');
  g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  // A few soft hills, so it reads as a picture rather than a flat block.
  g.fillStyle = 'rgba(255,255,255,.12)';
  for (const [x, r] of [[180, 320], [620, 420], [1080, 300]]) { g.beginPath(); g.arc(x, c.height + 140, r, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#fff'; g.textAlign = 'center';
  g.font = '700 64px sans-serif'; g.fillText(m.label, c.width / 2, c.height / 2);
  g.font = '400 30px sans-serif'; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText('Sample image · Town of Maple Grove', c.width / 2, c.height / 2 + 60);
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('Could not draw the sample image'))), 'image/jpeg', 0.88));
}

// Same shape as main.js download(url): a Promise of a Blob.
function sampleFile(url) {
  const m = sampleMediaFor(url);
  if (!m) return Promise.reject(new Error('Not a sample file: ' + url));
  if (m.kind === 'image') return drawImage(m);
  return Promise.resolve(new Blob([samplePdf(m.lines || [m.name])], { type: 'application/pdf' }));
}

module.exports = { sampleFile };
