'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, screen } = require('electron');
const path = require('path');

const store = require('./src/main/store');
const paths = require('./src/main/paths');
const settingsModule = require('./src/main/settings');
const setup = require('./src/main/setup');
const gpu = require('./src/main/gpu');
const updater = require('./src/main/updater');
const pipeline = require('./src/main/pipeline');
const { collectInputs } = require('./src/main/scan');

// One window, one pipeline. A second instance would share the same settings
// and output folders, and two Replace-mode runs would clean up each other's work.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

let mainWindow = null;

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

const MIN_VISIBLE = 120;

// Saved bounds from a monitor that has since been unplugged would put the
// window somewhere no display covers — to the user, the app just never opens.
function getSavedBounds() {
  const b = store.get('app.windowBounds', null);
  if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return null;
  if (typeof b.x !== 'number' || typeof b.y !== 'number') return { width: b.width, height: b.height, maximized: !!b.maximized };

  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= MIN_VISIBLE &&
    Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= MIN_VISIBLE / 2);
  if (onScreen) return b;

  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: Math.min(b.width, area.width),
    height: Math.min(b.height, area.height),
    maximized: !!b.maximized,
  };
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
    // Matches the page background so there's no flash before first paint.
    backgroundColor: store.get('app.theme', 'dark') === 'light' ? '#f4f5fa' : '#0a0a12',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  // The window only ever shows the bundled UI. A file dropped outside the drop
  // zone would otherwise navigate away and replace the whole app with an image.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!hasInstanceLock) return;
  // Nothing here may stop the window from appearing. An output folder on an
  // unplugged drive is reported when a run starts, not by refusing to open.
  paths.tryEnsureDir(paths.getBinDir());
  paths.tryEnsureDir(paths.getUpscaledDir());
  paths.tryEnsureDir(paths.getCompressedDir());
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
// Same walker and exclusions as the pipeline, so the count shown is the count run.
ipcMain.handle('scan-inputs', async (_, inputs, recursive) => {
  const entries = await collectInputs(inputs, {
    recursive: !!recursive,
    excludeDirs: [paths.getUpscaledDir(), paths.getCompressedDir()],
    withSize: true,
  });
  const images = [];
  const perPath = {};
  const missing = [];
  for (const entry of entries) {
    perPath[entry.input] = entry.files.length;
    if (entry.missing) missing.push(entry.input);
    for (const f of entry.files) {
      images.push({ name: path.basename(f.abs), path: f.abs, size: f.size, ext: path.extname(f.abs).toLowerCase() });
    }
  }
  return { images, count: images.length, perPath, missing };
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
  // Only ever launch the installer this session downloaded into Downloads.
  if (!/PixelForge-Setup.*\.exe$/i.test(String(installerPath)) ||
      !paths.isStrictlyInside(installerPath, app.getPath('downloads'))) {
    return { ok: false, error: 'That installer path is not one PixelForge downloaded.' };
  }
  // openPath reports failure through its return value, not by throwing — quit
  // only once the installer has actually launched.
  const error = await shell.openPath(installerPath);
  if (error) return { ok: false, error };
  setTimeout(() => app.quit(), 800);
  return { ok: true };
});
