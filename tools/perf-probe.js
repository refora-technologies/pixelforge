'use strict';

// Measures how smooth the UI is where it matters: scrolling a dashboard whose
// results gallery holds large upscales, and opening the viewer fullscreen.
// Reports frame times from requestAnimationFrame in the real, visible window.
//
//   npx electron tools/perf-probe.js            (PF_PERF_COUNT=60 PF_PERF_SIZE=3840x2160 by default)

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const { makePng } = require('./lib/png');

const COUNT = Number(process.env.PF_PERF_COUNT) || 60;
const [W, H] = (process.env.PF_PERF_SIZE || '3840x2160').split('x').map(Number);

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perf-'));
app.setPath('userData', path.join(PROFILE, 'userdata'));
app.setPath('documents', path.join(PROFILE, 'documents'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
fs.mkdirSync(path.join(PROFILE, 'userdata'));
fs.writeFileSync(path.join(PROFILE, 'userdata', 'config.json'), JSON.stringify({
  app: { setupDone: true, autoCheckUpdates: false, windowBounds: { x: 60, y: 40, width: 1280, height: 860, maximized: false } },
}));

// One large "upscale" and one small "original", copied so every tile is its own file.
const big = makePng(W, H, 7);
const small = makePng(Math.round(W / 4), Math.round(H / 4), 7);
const results = [];
for (let i = 0; i < COUNT; i++) {
  const original = path.join(PROFILE, `orig-${i}.png`);
  const upscaled = path.join(PROFILE, `up-${i}.png`);
  fs.writeFileSync(original, small);
  fs.writeFileSync(upscaled, big);
  results.push({ original, upscaled, compressed: '' });
}

require('../main.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (code) => win().webContents.executeJavaScript(code, true);

// Records rAF deltas while `action` (renderer code, may return a promise) runs.
const measure = (action, ms) => js(`(async () => {
  const deltas = []; let last = performance.now(), on = true;
  const tick = (t) => { deltas.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await (async () => { ${action} })();
  await new Promise(r => setTimeout(r, ${ms}));
  on = false;
  const s = deltas.slice(1).sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { frames: s.length, p50: pct(0.5), p95: pct(0.95), max: s[s.length - 1], janky: s.filter(d => d > 34).length };
})()`);

const fmt = (r) => `${r.frames} frames · median ${r.p50.toFixed(1)} ms · p95 ${r.p95.toFixed(1)} ms · worst ${r.max.toFixed(0)} ms · ${r.janky} janky (>34 ms)`;

app.whenReady().then(async () => {
  try {
    await sleep(1500);
    win().focus();
    await js(`document.getElementById('setup-overlay').style.display='none'; null`);
    console.log(`gallery: ${COUNT} results at ${W}×${H}`);

    console.log('idle dashboard       ', fmt(await measure('', 1500)));

    await js(`renderGallery(${JSON.stringify(results)}); null`);
    await sleep(2500);

    // Scroll down and back up through the gallery, one step per frame.
    const scroll = `
      const c = document.getElementById('content');
      const max = c.scrollHeight - c.clientHeight;
      for (const [from, to] of [[0, max], [max, 0]]) {
        const t0 = performance.now();
        await new Promise(done => {
          const step = (t) => { const k = Math.min(1, (t - t0) / 1800); c.scrollTop = from + (to - from) * k; k < 1 ? requestAnimationFrame(step) : done(); };
          requestAnimationFrame(step);
        });
      }`;
    console.log('scroll (first pass)  ', fmt(await measure(scroll, 100)));
    console.log('scroll (second pass) ', fmt(await measure(scroll, 100)));

    await js(`openCompare(${JSON.stringify(results[0].original)}, ${JSON.stringify(results[0].upscaled)}, 'x.png', 'Upscaled'); null`);
    await sleep(1500);
    console.log('fullscreen toggle    ', fmt(await measure('toggleCompareFullscreen(true)', 700)));
    await sleep(300);
    const fit = await js(`(() => { const f = document.getElementById('cmp'), i = document.getElementById('cmp-img-base');
      return { frameW: f.clientWidth, frameH: f.clientHeight, imgW: parseFloat(i.style.width), imgH: parseFloat(i.style.height) }; })()`);
    const fills = Math.abs(fit.imgW - fit.frameW) < 2 || Math.abs(fit.imgH - fit.frameH) < 2;
    console.log(`fullscreen fit        frame ${fit.frameW}×${fit.frameH}, image ${Math.round(fit.imgW)}×${Math.round(fit.imgH)} → ${fills ? 'fills the frame' : 'DOES NOT fill the frame'}`);
    console.log('exit fullscreen      ', fmt(await measure('toggleCompareFullscreen(false)', 700)));
    await js(`closeCompare(); null`);
    await sleep(500);

    console.log('open Settings        ', fmt(await measure(`navigateTo('settings')`, 900)));
    console.log('scroll Settings      ', fmt(await measure(scroll, 100)));
    console.log('back to Dashboard    ', fmt(await measure(`navigateTo('dashboard')`, 900)));

    const mem = await js(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0`);
    const proc = (await win().webContents.getOSProcessId && app.getAppMetrics().find(m => m.pid === win().webContents.getOSProcessId())) || null;
    console.log(`renderer memory       ${proc ? Math.round(proc.memory.workingSetSize / 1024) + ' MB working set' : '?'} (JS heap ${mem} MB)`);
  } catch (err) {
    console.log('error:', err.message);
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  app.exit(0);
});
