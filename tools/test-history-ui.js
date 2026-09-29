'use strict';

// The dashboard's Recent Runs card: what it shows, that names stay text, that
// a removed folder can't be opened, clearing, and that a real run is added.
//
//   npx electron tools/test-history-ui.js
//
// shell.openPath is stubbed, so no Explorer windows open.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, shell } = require('electron');
const { makePng } = require('./lib/png');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-history-'));
const OUT = path.join(PROFILE, 'out');
const KEPT = path.join(OUT, 'compressed', 'kept');
const INPUT = path.join(PROFILE, 'Beach trip');
fs.mkdirSync(KEPT, { recursive: true });
fs.mkdirSync(INPUT);
for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(INPUT, `b${i}.png`), makePng(64, 48, i + 1));

const CAESIUM = path.join(process.env.APPDATA || '', 'PixelForge', 'bin', 'caesiumclt.exe');
const now = Date.now();
const seeded = [
  { at: now - 5 * 60000, mode: 'both', inputs: ['Holiday', 'Wedding'], inputCount: 4, images: 120, failed: 2, savedPct: 64, durationMs: 192000, upscaledDir: path.join(OUT, 'upscaled'), compressedDir: KEPT },
  { at: now - 24 * 3600000, mode: 'upscale', inputs: ['<img src=x onerror="window.__pwned=1">'], inputCount: 1, images: 1, failed: 0, savedPct: null, durationMs: 4000, upscaledDir: path.join(OUT, 'gone'), compressedDir: '' },
  ...Array.from({ length: 6 }, (_, i) => ({ at: now - (40 + i) * 864e5, mode: 'compress', inputs: [`Old ${i}`], inputCount: 1, images: 10, failed: 0, savedPct: 20, durationMs: 1000, upscaledDir: '', compressedDir: KEPT })),
];

app.setPath('userData', path.join(PROFILE, 'userdata'));
app.setPath('documents', path.join(PROFILE, 'documents'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
fs.mkdirSync(path.join(PROFILE, 'userdata'));
fs.writeFileSync(path.join(PROFILE, 'userdata', 'config.json'), JSON.stringify({
  app: { setupDone: true, autoCheckUpdates: false, notifyOnComplete: false, runHistory: seeded },
  paths: { upscaled: path.join(OUT, 'upscaled'), compressed: path.join(OUT, 'compressed'), caesiumBin: CAESIUM },
}));

const opened = [];
shell.openPath = async (p) => { opened.push(p); return ''; };

require('../main.js');
const store = require('../src/main/store');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (code) => win().webContents.executeJavaScript(code, true);

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
const rows = () => js(`[...document.querySelectorAll('#recent-list .recent-item')].map(li => ({
  title: li.querySelector('.recent-title').textContent,
  meta: li.querySelector('.recent-meta').textContent,
  when: li.querySelector('.recent-when').textContent,
  disabled: li.querySelector('.recent-open').disabled,
}))`);

app.whenReady().then(async () => {
  try {
    await sleep(1200);
    await waitFor(`document.getElementById('sidebar-version').textContent.indexOf('v')>=0`);
    await js(`document.getElementById('setup-overlay').style.display='none'; null`);
    await waitFor(`document.querySelectorAll('#recent-list .recent-item').length > 0`, 5000);

    console.log('\nshowing past runs');
    let list = await rows();
    check('card is shown', !(await js(`document.getElementById('recent-card').classList.contains('hidden')`)));
    check('five most recent only', list.length === 5, list.length);
    check('inputs summarised', list[0].title === 'Holiday, Wedding +2 more', list[0].title);
    check('what the run did', /^120 images · Upscale \+ Compress · saved 64% · 3:12 · 2 failed$/.test(list[0].meta), list[0].meta);
    check('when, in plain words', list[0].when === '5 min ago' && /^Yesterday, /.test(list[1].when), `${list[0].when} / ${list[1].when}`);
    check('older runs by date', /\d/.test(list[2].when) && !/ago|Yesterday|Today/.test(list[2].when), list[2].when);
    check('a name is shown as text, never markup', list[1].title.startsWith('<img') &&
      !(await js(`!!document.querySelector('#recent-list img') || !!window.__pwned`)));
    check('singular image', list[1].meta.startsWith('1 image · '), list[1].meta);
    check('an existing folder can be opened', list[0].disabled === false);
    check('a removed folder can\'t', list[1].disabled === true);

    await js(`document.querySelector('#recent-list .recent-open').click(); null`);
    await sleep(300);
    check('Open goes to the final output', opened.length === 1 && opened[0] === KEPT, JSON.stringify(opened));

    console.log('\nclearing');
    await js(`document.getElementById('btn-clear-history').click(); null`);
    await waitFor(`document.getElementById('recent-card').classList.contains('hidden')`, 3000);
    check('card hides', true);
    check('history is emptied', (store.get('app.runHistory', null) || []).length === 0);

    console.log('\nafter a run');
    if (!fs.existsSync(CAESIUM)) {
      console.log('  SKIP  compressor not installed');
    } else {
      await js(`setMode('compress'); addPaths([${JSON.stringify(INPUT)}]); null`);
      await waitFor(`scannedImages.length===3`);
      await js(`document.getElementById('btn-start').click(); null`);
      await waitFor(`!pipelineRunning && document.querySelectorAll('#recent-list .recent-item').length === 1`, 60000);
      list = await rows();
      check('the run is added', list[0].title === 'Beach trip' && /^3 images · Compress only/.test(list[0].meta), JSON.stringify(list[0]));
      check('its folder can be opened', list[0].disabled === false);
      const saved = store.get('app.runHistory', [])[0] || {};
      check('stored with its output folder', saved.compressedDir && fs.existsSync(saved.compressedDir), saved.compressedDir);
    }
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected error —', err.message);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  app.exit(failed ? 1 : 0);
});
