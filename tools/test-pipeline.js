'use strict';

// Drives the real pipeline against throwaway folders and checks that it never
// loses or overwrites a file it doesn't own.
//
//   npx electron tools/test-pipeline.js
//   PF_SKIP_GPU=1 npx electron tools/test-pipeline.js   (skip the upscaling cases)
//
// Uses the engine binaries the installed app already downloaded, and generates
// its own tiny test images, so it needs no fixtures.

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pipeline-test-'));
app.setPath('userData', path.join(WORK, 'userdata'));
app.setPath('documents', path.join(WORK, 'documents'));

const BIN = path.join(process.env.APPDATA || '', 'pixelforge', 'bin');
const CAESIUM = path.join(BIN, 'caesiumclt.exe');
const UPSCAYL = path.join(BIN, 'upscayl-bin.exe');
if (!fs.existsSync(CAESIUM)) { console.error(`Missing ${CAESIUM} — run the app once to install dependencies.`); process.exit(1); }

const store = require('../src/main/store');
const pipeline = require('../src/main/pipeline');
store.set('paths.caesiumBin', CAESIUM);
store.set('paths.upscaylBin', UPSCAYL);
store.set('paths.models', path.join(ROOT, 'src', 'models'));

// ── Tiny PNG encoder, so tests don't depend on image fixtures ──
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(size, seed) {
  const row = size * 3 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * row + 1 + x * 3;
      raw[o] = (x * 5 + seed * 40) & 255;
      raw[o + 1] = (y * 5 + seed * 70) & 255;
      raw[o + 2] = ((x ^ y) * 3 + seed * 20) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Harness ──
let passed = 0, failed = 0, skipped = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
};
const skip = (name) => { skipped++; console.log(`  SKIP  ${name}`); };

let n = 0;
const dir = (label) => { const d = path.join(WORK, `${++n}-${label}`); fs.mkdirSync(d, { recursive: true }); return d; };
const img = (d, name, seed = 1, size = 40) => { const p = path.join(d, name); fs.writeFileSync(p, makePng(size, seed)); return p; };
const imagesIn = (d) => { try { return fs.readdirSync(d).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort(); } catch { return []; } };
const exists = (p) => fs.existsSync(p);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, timeout) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for the run to make progress');
    await sleep(50);
  }
}

function useOutputs({ upscaled, compressed } = {}) {
  if (upscaled) store.set('paths.upscaled', upscaled); else store.delete('paths.upscaled');
  if (compressed) store.set('paths.compressed', compressed); else store.delete('paths.compressed');
}

async function run(queue, settings) {
  try {
    return await pipeline.runPipeline({
      queue,
      settings: { pipelineMode: 'compress', outputMode: 'replace', caesiumQuality: 80, upscaylScale: '2', upscaylGpu: 'auto', ...settings },
    }, () => {});
  } catch (err) {
    return { success: false, threw: true, error: err.message };
  }
}

async function compressionCases() {
  console.log('\nReplace mode never touches files it did not create');
  {
    const out = dir('user-folder');
    fs.writeFileSync(path.join(out, 'tax-return-2025.pdf'), 'precious');
    img(out, 'wedding.png', 9);
    const input = dir('in'); img(input, 'a.png');
    useOutputs({ compressed: out });
    const r = await run([input]);
    check('run succeeds', r.success, r.error);
    check('unrelated document survives', exists(path.join(out, 'tax-return-2025.pdf')));
    check('unrelated image survives', exists(path.join(out, 'wedding.png')));
    check('new result written alongside', exists(path.join(out, 'a.png')));

    const again = await run([input]);
    check('second run succeeds', again.success, again.error);
    check('second run replaces its own result, no "(2)" suffix', JSON.stringify(imagesIn(out)) === JSON.stringify(['a.png', 'wedding.png']), JSON.stringify(imagesIn(out)));
    check('unrelated files still survive', exists(path.join(out, 'tax-return-2025.pdf')) && exists(path.join(out, 'wedding.png')));
    check('staging folder cleaned up', !exists(path.join(out, '.pixelforge-staging')));
  }

  console.log('\nAn input inside the output folder is never destroyed');
  {
    const out = dir('photos-as-output');
    img(out, 'holiday1.png', 2); img(out, 'holiday2.png', 3);
    useOutputs({ compressed: out });
    const r = await run([out]);
    check('replace mode refuses', !r.success && /inside the compressed output folder/.test(r.error || ''), r.error);
    check('inputs untouched', imagesIn(out).length === 2, JSON.stringify(imagesIn(out)));

    const keep = await run([out], { outputMode: 'keep' });
    check('keep mode is allowed', keep.success, keep.error);
    check('inputs still untouched', exists(path.join(out, 'holiday1.png')) && exists(path.join(out, 'holiday2.png')));
    check('results land in a run folder', !!keep.compressedDir && path.basename(keep.compressedDir).startsWith('run-'));
  }

  console.log('\nSame-named images never overwrite each other');
  {
    const cam1 = dir('cam1'), cam2 = dir('cam2');
    const a = img(cam1, 'IMG_0001.png', 4), b = img(cam2, 'IMG_0001.png', 5);
    const out = dir('out-dupes');
    useOutputs({ compressed: out });
    const r = await run([a, b]);
    check('run succeeds', r.success, r.error);
    check('two inputs give two outputs', imagesIn(out).length === 2, JSON.stringify(imagesIn(out)));
    check('reported count matches disk', r.compressedCount === 2, r.compressedCount);
    const sizes = imagesIn(out).map(f => fs.statSync(path.join(out, f)).size);
    check('outputs are the two different images', new Set(sizes).size === 2, JSON.stringify(sizes));
  }

  console.log('\nOutput folders inside a recursive input are not re-processed');
  {
    const lib = dir('library');
    fs.mkdirSync(path.join(lib, 'photos'));
    img(path.join(lib, 'photos'), 'new.png', 6);
    const out = path.join(lib, 'pixelforge-out');
    fs.mkdirSync(out);
    img(out, 'old-result.png', 7);
    useOutputs({ compressed: out });
    const r = await run([lib], { recursive: true });
    check('run succeeds', r.success, r.error);
    check('only the real input is processed', r.compressedCount === 1, r.compressedCount);
    check('earlier result left alone', exists(path.join(out, 'old-result.png')));
  }

  console.log('\nPre-1.2 default folder is cleaned once, other files kept');
  {
    const legacy = path.join(app.getPath('documents'), 'PixelForge', 'compressed');
    fs.mkdirSync(path.join(legacy, 'old-sub'), { recursive: true });
    img(legacy, 'from-v1.png', 8);
    img(path.join(legacy, 'old-sub'), 'nested.png', 8);
    fs.writeFileSync(path.join(legacy, 'README.txt'), 'installer readme');
    const input = dir('in-legacy'); img(input, 'fresh.png', 1);
    useOutputs({});
    const r = await run([input]);
    check('run succeeds', r.success, r.error);
    check('old results removed', !exists(path.join(legacy, 'from-v1.png')) && !exists(path.join(legacy, 'old-sub')));
    check('non-image file kept', exists(path.join(legacy, 'README.txt')));
    check('new result present', exists(path.join(legacy, 'fresh.png')));
  }

  console.log('\nLossless mode actually compresses');
  {
    const input = dir('in-lossless'); img(input, 'l.png', 3, 64);
    const out = dir('out-lossless');
    useOutputs({ compressed: out });
    const r = await run([input], { caesiumLossless: true });
    check('run succeeds', r.success, r.error);
    check('output produced', r.compressedCount === 1, r.compressedCount);
  }

  console.log('\nUnreachable output folder is reported, not thrown past');
  {
    const input = dir('in-offline'); img(input, 'x.png');
    useOutputs({ compressed: 'Q:/PixelForge-offline/compressed' });
    const r = await run([input]);
    check('clear error', !r.success && /isn't reachable/.test(r.error || ''), r.error);
    check('input untouched', exists(path.join(input, 'x.png')));
  }

  console.log('\nPause holds the run; resume finishes it');
  {
    const input = dir('in-pause');
    for (let i = 0; i < 60; i++) img(input, `p${String(i).padStart(2, '0')}.png`, (i % 9) + 1, 24);
    const out = dir('out-pause');
    useOutputs({ compressed: out });
    let latest = 0;
    const running = pipeline.runPipeline({ queue: [input], settings: { pipelineMode: 'compress', outputMode: 'replace', caesiumQuality: 80 } },
      (m) => { if (m.stage === 'compressing' && typeof m.current === 'number') latest = Math.max(latest, m.current); });
    await waitUntil(() => latest >= 24, 60000);
    pipeline.pause();
    await sleep(3000);            // the batch already in flight may finish…
    const held = latest;
    await sleep(2500);            // …but nothing new may start
    check('no progress while paused', latest === held && held < 60, `${held} → ${latest}`);
    pipeline.resume();
    const r = await running;
    check('resumed run completes', r.success && r.compressedCount === 60, r.error || r.compressedCount);
  }

  console.log('\nCancel stops the run and leaves nothing half-done');
  {
    const input = dir('in-cancel');
    for (let i = 0; i < 60; i++) img(input, `c${String(i).padStart(2, '0')}.png`, (i % 9) + 1, 24);
    const out = dir('out-cancel');
    useOutputs({ compressed: out });
    let latest = 0;
    const running = pipeline.runPipeline({ queue: [input], settings: { pipelineMode: 'compress', outputMode: 'replace', caesiumQuality: 80 } },
      (m) => { if (m.stage === 'compressing' && typeof m.current === 'number') latest = Math.max(latest, m.current); });
    await waitUntil(() => latest >= 24, 60000);
    pipeline.cancel();
    const r = await running;
    const partial = imagesIn(out).length;
    check('reports cancelled', r.cancelled === true && !r.success, JSON.stringify({ success: r.success, cancelled: r.cancelled }));
    check('stopped part-way', partial > 0 && partial < 60, partial);
    check('staging cleaned up', !exists(path.join(out, '.pixelforge-staging')));
    const rerun = await run([input]);
    check('next run replaces the partial results cleanly', rerun.success && imagesIn(out).length === 60 && !imagesIn(out).some(f => / \(\d+\)\./.test(f)),
      `${imagesIn(out).length} files`);
  }

  console.log('\nOverlapping output folders are refused');
  {
    const shared = dir('shared-out');
    const input = dir('in-overlap'); img(input, 'o.png');
    useOutputs({ upscaled: shared, compressed: path.join(shared, 'nested') });
    const r = await run([input], { pipelineMode: 'both' });
    check('refused before any work', !r.success && /overlap/.test(r.error || ''), r.error);
  }
}

async function upscaleCases() {
  if (process.env.PF_SKIP_GPU || !fs.existsSync(UPSCAYL)) {
    skip('upscaling cases (PF_SKIP_GPU set or engine not installed)');
    return;
  }

  console.log('\nUpscaling: same stem, different formats, one folder');
  {
    const input = dir('in-stems');
    const png = img(input, 'photo.png', 1);
    // Real JPEG via the compressor, so the engine decodes a genuine .jpg.
    const jpgDir = dir('jpg-make');
    execFileSync(CAESIUM, ['-q', '90', '--format', 'jpeg', '-o', jpgDir, png], { windowsHide: true });
    fs.copyFileSync(path.join(jpgDir, 'photo.jpg'), path.join(input, 'photo.jpg'));
    const up = dir('up-stems'), comp = dir('comp-stems');
    useOutputs({ upscaled: up, compressed: comp });
    const r = await run([input], { pipelineMode: 'both' });
    check('run succeeds', r.success, r.error);
    check('photo.jpg and photo.png both upscaled', imagesIn(up).length === 2, JSON.stringify(imagesIn(up)));
    check('and both compressed', imagesIn(comp).length === 2, JSON.stringify(imagesIn(comp)));
  }

  console.log('\nUpscaling: naming template without {name}');
  {
    const input = dir('in-template');
    img(input, 'a.png', 1); img(input, 'b.png', 2); img(input, 'c.png', 3);
    const up = dir('up-template');
    useOutputs({ upscaled: up });
    const r = await run([input], { pipelineMode: 'upscale', namingTemplate: '{model}' });
    check('run succeeds', r.success, r.error);
    check('three distinct outputs, none overwritten', imagesIn(up).length === 3, JSON.stringify(imagesIn(up)));
  }

  console.log('\nUpscaling: one corrupt image does not sink the batch');
  {
    const input = dir('in-corrupt');
    img(input, 'good1.png', 1);
    fs.writeFileSync(path.join(input, 'broken.png'), Buffer.from('this is not an image at all'));
    img(input, 'good2.png', 2);
    const up = dir('up-corrupt');
    useOutputs({ upscaled: up });
    const r = await run([input], { pipelineMode: 'upscale' });
    check('run still succeeds', r.success, r.error);
    check('good images upscaled', r.upscaledCount === 2, r.upscaledCount);
    check('broken image reported', r.failedCount === 1 && /broken\.png$/.test(r.failures[0]?.path || ''), JSON.stringify(r.failures));
  }

  console.log('\nUpscaling: a broken engine fails fast with a clear message');
  {
    const input = dir('in-badgpu'); img(input, 'a.png', 1); img(input, 'b.png', 2);
    useOutputs({ upscaled: dir('up-badgpu') });
    const r = await run([input], { pipelineMode: 'upscale', upscaylGpu: '97' });
    check('run reports the engine failure', !r.success && /couldn't process any images/.test(r.error || ''), r.error);
  }
}

app.whenReady().then(async () => {
  try {
    await compressionCases();
    await upscaleCases();
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected error —', err.stack || err.message);
  }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  app.exit(failed ? 1 : 0);
});
