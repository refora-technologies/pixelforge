'use strict';

// Drives the real updater.downloadUpdate() against a local release server.
//   npx electron tools/test-update-flow.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dl-'));
app.setPath('downloads', DOWNLOADS);

const updater = require('../src/main/updater');

const PAYLOAD = Buffer.from('installer bytes '.repeat(2000));
const DIGEST = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const server = http.createServer((req, res) => {
  if (req.url === '/setup.exe') {
    res.writeHead(200, { 'Content-Length': PAYLOAD.length });
    res.end(PAYLOAD);
  } else if (req.url === '/good.sha256') {
    res.end(DIGEST);
  } else if (req.url === '/wrong.sha256') {
    res.end('a'.repeat(64));
  } else if (req.url === '/garbage.sha256') {
    res.end('<html>Not Found</html>');
  } else {
    res.writeHead(404); res.end();
  }
});

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\ndownloadUpdate');

    // 1 — verified download
    const ok = await updater.downloadUpdate(`${base}/setup.exe`, 'PixelForge-Setup.exe', `${base}/good.sha256`, () => {});
    check('reports verified', ok.verified === true);
    check('returns the digest', ok.sha256 === DIGEST);
    check('installer kept on disk', fs.existsSync(ok.path));
    check('bytes intact', fs.readFileSync(ok.path).equals(PAYLOAD));

    // 2 — checksum mismatch must refuse and clean up
    let threw = null;
    let badPath = path.join(DOWNLOADS, 'Bad-Setup.exe');
    try {
      await updater.downloadUpdate(`${base}/setup.exe`, 'Bad-Setup.exe', `${base}/wrong.sha256`, () => {});
    } catch (err) { threw = err; }
    check('mismatch throws', threw !== null);
    check('error explains the discard', threw && /checksum mismatch/i.test(threw.message), threw && threw.message);
    check('mismatched file deleted', !fs.existsSync(badPath));

    // 3 — unusable checksum file degrades to unverified rather than failing
    const noSum = await updater.downloadUpdate(`${base}/setup.exe`, 'NoSum-Setup.exe', `${base}/garbage.sha256`, () => {});
    check('garbage checksum -> unverified', noSum.verified === false);
    check('garbage checksum keeps file', fs.existsSync(noSum.path));

    // 4 — release without a checksum asset
    const legacy = await updater.downloadUpdate(`${base}/setup.exe`, 'Legacy-Setup.exe', '', () => {});
    check('no checksum url -> unverified', legacy.verified === false);
    check('no checksum url keeps file', fs.existsSync(legacy.path));

    // 5 — progress is reported
    let sawProgress = false;
    await updater.downloadUpdate(`${base}/setup.exe`, 'Progress-Setup.exe', '', (pct) => {
      if (typeof pct === 'number' && pct >= 0 && pct <= 100) sawProgress = true;
    });
    check('progress callback fires', sawProgress);

    // 6 — missing url rejected up front
    let noUrl = null;
    try { await updater.downloadUpdate('', 'x.exe', '', () => {}); } catch (e) { noUrl = e; }
    check('empty url rejected', noUrl !== null);

    console.log('\nisNewer');
    check('1.1.0 > 1.0.2', updater.isNewer('1.1.0', '1.0.2'));
    check('v-prefix tolerated', updater.isNewer('v1.1.0', '1.0.9'));
    check('equal is not newer', !updater.isNewer('1.1.0', '1.1.0'));
    check('older is not newer', !updater.isNewer('1.0.2', '1.1.0'));
    check('1.1.0 > 1.1', updater.isNewer('1.1.1', '1.1'));
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected error —', err.message);
  }

  server.close();
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
