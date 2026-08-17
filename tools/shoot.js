'use strict';

// Boots the real app against a throwaway profile, drives it through a full
// run, and captures PNGs with webContents.capturePage().
//
//   npx electron tools/shoot.js
//
// Nothing here touches the installed app's settings or output folders.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'shots');
const WORK = path.join(os.tmpdir(), 'pixelforge-shots');
const USER_DATA = path.join(WORK, 'userdata');
const INPUT = path.join(WORK, 'input');

// ── Isolate before main.js constructs its store ──
fs.rmSync(WORK, { recursive: true, force: true });
for (const d of [USER_DATA, INPUT, OUT]) fs.mkdirSync(d, { recursive: true });
app.setPath('userData', USER_DATA);

// Reuses the dependencies the installed app already downloaded.
const realBin = path.join(process.env.APPDATA || '', 'pixelforge', 'bin');
for (const exe of ['upscayl-bin.exe', 'caesiumclt.exe']) {
  if (!fs.existsSync(path.join(realBin, exe))) {
    console.error(`Missing ${exe} in ${realBin} — run the app once to install dependencies.`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.join(ROOT, 'src', 'models'))) {
  console.error('Missing src/models — copy the AI model files in first.');
  process.exit(1);
}
const SOURCES = [
  path.join(ROOT, 'src', 'pixelfroge logo.png'),
  path.join(ROOT, 'assets', 'icon.png'),
  path.join(ROOT, 'assets', 'screenshots', 'dashboard.png'),
  path.join(ROOT, 'assets', 'screenshots', 'settings.png'),
  path.join(ROOT, 'assets', 'screenshots', 'about.png'),
];
const NAMES = ['forge-mark.png', 'app-icon.png', 'sample-wide.png', 'sample-panel.png', 'sample-card.png'];
SOURCES.forEach((src, i) => fs.copyFileSync(src, path.join(INPUT, NAMES[i])));

fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({
  app: {
    setupDone: true, theme: 'dark', pipelineMode: 'both', outputMode: 'keep',
    restoreSession: false, notifyOnComplete: false, soundOnComplete: false,
    autoCheckUpdates: false, accentColor: '#6366f1', recursive: false,
    namingTemplate: '{name}', inputQueue: [],
    windowBounds: { width: 1280, height: 850, x: 90, y: 60, maximized: false },
  },
  upscayl: { model: 'upscayl-standard-4x', scale: '2', format: 'png', gpu: '1', tileSize: '0', tta: false },
  caesium: { quality: 82, format: 'same', lossless: false, keepMeta: false },
  paths: {
    upscaylBin: path.join(realBin, 'upscayl-bin.exe'),
    caesiumBin: path.join(realBin, 'caesiumclt.exe'),
    models: path.join(ROOT, 'src', 'models'),
    upscaled: path.join(WORK, 'out', 'upscaled'),
    compressed: path.join(WORK, 'out', 'compressed'),
  },
}, null, 2));

// A bare `electron script.js` has no app package.json, so getVersion() would
// report Electron's version. `electron .` and the packaged build read this.
const pkgVersion = require(path.join(ROOT, 'package.json')).version;
app.getVersion = () => pkgVersion;

require(path.join(ROOT, 'main.js'));

// ── Driver ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (code) => win().webContents.executeJavaScript(code, true);

let shotIndex = 0;
async function shot(name, settle = 700) {
  await sleep(settle);
  const image = await win().webContents.capturePage();
  const file = path.join(OUT, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
  const buf = image.toPNG();
  fs.writeFileSync(file, buf);
  const { width, height } = image.getSize();
  console.log(`SHOT ${path.basename(file)}  ${width}x${height}  ${(buf.length / 1024).toFixed(0)}KB`);
  if (buf.length < 8000) console.log('  !! suspiciously small — window may not be rendering');
}

async function waitFor(expr, label, timeout = 300000) {
  const started = Date.now();
  for (;;) {
    const ok = await js(`(()=>{try{return !!(${expr})}catch(e){return false}})()`);
    if (ok) return;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}

const imagesSettled = (sel) =>
  `Array.from(document.querySelectorAll('${sel}')).length>0 && Array.from(document.querySelectorAll('${sel}')).every(i=>i.complete && i.naturalWidth>0)`;

app.whenReady().then(async () => {
  try {
    await sleep(1500);
    const w = win();
    if (w.webContents.isLoading()) await new Promise(r => w.webContents.once('did-finish-load', r));
    await waitFor(`document.getElementById('sidebar-version').textContent.indexOf('v')>=0`, 'renderer init');
    await js(`document.getElementById('setup-overlay').style.display='none'`);

    // 1 — clean launch, nothing carried over from last time
    await shot('dashboard-empty');

    // 2 — queue populated
    const files = JSON.stringify(NAMES.map(n => path.join(INPUT, n)));
    await js(`addPaths(${files}); null`);
    await waitFor(`scannedImages.length===${NAMES.length}`, 'scan complete');
    await shot('dashboard-queue');

    // 3 — a single queued item still offers removal
    await js(`queue.slice(1).forEach(p=>removePath(p)); null`);
    await waitFor(`queue.length===1`, 'single item');
    await shot('queue-single-item');

    // restore the full queue for the run
    await js(`addPaths(${files}); null`);
    await waitFor(`scannedImages.length===${NAMES.length}`, 'rescan');

    // 4 — mid-run progress
    await js(`onStartPipeline(); null`);
    await waitFor(`pipelineRunning===true`, 'run started');
    await sleep(2500);
    await shot('pipeline-running', 0);

    // 5 — results. Tiles are below the fold and lazy, so force + scroll to them.
    await waitFor(`pipelineRunning===false && lastResults.length>0`, 'run finished');
    await js(`document.querySelectorAll('.gallery-tile img').forEach(i=>i.loading='eager'); document.getElementById('results-card').scrollIntoView({block:'center'}); null`);
    await waitFor(imagesSettled('.gallery-tile img'), 'thumbnails', 90000);
    await shot('results-gallery');

    const summary = await js(`JSON.stringify({n:lastResults.length, dir:lastRunDir, first:lastResults[0]})`);
    console.log('RUN', summary);

    // 6-9 — compare viewer
    await js(`(()=>{const r=lastResults[0];openCompare(r.original,r.upscaled,r.upscaled.split(/[\\\\/]/).pop());})(); null`);
    await waitFor(imagesSettled('#cmp-img-base, #cmp-img-overlay'), 'compare images');
    await js(`setCmpPos(50); null`);
    await shot('compare-split');

    await js(`setCmpPos(0); null`);
    await shot('compare-far-left', 500);

    await js(`setCmpPos(100); null`);
    await shot('compare-far-right', 500);

    await js(`setCmpPos(46); toggleCompareFullscreen(true); null`);
    await shot('compare-fullscreen');

    await js(`closeCompare(); null`);

    // 10-11 — settings, including an open dropdown
    await js(`navigateTo('settings'); null`);
    await shot('settings');
    await js(`document.querySelector('#set-upscayl-model').closest('.set-row').scrollIntoView({block:'center'}); null`);
    await sleep(400);
    await js(`document.querySelector('#set-upscayl-model').parentNode.querySelector('.sel-trigger').click(); null`);
    await shot('settings-dropdown', 500);
    await js(`closeSelectMenu(); null`);

    // 12 — about
    await js(`navigateTo('about'); null`);
    await shot('about');

    // 13 — light theme
    await js(`navigateTo('dashboard'); applyTheme('light'); null`);
    await shot('dashboard-light');

    console.log('DONE');
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err.message);
    app.exit(1);
  }
});
