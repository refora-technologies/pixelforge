'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');

const IMAGE_RE = /\.(jpg|jpeg|png|webp|bmp|tiff|tif)$/i;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  const userPath = store.get('paths.models', '');
  if (userPath && dirHasModels(userPath)) return userPath;

  const bundled = getBundledModelsDir();
  if (dirHasModels(bundled)) return bundled;

  return userPath || path.join(getBinDir(), 'models');
}

function getUpscaylBin()   { return store.get('paths.upscaylBin', path.join(getBinDir(), 'upscayl-bin.exe')); }
function getCaesiumBin()   { return store.get('paths.caesiumBin', path.join(getBinDir(), 'caesiumclt.exe')); }
function getUpscaledDir()  { return store.get('paths.upscaled', path.join(app.getPath('documents'), 'PixelForge', 'upscaled')); }
function getCompressedDir(){ return store.get('paths.compressed', path.join(app.getPath('documents'), 'PixelForge', 'compressed')); }

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
  getBinDir,
  getLogsDir,
  getTempInputDir,
  getBundledModelsDir,
  getModelsDir,
  getUpscaylBin,
  getCaesiumBin,
  getUpscaledDir,
  getCompressedDir,
  listModelsFromDir,
  modelDisplayName,
};
