'use strict';

// Checks the release that's actually live on GitHub, the way every installed
// copy of PixelForge will see it: the updater picks the right installer, a
// checksum is published beside it, and the published bytes match that checksum.
//
//   npx electron tools/verify-published.js             reads the checksum only
//   npx electron tools/verify-published.js --download  also downloads and hashes the installer
//   npx electron tools/verify-published.js --local dist/PixelForge-Setup.exe
//                                                      and checks it's the same file as published
//
// Run it after publishing a release.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const argv = process.argv.slice(2);
const DOWNLOAD = argv.includes('--download');
const localIdx = argv.indexOf('--local');
const LOCAL = localIdx >= 0 ? path.resolve(argv[localIdx + 1] || '') : '';

const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-published-'));
app.setPath('downloads', DOWNLOADS);
const updater = require('../src/main/updater');
const { fetchText, parseSha256, sha256File } = require('../src/main/download');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

app.whenReady().then(async () => {
  try {
    const rel = await updater.checkForUpdates();
    check('latest release is readable', rel.ok, rel.ok ? `v${rel.latest}` : rel.error);
    if (!rel.ok) throw new Error('stopping');

    console.log(`\nv${rel.latest}`);
    check('tag is a version', /^\d+\.\d+\.\d+$/.test(rel.latest), rel.latest);
    check('an installer is attached', /setup.*\.exe$/i.test(rel.assetName), rel.assetName || 'none');
    check('a checksum is attached beside it', !!rel.checksumUrl, rel.checksumUrl ? `${rel.assetName}.sha256` : 'none — updates to this release will be refused');
    check('release notes are written', rel.notes.trim().length > 40, `${rel.notes.trim().length} chars`);

    const expected = rel.checksumUrl ? parseSha256(await fetchText(rel.checksumUrl)) : null;
    check('checksum file holds a SHA-256', !!expected, expected || 'unreadable');

    if (LOCAL) {
      const local = fs.existsSync(LOCAL) ? await sha256File(LOCAL) : null;
      check('the local build is what was published', !!local && local === expected, local ? path.basename(LOCAL) : `${LOCAL} not found`);
    }

    if (DOWNLOAD && expected) {
      console.log('\ndownloading the published installer…');
      let next = 25;
      const res = await updater.downloadUpdate(rel.assetUrl, rel.assetName, rel.checksumUrl, (pct) => {
        while (pct >= next && next <= 100) { process.stdout.write(`  ${next}%`); next += 25; }
      });
      process.stdout.write('\n');
      check('published installer matches its checksum', res.verified && res.sha256 === expected, `${(fs.statSync(res.path).size / 1048576).toFixed(1)} MB`);
    }
  } catch (err) {
    if (err.message !== 'stopping') { failed++; console.log(`  FAIL  ${err.message}`); }
  }

  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
