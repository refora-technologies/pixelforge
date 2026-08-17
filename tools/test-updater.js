'use strict';

// Exercises the update download + checksum path against a local HTTP server.
//   node tools/test-updater.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { downloadFile, fetchText, parseSha256, sha256File, verifyChecksum } = require('../src/main/download');

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-updtest-'));
const PAYLOAD = Buffer.from('PixelForge installer payload '.repeat(500));
const DIGEST = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/PixelForge-Setup.exe') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': PAYLOAD.length });
        res.end(PAYLOAD);
      } else if (req.url === '/PixelForge-Setup.exe.sha256') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(DIGEST);
      } else if (req.url === '/bad.sha256') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('0'.repeat(64));
      } else if (req.url === '/sha256sum-style') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`${DIGEST}  PixelForge-Setup.exe\n`);
      } else if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/PixelForge-Setup.exe' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  // ── checksum parsing ──
  console.log('\nparseSha256');
  check('bare digest', parseSha256(DIGEST) === DIGEST);
  check('sha256sum layout', parseSha256(`${DIGEST}  PixelForge-Setup.exe`) === DIGEST);
  check('trailing newline', parseSha256(`${DIGEST}\n`) === DIGEST);
  check('uppercase normalised', parseSha256(DIGEST.toUpperCase()) === DIGEST);
  check('rejects short hex', parseSha256('abc123') === null);
  check('rejects empty', parseSha256('') === null);
  check('rejects html error page', parseSha256('<html>404 Not Found</html>') === null);

  // ── download + hash ──
  console.log('\ndownload + hash');
  const dest = path.join(TMP, 'PixelForge-Setup.exe');
  await downloadFile(`${base}/PixelForge-Setup.exe`, dest, () => {});
  check('file downloaded', fs.existsSync(dest));
  check('byte-for-byte identical', fs.readFileSync(dest).equals(PAYLOAD));
  check('digest matches', (await sha256File(dest)) === DIGEST);

  const viaRedirect = path.join(TMP, 'redirected.exe');
  await downloadFile(`${base}/redirect`, viaRedirect, () => {});
  check('follows redirects', (await sha256File(viaRedirect)) === DIGEST);

  // ── verification ──
  console.log('\nverification');
  check('accepts matching digest', await verifyChecksum(dest, DIGEST));
  check('rejects wrong digest', !(await verifyChecksum(dest, '0'.repeat(64))));

  const served = parseSha256(await fetchText(`${base}/PixelForge-Setup.exe.sha256`));
  check('fetches published checksum', served === DIGEST);
  check('fetches sha256sum-style file', parseSha256(await fetchText(`${base}/sha256sum-style`)) === DIGEST);
  check('detects tampering', parseSha256(await fetchText(`${base}/bad.sha256`)) !== DIGEST);

  // Tampered installer must fail against the genuine checksum.
  const tampered = path.join(TMP, 'tampered.exe');
  fs.writeFileSync(tampered, Buffer.concat([PAYLOAD, Buffer.from('x')]));
  check('tampered file fails verification', !(await verifyChecksum(tampered, DIGEST)));

  // ── backwards compatibility with the v1.0.x updater ──
  // Older builds pick an asset with this exact logic; the new .sha256 asset
  // must not steal the match.
  console.log('\nv1.0.x asset matching');
  const assets = [
    { name: 'PixelForge-Setup.exe' },
    { name: 'PixelForge-Setup.exe.sha256' },
    { name: 'Source code (zip)' },
  ];
  const legacyPick = assets.find(a => /\.exe$/i.test(a.name) && /setup/i.test(a.name))
                  || assets.find(a => /\.exe$/i.test(a.name));
  check('old updater picks the installer', legacyPick && legacyPick.name === 'PixelForge-Setup.exe',
    legacyPick && legacyPick.name);
  check('.sha256 is not mistaken for the installer', !/\.exe$/i.test('PixelForge-Setup.exe.sha256'));

  // New updater pairs installer with its checksum.
  const asset = legacyPick;
  const checksum = assets.find(a => a.name.toLowerCase() === `${asset.name.toLowerCase()}.sha256`);
  check('new updater finds the checksum asset', checksum && checksum.name === 'PixelForge-Setup.exe.sha256');

  const noChecksum = [{ name: 'PixelForge-Setup.exe' }];
  const missing = noChecksum.find(a => a.name.toLowerCase() === 'pixelforge-setup.exe.sha256');
  check('absent checksum degrades to undefined', missing === undefined);

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('ERROR', err); process.exit(1); });
