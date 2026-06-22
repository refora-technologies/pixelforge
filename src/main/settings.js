'use strict';

const store = require('./store');
const paths = require('./paths');

const SETTINGS_MAP = [
  ['upscayl.model',     'upscaylModel',     () => 'upscayl-standard-4x'],
  ['upscayl.scale',     'upscaylScale',     () => '4'],
  ['upscayl.format',    'upscaylFormat',    () => 'png'],
  ['upscayl.gpu',       'upscaylGpu',       () => 'auto'],
  ['upscayl.tileSize',  'upscaylTileSize',  () => '0'],
  ['upscayl.tta',       'upscaylTta',       () => false],

  ['caesium.quality',   'caesiumQuality',   () => 82],
  ['caesium.format',    'caesiumFormat',    () => 'same'],
  ['caesium.lossless',  'caesiumLossless',  () => false],
  ['caesium.keepMeta',  'caesiumKeepMeta',  () => false],

  ['paths.models',      'modelsPath',       () => ''],
  ['paths.upscaylBin',  'upscaylBinPath',   () => paths.getUpscaylBin()],
  ['paths.caesiumBin',  'caesiumBinPath',   () => paths.getCaesiumBin()],
  ['paths.upscaled',    'upscaledPath',     () => paths.getUpscaledDir()],
  ['paths.compressed',  'compressedPath',   () => paths.getCompressedDir()],

  ['app.inputQueue',      'savedInputQueue',   () => []],
  ['app.accentColor',     'accentColor',       () => '#6366f1'],
  ['app.setupDone',       'setupDone',         () => false],
  ['app.theme',           'theme',             () => 'dark'],
  ['app.pipelineMode',    'pipelineMode',      () => 'both'],
  ['app.recursive',       'recursive',         () => false],
  ['app.namingTemplate',  'namingTemplate',    () => '{name}'],
  ['app.notifyOnComplete','notifyOnComplete',  () => true],
  ['app.soundOnComplete', 'soundOnComplete',   () => false],
  ['app.autoCheckUpdates','autoCheckUpdates',  () => true],
];

function getSettings() {
  const out = {};
  for (const [storeKey, settingKey, def] of SETTINGS_MAP) {
    out[settingKey] = store.get(storeKey, def());
  }
  return out;
}

function saveSettings(incoming) {
  for (const [storeKey, settingKey] of SETTINGS_MAP) {
    if (incoming[settingKey] !== undefined) store.set(storeKey, incoming[settingKey]);
  }
  return { ok: true };
}

module.exports = { getSettings, saveSettings, SETTINGS_MAP };
