'use strict';

// Drives the real compare viewer with real mouse and keyboard input: fit and
// 1:1 zoom, zoom limits, pan clamping, divider dragging, and prev/next.
//
//   npx electron tools/test-compare-ui.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const { makePng } = require('./lib/png');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-compare-ui-'));
app.setPath('userData', PROFILE);
app.setPath('documents', path.join(PROFILE, 'documents'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
fs.writeFileSync(path.join(PROFILE, 'config.json'), JSON.stringify({
  app: { setupDone: true, autoCheckUpdates: false, windowBounds: { width: 1280, height: 850, x: 60, y: 40, maximized: false } },
}));

// A 4x "upscale" pair and a second pair for next/previous.
const IMG = path.join(PROFILE, 'img');
fs.mkdirSync(IMG);
const file = (name, w, h, seed) => { const p = path.join(IMG, name); fs.writeFileSync(p, makePng(w, h, seed)); return p; };
const pairs = [
  { original: file('a.png', 400, 300, 1), upscaled: file('a-4x.png', 1600, 1200, 1) },
  { original: file('b.png', 400, 300, 5), upscaled: file('b-4x.png', 1600, 1200, 5) },
];

require('../main.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (code) => win().webContents.executeJavaScript(code, true);
const send = (ev) => win().webContents.sendInputEvent(ev);
const key = (keyCode, modifiers = []) => send({ type: 'keyDown', keyCode, modifiers });

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
};
async function waitFor(expr, timeout = 15000) {
  const t0 = Date.now();
  while (!(await js(`(()=>{try{return !!(${expr})}catch(e){return false}})()`))) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${expr}`);
    await sleep(80);
  }
}
// Images are positioned inside the frame's 1px border, so geometry is checked
// against the inner (client) box; fx/fy are that box's on-screen origin.
const view = () => js(`(()=>{
  const el=document.getElementById('cmp'), r=el.getBoundingClientRect();
  const f={ width:el.clientWidth, height:el.clientHeight, left:r.left+el.clientLeft, top:r.top+el.clientTop };
  const b=document.getElementById('cmp-img-base'), o=document.getElementById('cmp-img-overlay');
  return { fw:f.width, fh:f.height, fx:f.left, fy:f.top, w:parseFloat(b.style.width), h:parseFloat(b.style.height),
    ow:parseFloat(o.style.width), bt:b.style.transform, ot:o.style.transform, tx:cmpView.tx, ty:cmpView.ty,
    label:document.getElementById('cmp-zoom-label').textContent, counter:document.getElementById('cmp-counter').textContent,
    pos:cmpPos, src:b.src };
})()`);
const drag = async (x0, y0, x1, y1) => {
  send({ type: 'mouseMove', x: x0, y: y0 });
  send({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    send({ type: 'mouseMove', x: Math.round(x0 + (x1 - x0) * i / 6), y: Math.round(y0 + (y1 - y0) * i / 6), button: 'left' });
    await sleep(25);
  }
  send({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
  await sleep(120);
};

app.whenReady().then(async () => {
  try {
    await sleep(1200);
    await waitFor(`document.getElementById('sidebar-version').textContent.indexOf('v')>=0`);
    await js(`document.getElementById('setup-overlay').style.display='none'; null`);
    await js(`renderGallery(${JSON.stringify(pairs.map(p => ({ original: p.original, upscaled: p.upscaled, compressed: '' })))}); openCompareAt(0); null`);
    await waitFor(`document.getElementById('cmp-img-base').naturalWidth === 1600 && cmpView.natW === 1600`);
    await sleep(200);

    console.log('\nfit');
    let v = await view();
    check('opens on the first result', v.counter === '1 of 2', v.counter);
    check('whole image fits the frame', v.w <= v.fw + 0.5 && v.h <= v.fh + 0.5 && (Math.abs(v.w - v.fw) < 1 || Math.abs(v.h - v.fh) < 1), `${v.w}x${v.h} in ${v.fw}x${v.fh}`);
    check('and is centred', Math.abs(v.tx * 2 + v.w - v.fw) < 1.5 && Math.abs(v.ty * 2 + v.h - v.fh) < 1.5, `tx=${v.tx} ty=${v.ty}`);
    check('zoom reads Fit', v.label === 'Fit', v.label);
    check('original is stretched over the result exactly', v.ow === v.w && v.bt === v.ot, `${v.ow} vs ${v.w}`);

    console.log('\nzoom');
    key('1'); await sleep(150);
    v = await view();
    check('1 shows actual pixels', Math.abs(v.w - 1600) < 0.5 && v.label === '100%', `${v.w}px, ${v.label}`);
    check('layers stay aligned when zoomed', v.bt === v.ot && v.ow === v.w);
    await js(`zoomCompareBy(1000); null`); await sleep(100);
    v = await view();
    check('zoom stops at 800%', v.label === '800%', v.label);
    key('0'); await sleep(150);
    await js(`zoomCompareBy(0.001); null`); await sleep(100);
    v = await view();
    check('zoom out stops at fit', v.label === 'Fit' && (await js(`document.getElementById('cmp-zoom-out').disabled`)), v.label);

    console.log('\npan');
    key('1'); await sleep(150);
    await js(`cmpView.tx = 5000; cmpView.ty = 5000; layoutCompare(); null`);
    v = await view();
    check('cannot pan past the left/top edge', v.tx <= 0 && v.ty <= 0, `tx=${v.tx} ty=${v.ty}`);
    await js(`cmpView.tx = -99999; cmpView.ty = -99999; layoutCompare(); null`);
    v = await view();
    check('cannot pan past the right/bottom edge', Math.abs(v.tx - (v.fw - v.w)) < 0.5 && Math.abs(v.ty - (v.fh - v.h)) < 0.5, `tx=${v.tx}`);
    await js(`setCmpPos(97); null`);
    const before = await view();
    const cx = Math.round(before.fx + before.fw * 0.4), cy = Math.round(before.fy + before.fh / 2);
    await drag(cx, cy, cx + 60, cy + 40);
    v = await view();
    check('dragging the image pans it', Math.abs((v.tx - before.tx) - 60) < 2 && Math.abs((v.ty - before.ty) - 40) < 2, `dx=${v.tx - before.tx} dy=${v.ty - before.ty}`);
    check('panning leaves the divider alone', Math.abs(v.pos - 97) < 0.01, v.pos);

    console.log('\ndivider');
    key('0'); await sleep(150);
    await js(`setCmpPos(25); null`);
    v = await view();
    const dy = Math.round(v.fy + v.fh / 2);
    await drag(Math.round(v.fx + v.fw * 0.25), dy, Math.round(v.fx + v.fw * 0.75), dy);
    v = await view();
    check('dragging the divider moves it', Math.abs(v.pos - 75) < 1.5, v.pos);
    key('Right', ['shift']); await sleep(100);
    check('Shift+→ nudges the divider', Math.abs((await view()).pos - 80) < 1.6);
    key('1'); await sleep(150);
    v = await view();
    await drag(Math.round(v.fx + v.fw * (v.pos / 100)), dy, Math.round(v.fx + v.fw * 0.3), dy);
    check('divider can still be grabbed while zoomed', Math.abs((await view()).pos - 30) < 2, (await view()).pos);

    console.log('\nnext / previous');
    check('previous is unavailable on the first result', await js(`document.getElementById('cmp-prev').disabled`));
    key('Right'); await sleep(100);
    await waitFor(`cmpView.natW === 1600 && document.getElementById('cmp-img-base').src.endsWith('b-4x.png')`);
    await sleep(150);
    v = await view();
    check('→ shows the next result', v.counter === '2 of 2' && v.src.endsWith('b-4x.png'), v.counter);
    check('the next result opens at fit', v.label === 'Fit', v.label);
    check('the divider stays where it was left', Math.abs(v.pos - 30) < 2, v.pos);
    check('next is unavailable on the last result', await js(`document.getElementById('cmp-next').disabled`));
    key('Left'); await sleep(100);
    await waitFor(`document.getElementById('cmp-img-base').src.endsWith('a-4x.png')`);
    check('← goes back', (await view()).counter === '1 of 2');

    console.log('\nclosing');
    key('F'); await sleep(250);
    check('F enters fullscreen', await js(`document.getElementById('compare-card').classList.contains('is-fullscreen')`));
    key('Escape'); await sleep(200);
    check('Esc leaves fullscreen first', await js(`!document.getElementById('compare-card').classList.contains('is-fullscreen') && !document.getElementById('compare-modal').classList.contains('hidden')`));
    key('Escape'); await sleep(200);
    check('then closes the viewer', await js(`document.getElementById('compare-modal').classList.contains('hidden')`));
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected —', err.message);
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
