'use strict';

// Pure-logic checks that need neither Electron nor a network — fast enough to
// run before every commit.
//   node tools/test-unit.js

const guard = require('../src/main/guard');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

section('guard.isAllowedExternalUrl');
for (const url of [
  'https://pixelforge.reforatech.com',
  'https://pixelforge.reforatech.com/docs?x=1#top',
  'https://github.com/refora-technologies/pixelforge',
  'https://github.com/refora-technologies/pixelforge/issues',
  'https://github.com/refora-technologies/pixelforge/releases/tag/v1.2.0',
]) check(`allows ${url}`, guard.isAllowedExternalUrl(url));
for (const [why, url] of [
  ['plain http', 'http://pixelforge.reforatech.com'],
  ['another repo', 'https://github.com/someone/else'],
  ['a look-alike repo', 'https://github.com/refora-technologies/pixelforge-evil'],
  ['a look-alike host', 'https://pixelforge.reforatech.com.evil.io/'],
  ['a subdomain', 'https://evil.pixelforge.reforatech.com/'],
  ['credentials', 'https://user:pw@github.com/refora-technologies/pixelforge'],
  ['a port', 'https://github.com:8443/refora-technologies/pixelforge'],
  ['file:', 'file:///C:/Windows/System32/calc.exe'],
  ['javascript:', 'javascript:alert(1)'],
  ['a UNC-ish path', '\\\\server\\share\\x.exe'],
  ['garbage', 'not a url'],
  ['nothing', undefined],
  ['an object', { href: 'https://github.com/refora-technologies/pixelforge' }],
]) check(`refuses ${why}`, !guard.isAllowedExternalUrl(url), String(url));

section('guard.isOpenableFile');
for (const p of ['C:\\out\\photo.png', 'C:\\out\\photo.JPEG', 'D:/x/y.webp', 'C:\\logs\\run.log', 'C:\\a\\b.tif'])
  check(`opens ${p}`, guard.isOpenableFile(p));
for (const [why, p] of [
  ['an executable', 'C:\\out\\photo.png.exe'],
  ['a script', 'C:\\out\\run.bat'],
  ['a shortcut', 'C:\\out\\photo.lnk'],
  ['a relative path', 'photo.png'],
  ['no extension', 'C:\\out\\photo'],
  ['a non-string', 42],
]) check(`refuses ${why}`, !guard.isOpenableFile(p), String(p));

// ── Image headers ──
// Built from each format's spec, so every branch of the reader is exercised
// without fixture files.
function jpeg(width, height, { exifBytes = 0, progressive = false } = {}) {
  const seg = (marker, body) => {
    const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
  };
  const exif = [];
  for (let left = exifBytes; left > 0; left -= 65000) exif.push(seg(0xe1, Buffer.alloc(Math.min(left, 65000), 0xff)));
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); sof[5] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
    ...exif,
    seg(0xdb, Buffer.alloc(65)),
    seg(0xc4, Buffer.alloc(30)), // a Huffman table (C4) must not be taken for a frame
    seg(progressive ? 0xc2 : 0xc0, sof),
    seg(0xda, Buffer.alloc(10)),
  ]);
}
function webp(kind, width, height) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0); b.write('WEBP', 8); b.write(kind, 12);
  if (kind === 'VP8 ') { b.writeUInt16LE(width, 26); b.writeUInt16LE(height, 28); }
  if (kind === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21); }
  if (kind === 'VP8X') { b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3); }
  return b;
}
function bmp(width, height) {
  const b = Buffer.alloc(54); b.write('BM', 0); b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18); b.writeInt32LE(height, 22); return b;
}
function tiff(width, height, le) {
  const b = Buffer.alloc(8 + 2 + 2 * 12 + 4);
  const w16 = (v, o) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (v, o) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  b.write(le ? 'II' : 'MM', 0); w16(42, 2); w32(8, 4); w16(2, 8);
  w16(256, 10); w16(4, 12); w32(1, 14); w32(width, 18);          // LONG
  w16(257, 22); w16(3, 24); w32(1, 26); w16(height, 30);         // SHORT
  return b;
}

const { sizeFromBuffer, readImageSize } = require('../src/main/imagesize');
const { makePng } = require('./lib/png');
const dims = (s) => (s ? `${s.width}x${s.height}` : 'null');

section('imagesize');
for (const [name, buf, want] of [
  ['png', makePng(37, 21), '37x21'],
  ['jpeg (baseline)', jpeg(4032, 3024), '4032x3024'],
  ['jpeg (progressive)', jpeg(800, 600, { progressive: true }), '800x600'],
  ['webp lossy', webp('VP8 ', 1920, 1080), '1920x1080'],
  ['webp lossless', webp('VP8L', 1000, 700), '1000x700'],
  ['webp extended', webp('VP8X', 5000, 4000), '5000x4000'],
  ['bmp', bmp(640, 480), '640x480'],
  ['bmp stored top-down', bmp(640, -480), '640x480'],
  ['tiff little-endian', tiff(3000, 2000, true), '3000x2000'],
  ['tiff big-endian', tiff(1200, 900, false), '1200x900'],
]) check(name, dims(sizeFromBuffer(buf)) === want, dims(sizeFromBuffer(buf)));
for (const [name, buf] of [
  ['empty', Buffer.alloc(0)],
  ['text', Buffer.from('hello, not an image')],
  ['truncated png', makePng(8, 8).subarray(0, 20)],
  ['jpeg without a frame', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
]) check(`${name} → null`, sizeFromBuffer(buf) === null);

(async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-unit-'));
  try {
    const big = path.join(tmp, 'exif-heavy.jpg');
    fs.writeFileSync(big, jpeg(6000, 4000, { exifBytes: 200000 }));
    check('frame behind a 200 KB EXIF block', dims(await readImageSize(big)) === '6000x4000', dims(await readImageSize(big)));
    const png = path.join(tmp, 'a.png');
    fs.writeFileSync(png, makePng(64, 48));
    check('png from disk', dims(await readImageSize(png)) === '64x48');
    check('missing file → null', (await readImageSize(path.join(tmp, 'nope.png'))) === null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── Output estimate ──
  const { estimateOutput } = require('../src/main/estimate');
  const photo = { size: 180000, ext: '.jpg', width: 1200, height: 900 };
  const base = { pipelineMode: 'both', upscaylScale: '4', upscaylFormat: 'png', caesiumQuality: 82, caesiumFormat: 'same', caesiumLossless: false };
  const est = (o, items = [photo]) => estimateOutput(items, { ...base, ...o });
  const MB = 1024 * 1024;

  section('estimate');
  const up = est({ pipelineMode: 'upscale' });
  check('upscale-only writes nothing compressed', up.compressed === 0);
  check('4× PNG of a 1200×900 photo ≈ 30 MB', up.upscaled > 25 * MB && up.upscaled < 35 * MB, (up.upscaled / MB).toFixed(1));
  check('2× is a quarter of 4×', Math.abs(est({ pipelineMode: 'upscale', upscaylScale: '2' }).upscaled * 4 - up.upscaled) < 4);
  check('JPG upscales are smaller than PNG', est({ pipelineMode: 'upscale', upscaylFormat: 'jpg' }).upscaled < up.upscaled);
  const both = est({});
  check('compressing shrinks the upscale', both.compressed > 0 && both.compressed < both.upscaled);
  check('lower quality, smaller output', est({ caesiumQuality: 40 }).compressed < both.compressed);
  check('lossless keeps the upscaled size', est({ caesiumLossless: true }).compressed === both.upscaled);
  check('converting to JPEG is smaller than PNG', est({ caesiumFormat: 'jpeg' }).compressed < both.compressed);
  const only = est({ pipelineMode: 'compress' });
  check('compress-only never exceeds the source', only.upscaled === 0 && only.compressed > 0 && only.compressed <= photo.size);
  const blind = est({ pipelineMode: 'upscale' }, [{ size: photo.size, ext: '.jpg' }]);
  check('unreadable header still estimates, on the high side', blind.upscaled >= up.upscaled, (blind.upscaled / MB).toFixed(1));
  check('scales with the number of images', est({}, [photo, photo, photo]).upscaled === up.upscaled * 3);
  check('nothing in, nothing out', JSON.stringify(est({}, [])) === '{"upscaled":0,"compressed":0}');

  // ── Run history ──
  const history = require('../src/main/history');
  const memStore = (init = {}) => {
    const data = { ...init };
    return { get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, data };
  };
  const result = (o = {}) => ({ success: true, upscaledCount: 3, compressedCount: 3, failedCount: 1, savedPct: 61.6, durationMs: 90500,
    upscaledDir: 'C:/out/up', compressedDir: 'C:/out/comp', results: [{}, {}, {}], ...o });

  section('history');
  const st = memStore();
  const e = history.record(st, result(), { queue: ['C:/photos/Holiday', 'C:/photos/Wedding'], mode: 'both' }, 1000);
  check('records what a run did', e.images === 3 && e.failed === 1 && e.savedPct === 62 && e.durationMs === 90500 && e.mode === 'both');
  check('names the inputs, not their paths', JSON.stringify(e.inputs) === '["Holiday","Wedding"]' && e.inputCount === 2);
  history.record(st, result({ results: [{}] }), { queue: ['C:/x'], mode: 'upscale' }, 2000);
  check('newest first', st.data['app.runHistory'][0].at === 2000);
  for (let i = 0; i < 30; i++) history.record(st, result(), { queue: ['C:/x'] }, 3000 + i);
  check(`keeps the last ${history.MAX_RUNS}`, st.data['app.runHistory'].length === history.MAX_RUNS);
  const many = history.entryFor(result(), { queue: ['a', 'b', 'c', 'd', 'e'] });
  check('lists at most three inputs but counts all', many.inputs.length === 3 && many.inputCount === 5);
  const junk = memStore({ 'app.runHistory': [null, 'x', { at: 'soon' }, { at: 5, mode: 'evil', images: -3, inputs: [1, 'ok'], savedPct: 'lots' }] });
  const read = history.list(junk);
  check('drops malformed entries', read.length === 1, JSON.stringify(read));
  check('repairs odd fields', read[0] && read[0].mode === 'both' && read[0].images === 0 && read[0].savedPct === null && JSON.stringify(read[0].inputs) === '["ok"]');
  check('a history that isn\'t a list is empty', history.list(memStore({ 'app.runHistory': { at: 1 } })).length === 0);
  check('marks missing folders', read[0] && read[0].upscaledExists === false && read[0].compressedExists === false);
  history.clear(st);
  check('clear empties it', history.list(st).length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
