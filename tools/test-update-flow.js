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

    // 3 — an unreadable checksum is a refusal, and nothing is downloaded
    const refuse = async (name, checksumUrl) => {
      try { await updater.downloadUpdate(`${base}/setup.exe`, name, checksumUrl, () => {}); return null; }
      catch (e) { return e; }
    };
    const garbage = await refuse('NoSum-Setup.exe', `${base}/garbage.sha256`);
    check('garbage checksum is refused', garbage && /can't be verified/.test(garbage.message), garbage && garbage.message);
    check('nothing downloaded for it', !fs.existsSync(path.join(DOWNLOADS, 'NoSum-Setup.exe')));

    // 4 — a release without a checksum asset is refused before downloading
    const legacy = await refuse('Legacy-Setup.exe', '');
    check('missing checksum is refused', legacy && /doesn't publish a checksum/.test(legacy.message), legacy && legacy.message);
    check('nothing downloaded for it', !fs.existsSync(path.join(DOWNLOADS, 'Legacy-Setup.exe')));

    // 5 — progress is reported
    let sawProgress = false;
    await updater.downloadUpdate(`${base}/setup.exe`, 'Progress-Setup.exe', `${base}/good.sha256`, (pct) => {
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

    console.log('\nSILENT_UPDATE_ARGS');
    const args = updater.SILENT_UPDATE_ARGS;
    check('silent, as an update, relaunching', args.join(' ') === '/S --updated --force-run', args.join(' '));
    check('frozen', Object.isFrozen(args));

    console.log('\npendingUpdateOutcome');
    const outcome = updater.pendingUpdateOutcome;
    const now = Date.now();
    const there = () => true, gone = () => false;
    const rec = (o) => ({ from: '1.1.1', to: '1.2.0', installer: 'C:/x/PixelForge-Setup.exe', at: now - 5000, ...o });
    check('nothing pending → nothing to say', outcome(null, '1.2.0') === null);
    check('landed on the target → success', JSON.stringify(outcome(rec(), '1.2.0', now, there)) === JSON.stringify({ ok: true, version: '1.2.0' }));
    check('landed past the target → success', outcome(rec(), '1.3.0', now, there).ok === true);
    check('v-prefixed target still matches', outcome(rec({ to: 'v1.2.0' }), '1.2.0', now, there).ok === true);
    check('unknown target → success', outcome(rec({ to: '' }), '1.1.1', now, there).ok === true);
    const stuck = outcome(rec(), '1.1.1', now, there);
    check('still old → failure with the installer', stuck && stuck.ok === false && stuck.to === '1.2.0' && stuck.current === '1.1.1' && stuck.installer === 'C:/x/PixelForge-Setup.exe', JSON.stringify(stuck));
    check('installer since deleted → offered without it', outcome(rec(), '1.1.1', now, gone).installer === '');
    check('stale record is dropped quietly', outcome(rec({ at: now - 8 * 864e5 }), '1.1.1', now, there) === null);
    check('record without a time is dropped', outcome(rec({ at: undefined }), '1.1.1', now, there) === null);
    check('junk record is ignored', outcome('junk', '1.1.1', now, there) === null);
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected error —', err.message);
  }

  server.close();
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
