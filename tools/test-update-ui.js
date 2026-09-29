'use strict';

// Drives one-click updating through the real window against a local release
// server: the banner, download and verify, refusals, "Restart to update", and
// the report on the launch after an update that didn't take.
//
//   npx electron tools/test-update-ui.js
//
// The "installer" is a copy of where.exe — harmless when started with the
// silent-update arguments. app.quit is stubbed so the run can be inspected.
// Versions are far ahead because a bare script reports Electron's version.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-update-ui-'));
const DOWNLOADS = path.join(PROFILE, 'downloads');
fs.mkdirSync(DOWNLOADS);
app.setPath('userData', PROFILE);
app.setPath('downloads', DOWNLOADS);
app.setPath('documents', path.join(PROFILE, 'documents'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Left behind by an earlier update that didn't take.
const OLD_INSTALLER = path.join(DOWNLOADS, 'PixelForge-Setup-old.exe');
fs.writeFileSync(OLD_INSTALLER, 'old installer');
fs.writeFileSync(path.join(PROFILE, 'config.json'), JSON.stringify({
  app: {
    setupDone: true, autoCheckUpdates: false,
    pendingUpdate: { from: '1.0.0', to: '999.0.0', installer: OLD_INSTALLER, at: Date.now() - 60000 },
  },
}));

let quits = 0;
app.quit = () => { quits++; };

require('../main.js');
const store = require('../src/main/store');

const PAYLOAD = fs.readFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'));
const DIGEST = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const server = http.createServer((req, res) => {
  if (req.url === '/setup.exe') { res.writeHead(200, { 'Content-Length': PAYLOAD.length }); res.end(PAYLOAD); }
  else if (req.url === '/setup.exe.sha256') res.end(`${DIGEST}  PixelForge-Setup-999.0.0.exe\n`);
  else { res.writeHead(404); res.end(); }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (code) => win().webContents.executeJavaScript(code, true);
const hidden = (id) => js(`document.getElementById('${id}').classList.contains('hidden')`);
const text = (id) => js(`document.getElementById('${id}').textContent`);
const click = (id) => js(`document.getElementById('${id}').click(); null`);

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
};

async function waitFor(expr, timeout = 15000) {
  const t0 = Date.now();
  while (!(await js(`(()=>{try{return !!(${expr})}catch(e){return false}})()`))) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${expr}`);
    await sleep(100);
  }
}

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dest = path.join(DOWNLOADS, 'PixelForge-Setup-999.0.0.exe');
  try {
    await sleep(1200);
    await waitFor(`document.getElementById('sidebar-version').textContent.indexOf('v')>=0`);
    await js(`document.getElementById('setup-overlay').style.display='none'; null`);
    const current = app.getVersion();

    console.log('\nafter an update that did not take');
    await waitFor(`!document.getElementById('update-banner').classList.contains('hidden')`, 5000).catch(() => {});
    check('banner is shown', !(await hidden('update-banner')));
    const title = await text('update-banner-title');
    check('it names the version that failed', /didn.t finish/.test(title) && title.includes('999.0.0'), title);
    check('it says what is still installed', (await text('update-banner-sub')).includes(`v${current}`));
    check('it offers the leftover installer', (await text('update-banner-btn-label')) === 'Open installer');
    check('the record is cleared', store.get('app.pendingUpdate', null) === null);
    await click('update-banner-dismiss');

    console.log('\nbanner → download and verify');
    await js(`onUpdateAvailable(${JSON.stringify({ ok: true, hasUpdate: true, current, latest: '999.0.0',
      assetUrl: `${base}/setup.exe`, assetName: 'PixelForge-Setup-999.0.0.exe', checksumUrl: `${base}/setup.exe.sha256` })}); null`);
    check('new-version banner', (await text('update-banner-title')).includes('999.0.0') && (await text('update-banner-btn-label')) === 'Update');
    await click('update-banner-btn');
    check('goes to Settings', await js(`document.getElementById('page-settings').classList.contains('active')`));
    await waitFor(`!document.getElementById('btn-install-update').classList.contains('hidden')`);
    check('download starts by itself and verifies', /downloaded and verified/.test(await text('upd-status-text')), await text('upd-status-text'));
    check('installer is on disk', fs.existsSync(dest) && fs.readFileSync(dest).equals(PAYLOAD));
    check('download button gives way', await hidden('btn-download-update'));
    check('wizard fallback offered', !(await hidden('btn-run-installer')));

    console.log('\nrefusals');
    await js(`setRunningUI(true); null`);
    check('install waits for a run', await js(`document.getElementById('btn-install-update').disabled`));
    await js(`setRunningUI(false); null`);
    check('and is back afterwards', !(await js(`document.getElementById('btn-install-update').disabled`)));

    const unverified = await js(`window.pixelforge.installUpdate({ installerPath: ${JSON.stringify(path.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe'))}, version: '999.0.0' })`);
    check('an installer it did not verify is refused', !unverified.ok && /verified/.test(unverified.error), JSON.stringify(unverified));

    fs.appendFileSync(dest, 'x');
    await click('btn-install-update');
    await waitFor(`/changed after/.test(document.getElementById('upd-status-text').textContent)`);
    check('a file changed after verifying is refused', true);
    check('and deleted', !fs.existsSync(dest));
    check('overlay stays down', await hidden('update-overlay'));
    check('nothing recorded', store.get('app.pendingUpdate', null) === null);
    check('app kept running', quits === 0);

    console.log('\nrestart to update');
    await js(`presentUpdate(lastUpdate); null`);
    await click('btn-download-update');
    await waitFor(`!document.getElementById('btn-install-update').classList.contains('hidden')`);
    await click('btn-install-update');
    await waitFor(`!document.getElementById('update-overlay').classList.contains('hidden')`, 3000);
    check('overlay names the version', (await text('update-overlay-version')) === 'v999.0.0');
    await sleep(1200);
    const pending = store.get('app.pendingUpdate', null);
    check('update recorded for the next launch', pending && pending.to === '999.0.0' && pending.from === current && pending.installer === dest, JSON.stringify(pending));
    check('app closes itself', quits === 1, quits);
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected error —', err.message);
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  app.exit(failed ? 1 : 0);
});
