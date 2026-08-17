'use strict';

// Serves the built installer + checksum exactly as a GitHub release would and
// runs the real updater against them, including a tamper case.
//   npx electron tools/verify-release.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'PixelForge-Setup.exe');
const SUM = EXE + '.sha256';

for (const f of [EXE, SUM]) {
  if (!fs.existsSync(f)) { console.error(`Missing ${f} — run npm run build first.`); process.exit(1); }
}

const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-rel-'));
app.setPath('downloads', DOWNLOADS);
const updater = require('../src/main/updater');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const expected = fs.readFileSync(SUM, 'utf8').trim();

const server = http.createServer((req, res) => {
  if (req.url === '/PixelForge-Setup.exe') {
    res.writeHead(200, { 'Content-Length': fs.statSync(EXE).size });
    fs.createReadStream(EXE).pipe(res);
  } else if (req.url === '/PixelForge-Setup.exe.sha256') {
    res.end(expected);
  } else if (req.url === '/tampered.exe') {
    // One flipped byte at the front is enough to change the digest.
    const buf = fs.readFileSync(EXE);
    buf[1024] = buf[1024] ^ 0xff;
    res.writeHead(200, { 'Content-Length': buf.length });
    res.end(buf);
  } else { res.writeHead(404); res.end(); }
});

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log(`\nartifact  ${path.basename(EXE)}  ${(fs.statSync(EXE).size / 1048576).toFixed(1)} MB`);
  console.log(`published ${expected}\n`);

  try {
    // The genuine article
    let lastPct = 0;
    const good = await updater.downloadUpdate(
      `${base}/PixelForge-Setup.exe`, 'PixelForge-Setup.exe',
      `${base}/PixelForge-Setup.exe.sha256`, (p) => { lastPct = p; });
    check('genuine installer verifies', good.verified === true);
    check('digest matches published value', good.sha256 === expected, good.sha256);
    check('size preserved', fs.statSync(good.path).size === fs.statSync(EXE).size);
    check('progress reached 100%', lastPct === 100, String(lastPct));

    // A corrupted download must be rejected and removed
    let threw = null;
    try {
      await updater.downloadUpdate(`${base}/tampered.exe`, 'Tampered-Setup.exe',
        `${base}/PixelForge-Setup.exe.sha256`, () => {});
    } catch (e) { threw = e; }
    check('tampered installer rejected', threw !== null);
    check('tampered installer deleted', !fs.existsSync(path.join(DOWNLOADS, 'Tampered-Setup.exe')));

    // What a v1.0.x client sees in the asset list
    const assets = [{ name: 'PixelForge-Setup.exe' }, { name: 'PixelForge-Setup.exe.sha256' }];
    const legacy = assets.find(a => /\.exe$/i.test(a.name) && /setup/i.test(a.name))
                || assets.find(a => /\.exe$/i.test(a.name));
    check('v1.0.x client resolves the installer', legacy.name === 'PixelForge-Setup.exe', legacy.name);
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected —', err.message);
  }

  server.close();
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
