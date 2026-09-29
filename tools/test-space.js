'use strict';

// The free-space check before a run: per-drive estimates from real files, the
// "may not fit" prompt, and that cancelling it leaves the run unstarted.
//
//   npx electron tools/test-space.js
//
// The prompt is stubbed so the suite can answer it.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, dialog } = require('electron');
const { makePng } = require('./lib/png');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-space-'));
const INPUT = path.join(PROFILE, 'photos');
const HUGE = path.join(PROFILE, 'huge');
const OUT = path.join(PROFILE, 'out');
fs.mkdirSync(INPUT); fs.mkdirSync(HUGE);
app.setPath('userData', path.join(PROFILE, 'userdata'));
app.setPath('documents', path.join(PROFILE, 'documents'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
fs.mkdirSync(path.join(PROFILE, 'userdata'));
fs.writeFileSync(path.join(PROFILE, 'userdata', 'config.json'), JSON.stringify({
  app: { setupDone: true, autoCheckUpdates: false },
  paths: { upscaled: path.join(OUT, 'upscaled'), compressed: path.join(OUT, 'compressed') },
}));

for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(INPUT, `p${i}.png`), makePng(120, 80, i + 1));
// A header claiming 60000×60000: a 4× PNG upscale of it would be ~100 TB.
const huge = makePng(4, 4);
huge.writeUInt32BE(60000, 16); huge.writeUInt32BE(60000, 20);
fs.writeFileSync(path.join(HUGE, 'giant.png'), huge);

const prompts = [];
let answer = 0;
dialog.showMessageBox = async (_win, opts) => { prompts.push(opts); return { response: answer }; };

require('../main.js');
const space = require('../src/main/space');
const { readImageSize } = require('../src/main/imagesize');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (code) => win().webContents.executeJavaScript(code, true);
const MB = 1024 * 1024;

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
  try {
    await sleep(1200);
    await waitFor(`document.getElementById('sidebar-version').textContent.indexOf('v')>=0`);
    await js(`document.getElementById('setup-overlay').style.display='none'; null`);
    const settings = { pipelineMode: 'both', upscaylScale: '4', upscaylFormat: 'png', caesiumQuality: 82, caesiumFormat: 'same' };

    console.log('\nreal encoder output');
    const encoded = await js(`(async () => {
      const c = new OffscreenCanvas(321, 123); const g = c.getContext('2d');
      g.fillStyle = '#c33'; g.fillRect(0, 0, 200, 90); g.fillStyle = '#39f'; g.fillRect(100, 40, 221, 83);
      const out = {};
      for (const type of ['image/jpeg', 'image/webp', 'image/png']) {
        out[type] = Array.from(new Uint8Array(await (await c.convertToBlob({ type, quality: 0.85 })).arrayBuffer()));
      }
      return out;
    })()`);
    for (const [type, bytes] of Object.entries(encoded)) {
      const file = path.join(PROFILE, `real.${type.split('/')[1]}`);
      fs.writeFileSync(file, Buffer.from(bytes));
      const size = await readImageSize(file);
      check(`${type} from Chromium`, size && size.width === 321 && size.height === 123, JSON.stringify(size));
    }

    console.log('\nplanSpace');
    const plan = await space.planSpace([INPUT], settings);
    check('one drive for both outputs', plan.drives.length === 1 && plan.drives[0].folders.length === 2, JSON.stringify(plan.drives));
    const expectUp = 6 * 120 * 80 * 16 * 1.8;
    check('estimate follows the images', plan.needed > expectUp && plan.needed < expectUp * 2, `${(plan.needed / MB).toFixed(2)} MB`);
    check('free space is read', plan.drives[0].free > 0);
    check('small run fits', plan.short.length === 0);

    const upOnly = await space.planSpace([INPUT], { ...settings, pipelineMode: 'upscale' });
    check('upscale-only plans one folder', upOnly.drives[0].folders.length === 1 && upOnly.needed < plan.needed);

    const big = await space.planSpace([HUGE], settings);
    check('an enormous run is flagged', big.short.length === 1 && big.short[0].needed > big.short[0].free);
    check('nothing to process, nothing needed', (await space.planSpace([path.join(PROFILE, 'nope')], settings)).needed === 0);

    console.log('\nstarting a run');
    const res = await js(`window.pixelforge.checkSpace({ queue: [${JSON.stringify(INPUT)}], settings: ${JSON.stringify(settings)} })`);
    check('a run that fits starts without asking', res.proceed === true && prompts.length === 0, JSON.stringify(res));

    await js(`addPaths([${JSON.stringify(HUGE)}]); null`);
    await waitFor(`scannedImages.length===1`);
    answer = 0; // Cancel
    await js(`document.getElementById('btn-start').click(); null`);
    await sleep(1500);
    check('a run that may not fit asks first', prompts.length === 1, prompts.length);
    const p = prompts[0] || {};
    check('the prompt says how much and where', /needs about [\d.]+ (TB|GB|MB) and has [\d.]+ (TB|GB|MB) free/.test(p.detail || ''), p.detail);
    check('Cancel is the default', p.defaultId === 0 && p.cancelId === 0 && p.buttons && p.buttons[0] === 'Cancel');
    check('cancelling leaves the run unstarted', !(await js('pipelineRunning')) && (await js(`document.getElementById('progress-card').classList.contains('hidden')`)));
    check('Start is usable again', !(await js(`document.getElementById('btn-start').disabled`)));

    // Double clicks while the check runs start at most one check.
    answer = 0;
    await js(`document.getElementById('btn-start').click(); document.getElementById('btn-start').click(); null`);
    await sleep(1500);
    check('one prompt per click, not per double-click', prompts.length === 2, prompts.length);
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected error —', err.message);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  app.exit(failed ? 1 : 0);
});
