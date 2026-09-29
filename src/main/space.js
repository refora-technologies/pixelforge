'use strict';

// Will this run fit on disk? A 4× upscale multiplies pixels by 16, so a folder
// of phone photos can turn into tens of gigabytes — and running out halfway
// leaves a half-written batch. Estimates the output per drive (estimate.js)
// and compares it with the free space there.

const fsp = require('fs').promises;
const path = require('path');
const { collectInputs } = require('./scan');
const { readImageSize } = require('./imagesize');
const paths = require('./paths');
const { estimateOutput } = require('./estimate');

const RESERVE_BYTES = 512 * 1024 * 1024;

// Nearest existing folder at or above p — the output folder may not exist yet.
async function existingAncestor(p) {
  let dir = path.resolve(p);
  for (;;) {
    try { if ((await fsp.stat(dir)).isDirectory()) return dir; } catch {}
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

async function freeBytes(dir) {
  const at = await existingAncestor(dir);
  if (!at) return null;
  try { const st = await fsp.statfs(at); return st.bavail * st.bsize; } catch { return null; }
}

// Reads headers a batch at a time, and for very large selections only a
// sample of them — the average is what matters, not every file.
const SAMPLE_LIMIT = 1500;
async function measure(files) {
  const step = Math.max(1, Math.ceil(files.length / SAMPLE_LIMIT));
  const sample = files.filter((_, i) => i % step === 0);
  for (let i = 0; i < sample.length; i += 32) {
    await Promise.all(sample.slice(i, i + 32).map(async (f) => {
      const size = await readImageSize(f.abs);
      if (size) Object.assign(f, size);
    }));
  }
  return { sample, factor: files.length / (sample.length || 1) };
}

// → { needed, drives: [{ root, folders, needed, free }], short: [...same] }
async function planSpace(queue, s) {
  const mode = ['both', 'upscale', 'compress'].includes(s.pipelineMode) ? s.pipelineMode : 'both';
  const upBase = paths.getUpscaledDir();
  const compBase = paths.getCompressedDir();
  const collected = await collectInputs(queue, { recursive: !!s.recursive, excludeDirs: [upBase, compBase], withSize: true });
  const files = collected.flatMap(e => e.files).map(f => ({ ...f, ext: path.extname(f.abs) }));
  if (!files.length) return { needed: 0, drives: [], short: [] };

  const { sample, factor } = await measure(files);
  const est = estimateOutput(sample, s);
  const wants = [];
  if (mode !== 'compress') wants.push([upBase, est.upscaled * factor]);
  if (mode !== 'upscale') wants.push([compBase, est.compressed * factor]);

  const byRoot = new Map();
  for (const [folder, bytes] of wants) {
    const root = path.parse(path.resolve(folder)).root.toUpperCase();
    const d = byRoot.get(root) || { root, folders: [], needed: 0, free: null };
    d.folders.push(folder);
    d.needed += Math.round(bytes);
    byRoot.set(root, d);
  }
  const drives = [...byRoot.values()];
  for (const d of drives) d.free = await freeBytes(d.folders[0]);
  // Unknown free space (a network share that won't say) isn't a reason to stop.
  const short = drives.filter(d => d.free !== null && d.needed + RESERVE_BYTES > d.free);
  return { needed: drives.reduce((n, d) => n + d.needed, 0), drives, short };
}

module.exports = { planSpace, RESERVE_BYTES };
