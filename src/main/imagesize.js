'use strict';

// Image dimensions straight from the file header — no decoding, a few KB read
// per file — for the formats PixelForge accepts (paths.IMAGE_RE). Returns null
// for anything it can't read; callers fall back to the file size.

const fsp = require('fs').promises;

const HEAD_BYTES = 64 * 1024;
// JPEG size markers can sit behind a large EXIF block (embedded thumbnails).
const JPEG_MAX_BYTES = 1024 * 1024;

function pngSize(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function bmpSize(b) {
  if (b.length < 26 || b.toString('ascii', 0, 2) !== 'BM') return null;
  const header = b.readUInt32LE(14);
  if (header === 12) return { width: b.readUInt16LE(18), height: b.readUInt16LE(20) };
  return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
}

function webpSize(b) {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

// Start-of-frame markers, less DHT (C4), JPG (C8) and DAC (CC).
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan
    if (SOF.has(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function tiffSize(b) {
  if (b.length < 8) return null;
  const order = b.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > b.length) return null;
  let width = 0, height = 0;
  const count = u16(ifd);
  for (let n = 0; n < count; n++) {
    const e = ifd + 2 + n * 12;
    if (e + 12 > b.length) break;
    const tag = u16(e);
    if (tag !== 256 && tag !== 257) continue;
    const value = u16(e + 2) === 3 ? u16(e + 8) : u32(e + 8);
    if (tag === 256) width = value; else height = value;
  }
  return width && height ? { width, height } : null;
}

function sizeFromBuffer(b) {
  const size = pngSize(b) || jpegSize(b) || webpSize(b) || bmpSize(b) || tiffSize(b);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

async function readImageSize(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    let buf = Buffer.alloc(HEAD_BYTES);
    let { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    let size = sizeFromBuffer(buf.subarray(0, bytesRead));
    if (!size && bytesRead === HEAD_BYTES && buf[0] === 0xff && buf[1] === 0xd8) {
      buf = Buffer.alloc(JPEG_MAX_BYTES);
      ({ bytesRead } = await handle.read(buf, 0, JPEG_MAX_BYTES, 0));
      size = sizeFromBuffer(buf.subarray(0, bytesRead));
    }
    return size;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = { readImageSize, sizeFromBuffer };
