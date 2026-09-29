'use strict';

const store = require('./store');
const paths = require('./paths');

// Sanitisers return the cleaned value, or undefined to reject it.
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (list) => (v) => (list.includes(String(v)) ? String(v) : undefined);
const int = (min, max) => (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined);
// '' is meaningful for paths: it means "go back to the default".
const pathValue = (v) => (typeof v === 'string' ? v.trim() : undefined);
const strArray = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : undefined);
const tileSize = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 && n <= 4096 ? String(n) : undefined;
};

// [store key, setting name, default, sanitiser — undefined means "reject"]
/** @type {Array<[string, string, () => any, (v: any) => any]>} */
const SETTINGS_MAP = [
  ['upscayl.model',     'upscaylModel',     () => 'upscayl-standard-4x', str],
  ['upscayl.scale',     'upscaylScale',     () => '4', oneOf(['2', '3', '4'])],
  ['upscayl.format',    'upscaylFormat',    () => 'png', oneOf(['png', 'jpg', 'webp'])],
  ['upscayl.gpu',       'upscaylGpu',       () => 'auto', str],
  ['upscayl.tileSize',  'upscaylTileSize',  () => '0', tileSize],
  ['upscayl.tta',       'upscaylTta',       () => false, bool],

  ['caesium.quality',   'caesiumQuality',   () => 82, int(0, 100)],
  ['caesium.format',    'caesiumFormat',    () => 'same', oneOf(['same', 'jpeg', 'png', 'webp'])],
  ['caesium.lossless',  'caesiumLossless',  () => false, bool],
  ['caesium.keepMeta',  'caesiumKeepMeta',  () => false, bool],

  // Defaults are the real defaults — not the stored value read back, which is
  // how a broken path used to survive "Reset to Defaults".
  ['paths.models',      'modelsPath',       () => '', pathValue],
  ['paths.upscaylBin',  'upscaylBinPath',   () => paths.defaultUpscaylBin(), pathValue],
  ['paths.caesiumBin',  'caesiumBinPath',   () => paths.defaultCaesiumBin(), pathValue],
  ['paths.upscaled',    'upscaledPath',     () => paths.defaultUpscaledDir(), pathValue],
  ['paths.compressed',  'compressedPath',   () => paths.defaultCompressedDir(), pathValue],

  ['app.inputQueue',       'savedInputQueue',  () => [], strArray],
  ['app.accentColor',      'accentColor',      () => '#6366f1', hex],
  ['app.setupDone',        'setupDone',        () => false, bool],
  ['app.theme',            'theme',            () => 'dark', oneOf(['dark', 'light'])],
  ['app.pipelineMode',     'pipelineMode',     () => 'both', oneOf(['both', 'upscale', 'compress'])],
  ['app.recursive',        'recursive',        () => false, bool],
  ['app.namingTemplate',   'namingTemplate',   () => '{name}', str],
  ['app.notifyOnComplete', 'notifyOnComplete', () => true, bool],
  ['app.soundOnComplete',  'soundOnComplete',  () => false, bool],
  ['app.autoCheckUpdates', 'autoCheckUpdates', () => true, bool],
  ['app.outputMode',       'outputMode',       () => 'replace', oneOf(['replace', 'keep'])],
  ['app.restoreSession',   'restoreSession',   () => false, bool],
  ['app.confirmOnExit',    'confirmOnExit',    () => true, bool],
];

// Keys that are app state rather than user preference — untouched by "reset to defaults".
const PRESERVED_ON_RESET = new Set(['app.setupDone', 'app.inputQueue', 'app.gpuCache', 'app.windowBounds']);

function getSettings() {
  const out = {};
  for (const [storeKey, settingKey, def, sanitize] of SETTINGS_MAP) {
    const value = sanitize(store.get(storeKey));
    out[settingKey] = value === undefined || value === '' ? def() : value;
  }
  return out;
}

function saveSettings(incoming) {
  const rejected = [];
  for (const [storeKey, settingKey, , sanitize] of SETTINGS_MAP) {
    if (!incoming || !(settingKey in incoming)) continue;
    const value = sanitize(incoming[settingKey]);
    if (value === undefined) { rejected.push(settingKey); continue; }
    if (value === '' && storeKey.startsWith('paths.')) store.delete(storeKey);
    else store.set(storeKey, value);
  }
  return { ok: rejected.length === 0, rejected, settings: getSettings() };
}

function resetSettings() {
  for (const [storeKey] of SETTINGS_MAP) {
    if (!PRESERVED_ON_RESET.has(storeKey)) store.delete(storeKey);
  }
  return getSettings();
}

module.exports = { getSettings, saveSettings, resetSettings, SETTINGS_MAP };
