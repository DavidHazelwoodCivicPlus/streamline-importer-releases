'use strict';
// The import history for one site: one manifest per import (batch), oldest first.
// Running the same export again continues that import's manifest (resume, retry failed files);
// a different export starts a new one, so each batch can be undone on its own.
// Pure data helpers; saving (localStorage) is the caller's job.

const man = require('./manifest');

const FORMAT = 'streamline-importer-history';

const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));

// text: the stored history (or null); legacyText: a single manifest stored by versions before 0.10.
function parseHistory(text, host, legacyText) {
  const list = [];
  if (text) {
    try {
      const h = JSON.parse(text);
      if (h && h.format === FORMAT && Array.isArray(h.runs)) {
        for (const r of h.runs) { try { list.push(man.parseManifest(r, host)); } catch (e) { /* skip a damaged entry */ } }
      }
    } catch (e) { /* unreadable: start empty */ }
  }
  if (legacyText) {
    try {
      const m = man.parseManifest(legacyText, host);
      if (!list.some(x => x.runId === m.runId)) list.push(m);
    } catch (e) { /* not a manifest */ }
  }
  return list.filter(m => !man.isEmpty(m)).sort(byCreated);
}

const serialize = list => JSON.stringify({ format: FORMAT, runs: list.filter(m => !man.isEmpty(m)) });

// Adds the manifest, or replaces the one with the same runId. Empty manifests (fully undone) are dropped.
function upsert(list, m) {
  const out = list.filter(x => x.runId !== m.runId);
  if (!man.isEmpty(m)) out.push(m);
  return out.sort(byCreated);
}

const remove = (list, runId) => list.filter(x => x.runId !== runId);

const sourceOf = m => (m.source && m.source.label) || '';

// The import a run of this source continues: the newest one made from the same export, if any.
function forSource(list, sourceLabel) {
  if (!sourceLabel) return null;
  const same = list.filter(m => sourceOf(m) === sourceLabel);
  return same.length ? same[same.length - 1] : null;
}

// The most recently started import (what "Undo last import" removes).
const last = list => list.length ? list[list.length - 1] : null;

// Newest first, for showing.
const newestFirst = list => list.slice().sort(byCreated).reverse();

module.exports = { FORMAT, parseHistory, serialize, upsert, remove, forSource, last, newestFirst, sourceOf };
