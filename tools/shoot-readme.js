'use strict';

// Captures the three README screenshots at the same size and framing as the
// originals: neutral sample filenames, and no filesystem paths in frame on the
// dashboard (the Output Folders card sits below the fold with a full queue).
//
//   npx electron tools/shoot-readme.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'shots', 'readme');
const WORK = path.join(os.tmpdir(), 'pixelforge-readme');
const USER_DATA = path.join(WORK, 'userdata');
const INPUT = path.join(WORK, 'samples');

fs.rmSync(WORK, { recursive: true, force: true });
for (const d of [USER_DATA, INPUT, OUT]) fs.mkdirSync(d, { recursive: true });
app.setPath('userData', USER_DATA);

const pkgVersion = require(path.join(ROOT, 'package.json')).version;
app.getVersion = () => pkgVersion;

const home = process.env.USERPROFILE || os.homedir();
const binDir = path.join(process.env.APPDATA || '', 'PixelForge', 'bin');

// Generic names so the queue reads like real photo work rather than test files.
const SAMPLES = {
  'landscape.png': path.join(ROOT, 'assets', 'icon.png'),
  'portrait.png': path.join(ROOT, 'src', 'pixelfroge logo.png'),
  'artwork.png': path.join(ROOT, 'assets', 'screenshots', 'dashboard.png'),
  'closeup.png': path.join(ROOT, 'assets', 'screenshots', 'settings.png'),
  'texture.png': path.join(ROOT, 'assets', 'screenshots', 'about.png'),
};
for (const [name, src] of Object.entries(SAMPLES)) fs.copyFileSync(src, path.join(INPUT, name));

fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({
  app: {
    setupDone: true, theme: 'dark', pipelineMode: 'both', outputMode: 'replace',
    restoreSession: false, notifyOnComplete: true, soundOnComplete: false,
    autoCheckUpdates: true, confirmOnExit: true, accentColor: '#6366f1',
    recursive: false, namingTemplate: '{name}', inputQueue: [],
    windowBounds: { width: 1280, height: 820, x: 80, y: 60, maximized: false },
  },
  upscayl: { model: 'upscayl-standard-4x', scale: '4', format: 'png', gpu: 'auto', tileSize: '0', tta: false },
  caesium: { quality: 82, format: 'same', lossless: false, keepMeta: false },
  // Real default locations, so the Paths panel reads like a normal install.
  paths: {
    upscaylBin: path.join(binDir, 'upscayl-bin.exe'),
    caesiumBin: path.join(binDir, 'caesiumclt.exe'),
    models: '',
    upscaled: path.join(home, 'Documents', 'PixelForge', 'upscaled'),
    compressed: path.join(home, 'Documents', 'PixelForge', 'compressed'),
  },
}, null, 2));

require(path.join(ROOT, 'main.js'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (code) => win().webContents.executeJavaScript(code, true);

async function shot(name, settle = 900) {
  await sleep(settle);
  const image = await win().webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  const { width, height } = image.getSize();
  console.log(`SHOT ${name}.png  ${width}x${height}  ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
}

async function waitFor(expr, label, timeout = 60000) {
  const t0 = Date.now();
  for (;;) {
    if (await js(`(()=>{try{return !!(${expr})}catch(e){return false}})()`)) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(400);
  }
}

app.whenReady().then(async () => {
  try {
    await sleep(1500);
    const w = win();
    if (w.webContents.isLoading()) await new Promise(r => w.webContents.once('did-finish-load', r));
    await waitFor(`document.getElementById('sidebar-version').textContent.indexOf('v')>=0`, 'renderer init');
    await js(`document.getElementById('setup-overlay').style.display='none'`);

    const files = JSON.stringify(Object.keys(SAMPLES).map(n => path.join(INPUT, n)));
    await js(`addPaths(${files}); null`);
    await waitFor(`scannedImages.length===${Object.keys(SAMPLES).length}`, 'scan');

    // Clear any toast and pin to the top so Output Folders stays below the fold.
    await js(`document.getElementById('toast-stack').innerHTML=''; document.getElementById('content').scrollTop=0; null`);
    await shot('dashboard');

    await js(`navigateTo('settings'); null`);
    await shot('settings');

    await js(`navigateTo('about'); null`);
    await shot('about');

    console.log('DONE');
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err.message);
    app.exit(1);
  }
});
