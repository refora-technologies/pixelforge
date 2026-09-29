'use strict';

// A short history of finished runs, so last week's batch can be found again
// without remembering where it went. Kept in the settings store under
// app.runHistory, newest first.

const fs = require('fs');
const path = require('path');

const KEY = 'app.runHistory';
const MAX_RUNS = 20;
const MODES = ['both', 'upscale', 'compress'];

const count = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
const text = (s, max = 1024) => (typeof s === 'string' ? s.slice(0, max) : '');

// Only well-formed entries survive a read — the store is a file anyone can edit.
function clean(e) {
  if (!e || typeof e !== 'object' || !Number.isFinite(e.at)) return null;
  return {
    at: e.at,
    mode: MODES.includes(e.mode) ? e.mode : 'both',
    inputs: Array.isArray(e.inputs) ? e.inputs.filter(s => typeof s === 'string').slice(0, 3).map(s => text(s, 260)) : [],
    inputCount: count(e.inputCount),
    images: count(e.images),
    failed: count(e.failed),
    savedPct: Number.isFinite(e.savedPct) ? Math.round(e.savedPct) : null,
    durationMs: count(e.durationMs),
    upscaledDir: text(e.upscaledDir),
    compressedDir: text(e.compressedDir),
  };
}

function entryFor(result, { queue = [], mode = 'both' } = {}, now = Date.now()) {
  return clean({
    at: now,
    mode,
    inputs: queue.slice(0, 3).map(p => path.basename(p) || p),
    inputCount: queue.length,
    images: Array.isArray(result.results) ? result.results.length : Math.max(result.upscaledCount || 0, result.compressedCount || 0),
    failed: result.failedCount,
    savedPct: result.savedPct,
    durationMs: result.durationMs,
    upscaledDir: result.upscaledDir,
    compressedDir: result.compressedDir,
  });
}

function read(store) {
  const raw = store.get(KEY, []);
  return (Array.isArray(raw) ? raw : []).map(clean).filter(Boolean);
}

function record(store, result, run, now) {
  const entry = entryFor(result, run, now);
  store.set(KEY, [entry, ...read(store)].slice(0, MAX_RUNS));
  return entry;
}

const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };

// Newest first, each marked with whether its output folders still exist.
function list(store) {
  return read(store).map(e => ({ ...e, upscaledExists: isDir(e.upscaledDir), compressedExists: isDir(e.compressedDir) }));
}

function clear(store) { store.set(KEY, []); }

module.exports = { record, list, clear, entryFor, MAX_RUNS };
