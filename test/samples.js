'use strict';
// Where the sample D10 exports live on this machine. They are client data and never committed.
// SI_SAMPLE_DIRS (folders separated by ";") overrides; otherwise <home>/Downloads/<site>/<site>.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SITES = ['cityoftieton', 'cityofharvard'];

function sampleDirs() {
  const dirs = process.env.SI_SAMPLE_DIRS
    ? process.env.SI_SAMPLE_DIRS.split(';')
    : SITES.map(s => path.join(os.homedir(), 'Downloads', s, s));
  return dirs.filter(d => d && fs.existsSync(d));
}

const sampleDir = site => sampleDirs().find(d => path.basename(d) === site) || null;

module.exports = { sampleDirs, sampleDir };
