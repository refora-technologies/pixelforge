'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');

const IMAGE_RE = /\.(jpg|jpeg|png|webp|bmp|tiff|tif)$/i;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// For start-up and pre-flight checks, where an unreachable folder (unplugged
// drive, bad setting) must be reported rather than thrown.
function tryEnsureDir(dir) {
  try { ensureDir(dir); return true; } catch { return false; }
}

// path.win32.relative compares case-insensitively, so these match Windows semantics.
function relativeFrom(parent, child) {
  return path.relative(path.resolve(parent), path.resolve(child));
}
function samePath(a, b) {
  return relativeFrom(a, b) === '';
}
function isStrictlyInside(child, parent) {
  const rel = relativeFrom(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function isSameOrInside(child, parent) {
  return samePath(child, parent) || isStrictlyInside(child, parent);
}

function getBinDir()        { return path.join(app.getPath('userData'), 'bin'); }
function getLogsDir()       { return path.join(app.getPath('userData'), 'logs'); }
function getTempInputDir()  { return path.join(getBinDir(), '_tmp_input'); }

function getBundledModelsDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'models');
  return path.join(__dirname, '..', 'models');
}

function dirHasModels(dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.param'));
  } catch { return false; }
}

function getModelsDir() {
  const userPath = storedPath('paths.models', '');
  if (userPath && dirHasModels(userPath)) return userPath;

  const bundled = getBundledModelsDir();
  if (dirHasModels(bundled)) return bundled;

  return userPath || path.join(getBinDir(), 'models');
}

function defaultUpscaylBin()   { return path.join(getBinDir(), 'upscayl-bin.exe'); }
function defaultCaesiumBin()   { return path.join(getBinDir(), 'caesiumclt.exe'); }
function defaultUpscaledDir()  { return path.join(app.getPath('documents'), 'PixelForge', 'upscaled'); }
function defaultCompressedDir(){ return path.join(app.getPath('documents'), 'PixelForge', 'compressed'); }

// A blank stored value means "use the default", never "use the current directory".
function storedPath(key, fallback) {
  const value = store.get(key, '');
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function getUpscaylBin()    { return storedPath('paths.upscaylBin', defaultUpscaylBin()); }
function getCaesiumBin()    { return storedPath('paths.caesiumBin', defaultCaesiumBin()); }
function getUpscaledDir()   { return storedPath('paths.upscaled', defaultUpscaledDir()); }
function getCompressedDir() { return storedPath('paths.compressed', defaultCompressedDir()); }

function listModelsFromDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.param'))
      .map(f => f.replace('.param', ''))
      .sort();
  } catch { return []; }
}

function modelDisplayName(id) {
  const map = {
    'upscayl-standard-4x':     'Upscayl Standard 4x (Recommended)',
    'upscayl-lite-4x':         'Upscayl Lite 4x (Faster)',
    'ultrasharp-4x':           'Ultrasharp 4x',
    'remacri-4x':              'Remacri 4x',
    'ultramix-balanced-4x':    'Ultramix Balanced 4x',
    'digital-art-4x':          'Digital Art 4x',
    'high-fidelity-4x':        'High Fidelity 4x',
    'realesrgan-x4plus':       'Real-ESRGAN 4x (General)',
    'realesrgan-x4plus-anime': 'Real-ESRGAN Anime 4x',
  };
  return map[id] || id;
}

module.exports = {
  IMAGE_RE,
  ensureDir,
  tryEnsureDir,
  samePath,
  isStrictlyInside,
  isSameOrInside,
  getBinDir,
  getLogsDir,
  getTempInputDir,
  getBundledModelsDir,
  getModelsDir,
  defaultUpscaylBin,
  defaultCaesiumBin,
  defaultUpscaledDir,
  defaultCompressedDir,
  getUpscaylBin,
  getCaesiumBin,
  getUpscaledDir,
  getCompressedDir,
  listModelsFromDir,
  modelDisplayName,
};
