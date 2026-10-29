'use strict';
// Publishes a new version to the public releases repo, which every installed copy of the script checks for updates.
//   npm run release              bump the patch version (0.3.0 -> 0.3.1), test, build, copy, commit
//   npm run release -- minor     bump the minor version (0.3.0 -> 0.4.0)
//   npm run release -- none      keep the version (first publish, or re-publishing the same version)
// The releases repo is a local clone next to this one (../streamline-importer-releases, or --to <folder>).
// Only tracked files are copied, minus the ones listed in PRIVATE. Pushing is left to you: it needs your GitHub login.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Kept out of the public repo: the Streamline API schema read from the sandbox, and local tool settings.
const PRIVATE = [/^docs\/schema\.graphql$/, /^docs\/schema-check\.txt$/, /^\.claude\//];

const args = process.argv.slice(2);
const bump = ['patch', 'minor', 'major', 'none'].find(a => args.includes(a)) || 'patch';
const toIdx = args.indexOf('--to');
const target = path.resolve(toIdx >= 0 ? args[toIdx + 1] : path.join(ROOT, '..', 'streamline-importer-releases'));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

if (!fs.existsSync(path.join(target, '.git'))) {
  console.error('No git repo at ' + target + '.\nClone it first: git clone https://github.com/' + require('../package.json').releaseRepo.name + '.git "' + target + '"');
  process.exit(1);
}
if (git(ROOT, 'status', '--porcelain', '--untracked-files=no')) {
  console.error('This repo has uncommitted changes. Commit them first, so the release matches a commit.');
  process.exit(1);
}

// 1. Version.
const pkgFile = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
if (bump !== 'none') {
  const v = pkg.version.split('.').map(Number);
  if (bump === 'major') { v[0]++; v[1] = 0; v[2] = 0; } else if (bump === 'minor') { v[1]++; v[2] = 0; } else v[2]++;
  pkg.version = v.join('.');
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}
console.log('Releasing v' + pkg.version);

// 2. Build and test. Stops on any failure.
// Build first, so the tests (which parse dist/) check the file that is about to ship.
execFileSync(process.execPath, ['build.js'], { cwd: ROOT, stdio: 'inherit' });
execFileSync(process.execPath, ['--test', ...fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f))], { cwd: ROOT, stdio: 'inherit' });
// Commit the version and the fresh build here too, so this repo and the release always match.
git(ROOT, 'add', 'package.json', 'dist');
if (git(ROOT, 'status', '--porcelain', '--untracked-files=no')) git(ROOT, 'commit', '-m', 'Release v' + pkg.version);

// 3. Copy the public file set, and remove files that are no longer part of it.
const files = git(ROOT, 'ls-files').split('\n').filter(f => f && !PRIVATE.some(re => re.test(f)));
for (const f of git(target, 'ls-files').split('\n').filter(Boolean)) if (!files.includes(f)) fs.rmSync(path.join(target, f));
for (const f of files) {
  const dest = path.join(target, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), dest);
}

// 4. Commit in the releases repo.
git(target, 'add', '-A');
if (!git(target, 'status', '--porcelain')) { console.log('Nothing changed in the releases repo.'); process.exit(0); }
git(target, 'commit', '-m', 'v' + pkg.version);
console.log('\nCommitted v' + pkg.version + ' in ' + target + ' (' + files.length + ' files).');
console.log('Publish it:  git -C "' + target + '" push');
console.log('Installed copies pick it up at their next update check (about once a day, or "Check for userscript updates" in Tampermonkey).');
