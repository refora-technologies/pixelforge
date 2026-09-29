'use strict';

// Renders the setup wizard's artwork — the welcome/finish sidebar and the
// inner-page header — from HTML, and writes the 24-bit BMPs NSIS expects.
//
//   npx electron tools/make-installer-art.js
//
// Output: build/installer-sidebar.bmp (164×314), build/installer-header.bmp (150×57),
// plus PNG previews of both in the temp folder.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, nativeImage } = require('electron');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const ROOT = path.join(__dirname, '..');
// Downscaled first: the 1024px original is far more than 68px needs.
const ICON = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png')).resize({ width: 192, quality: 'best' }).toDataURL();
const FONT = `'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif`;

const SIDEBAR = `
<body style="margin:0;width:164px;height:314px;overflow:hidden;font-family:${FONT};
  background:radial-gradient(120% 60% at 50% 0%, rgba(99,102,241,0.55), transparent 70%),
             linear-gradient(180deg,#141433 0%,#0b0b18 100%);color:#fff;">
  <div style="position:absolute;inset:0;background:radial-gradient(80% 40% at 50% 100%, rgba(168,85,247,0.28), transparent 70%)"></div>
  <div style="position:relative;display:flex;flex-direction:column;align-items:center;padding-top:62px;text-align:center">
    <img src="${ICON}" style="width:68px;height:68px;filter:drop-shadow(0 8px 18px rgba(99,102,241,0.55))">
    <div style="margin-top:18px;font-size:21px;font-weight:700;letter-spacing:-0.2px">PixelForge</div>
    <div style="margin-top:6px;font-size:10.5px;line-height:1.45;color:#b9bbe0;padding:0 14px">AI upscaling and compression, on your PC</div>
  </div>
  <div style="position:absolute;left:0;right:0;bottom:16px;text-align:center;font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:#8d8fb8">Refora Technologies</div>
</body>`;

const HEADER = `
<body style="margin:0;width:150px;height:57px;overflow:hidden;background:#fff;font-family:${FONT};
  display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-right:12px;box-sizing:border-box">
  <img src="${ICON}" style="width:30px;height:30px">
  <div style="font-size:15px;font-weight:700;color:#17172b;letter-spacing:-0.1px">PixelForge</div>
</body>`;

// 24-bit, bottom-up BMP from BGRA pixels, rows padded to 4 bytes.
function toBmp(bgra, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(width, 18); b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(rowSize * height, 34);
  b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      b[dst + x * 3] = bgra[s]; b[dst + x * 3 + 1] = bgra[s + 1]; b[dst + x * 3 + 2] = bgra[s + 2];
    }
  }
  return b;
}

async function render(html, width, height, out) {
  const win = new BrowserWindow({ width, height, useContentSize: true, show: false, frame: false, webPreferences: { offscreen: true } });
  const page = path.join(os.tmpdir(), `pf-art-${process.pid}.html`);
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">${html}`);
  await win.loadFile(page);
  fs.rmSync(page, { force: true });
  await new Promise(r => setTimeout(r, 400));
  const img = (await win.webContents.capturePage({ x: 0, y: 0, width, height })).resize({ width, height, quality: 'best' });
  const size = img.getSize();
  if (size.width !== width || size.height !== height) throw new Error(`captured ${size.width}×${size.height}, wanted ${width}×${height}`);
  fs.writeFileSync(out, toBmp(img.toBitmap(), width, height));
  fs.writeFileSync(path.join(os.tmpdir(), path.basename(out, '.bmp') + '.preview.png'), img.toPNG()); // to look at
  win.destroy();
  console.log(`  wrote ${path.relative(ROOT, out)} (${width}×${height})`);
}

// Each image gets its own window; closing one mustn't end the run.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    await render(SIDEBAR, 164, 314, path.join(ROOT, 'build', 'installer-sidebar.bmp'));
    await render(HEADER, 150, 57, path.join(ROOT, 'build', 'installer-header.bmp'));
    app.exit(0);
  } catch (err) {
    console.error(err.message);
    app.exit(1);
  }
});
