'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./src/main/store');
const paths = require('./src/main/paths');
const settingsModule = require('./src/main/settings');
const setup = require('./src/main/setup');
const gpu = require('./src/main/gpu');
const updater = require('./src/main/updater');
const pipeline = require('./src/main/pipeline');

let mainWindow = null;

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function getSavedBounds() {
  const b = store.get('app.windowBounds', null);
  if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return null;
  return b;
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    store.set('app.windowBounds', { ...bounds, maximized });
  } catch {}
}

function createWindow() {
  const saved = getSavedBounds();
  mainWindow = new BrowserWindow({
    width: saved?.width || 1180,
    height: saved?.height || 760,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1080,
    minHeight: 620,
    frame: false,
    backgroundColor: '#080b18',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (saved?.maximized) mainWindow.maximize();
    mainWindow.show();
    maybeAutoCheckUpdates();
  });

  mainWindow.on('maximize', () => send('window-maximized-changed', true));
  mainWindow.on('unmaximize', () => send('window-maximized-changed', false));
  mainWindow.on('close', onWindowClose);
  mainWindow.on('closed', () => { mainWindow = null; });
}

let forceQuit = false;

function onWindowClose(e) {
  if (!forceQuit && pipeline.isRunning() && settingsModule.getSettings().confirmOnExit) {
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep running', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'PixelForge is still processing',
      message: 'A pipeline run is still in progress.',
      detail: 'Quitting now stops the run. Images already written stay on disk.',
    });
    if (choice === 1) {
      forceQuit = true;
      pipeline.cancel();
      mainWindow.close();
    }
    return;
  }
  saveBounds();
}

async function maybeAutoCheckUpdates() {
  const s = settingsModule.getSettings();
  if (!s.autoCheckUpdates) return;
  try {
    const result = await updater.checkForUpdates();
    if (result.ok && result.hasUpdate) send('update-available', result);
  } catch {}
}

app.whenReady().then(() => {
  paths.ensureDir(paths.getBinDir());
  paths.ensureDir(paths.getUpscaledDir());
  paths.ensureDir(paths.getCompressedDir());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── Window controls ──
ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => { mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize(); });
ipcMain.handle('window-close', () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// ── Setup ──
ipcMain.handle('check-setup', () => setup.checkSetup());
ipcMain.handle('download-deps', (_, opts) => setup.downloadDeps(opts, (msg) => send('download-progress', msg)));

// ── Pickers ──
ipcMain.handle('select-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('select-folders', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('select-file', async (_, filters) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: filters || [{ name: 'Executables', extensions: ['exe'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('select-images', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

// ── Scan (accepts mixed files and folders) ──
// Async on purpose: a synchronous walk over a large tree blocks the main
// process and freezes the window along with it.
ipcMain.handle('scan-inputs', async (_, inputs, recursive) => {
  const images = [];
  const perPath = {};

  const pushImage = async (full, name) => {
    try {
      const stat = await fs.promises.stat(full);
      images.push({ name, path: full, size: stat.size, ext: path.extname(name).toLowerCase() });
      return true;
    } catch { return false; }
  };

  const walk = async (dir) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (recursive) await walk(full); continue; }
      if (paths.IMAGE_RE.test(e.name)) await pushImage(full, e.name);
    }
  };

  for (const p of inputs || []) {
    let stat;
    try { stat = await fs.promises.stat(p); } catch { perPath[p] = 0; continue; }
    if (stat.isDirectory()) { const before = images.length; await walk(p); perPath[p] = images.length - before; }
    else if (paths.IMAGE_RE.test(p)) perPath[p] = (await pushImage(p, path.basename(p))) ? 1 : 0;
    else perPath[p] = 0;
  }
  return { images, count: images.length, perPath };
});

// ── Pipeline ──
ipcMain.handle('start-pipeline', async (_, { queue, inputFolder, settings }) => {
  const folders = Array.isArray(queue) && queue.length ? queue : (inputFolder ? [inputFolder] : []);
  try {
    const result = await pipeline.runPipeline({ queue: folders, settings }, (msg) => send('pipeline-progress', msg));
    if (result.success) {
      send('pipeline-done', result);
      notifyDone(result, settings);
    }
    return result;
  } catch (err) {
    send('pipeline-progress', { stage: 'error', status: 'error', message: err.message });
    return { success: false, error: err.message };
  }
});
ipcMain.handle('cancel-pipeline', () => pipeline.cancel());
ipcMain.handle('pause-pipeline', () => pipeline.pause());
ipcMain.handle('resume-pipeline', () => pipeline.resume());

function notifyDone(result, settings) {
  if (!settings?.notifyOnComplete || !Notification.isSupported()) return;
  try {
    const parts = [];
    if (result.upscaledCount) parts.push(`Upscaled ${result.upscaledCount}`);
    if (result.compressedCount) parts.push(`compressed ${result.compressedCount}`);
    const body = (parts.join(', ') || 'Run finished') +
      (result.savedPct ? ` — saved ${result.savedPct}% space` : '');
    const notification = new Notification({ title: 'PixelForge — Pipeline complete', body });
    const folder = result.compressedDir || result.upscaledDir;
    if (folder) notification.on('click', () => shell.openPath(folder));
    notification.show();
  } catch {}
}

// ── Output / shell ──
ipcMain.handle('open-folder', (_, folderPath) => shell.openPath(folderPath));
ipcMain.handle('open-file', (_, filePath) => shell.openPath(filePath));
ipcMain.handle('show-in-folder', (_, filePath) => shell.showItemInFolder(filePath));
ipcMain.handle('open-logs', () => { paths.ensureDir(paths.getLogsDir()); return shell.openPath(paths.getLogsDir()); });
ipcMain.handle('open-external', (_, url) => {
  if (!/^https:\/\//i.test(String(url))) return false;
  shell.openExternal(url);
  return true;
});

// ── Settings ──
ipcMain.handle('get-settings', () => settingsModule.getSettings());
ipcMain.handle('save-settings', (_, s) => settingsModule.saveSettings(s));
ipcMain.handle('reset-settings', () => settingsModule.resetSettings());
ipcMain.handle('get-app-paths', () => ({
  upscaled: paths.getUpscaledDir(),
  compressed: paths.getCompressedDir(),
  binDir: paths.getBinDir(),
  logs: paths.getLogsDir(),
}));
ipcMain.handle('get-app-version', () => app.getVersion());

// ── Models & GPUs ──
ipcMain.handle('list-models', () => {
  const modelsDir = paths.getModelsDir();
  return paths.listModelsFromDir(modelsDir).map(id => ({ id, name: paths.modelDisplayName(id) }));
});
ipcMain.handle('list-gpus', (_, opts) => gpu.listGpus(opts));

// ── Updates ──
ipcMain.handle('check-updates', () => updater.checkForUpdates());
ipcMain.handle('download-update', async (_, { assetUrl, assetName, checksumUrl }) => {
  try {
    const result = await updater.downloadUpdate(assetUrl, assetName, checksumUrl,
      (pct) => send('update-progress', { percent: pct }));
    return { success: true, path: result.path, verified: result.verified, sha256: result.sha256 || '' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('run-installer', async (_, installerPath) => {
  try { await shell.openPath(installerPath); setTimeout(() => app.quit(), 800); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
