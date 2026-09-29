'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, screen, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./src/main/store');
const paths = require('./src/main/paths');
const settingsModule = require('./src/main/settings');
const setup = require('./src/main/setup');
const gpu = require('./src/main/gpu');
const updater = require('./src/main/updater');
const pipeline = require('./src/main/pipeline');
const { collectInputs } = require('./src/main/scan');
const guard = require('./src/main/guard');
const { sha256File } = require('./src/main/download');
const { spawn } = require('child_process');

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

  // Show the frame straight away, filled with the theme's background, rather
  // than waiting for the first paint. On a cold start (first launch after an
  // install) that wait is seconds of nothing, which reads as "it won't open".
  if (saved?.maximized) mainWindow.maximize();
  mainWindow.show();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', maybeAutoCheckUpdates);
  mainWindow.webContents.once('did-finish-load', () => {
    const outcome = takePendingUpdateOutcome();
    if (outcome) send('update-result', outcome);
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

// Reported once, on the first launch after a one-click update.
function takePendingUpdateOutcome() {
  const pending = store.get('app.pendingUpdate', null);
  if (!pending) return null;
  store.delete('app.pendingUpdate');
  return updater.pendingUpdateOutcome(pending, app.getVersion());
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

// Upscaling dominates run time, so it gets most of the taskbar bar; an even
// split would leap to 50% the moment upscaling ended.
const STAGE_WEIGHTS = {
  both: { upscaling: [0, 0.85], compressing: [0.85, 0.15] },
  upscale: { upscaling: [0, 1] },
  compress: { compressing: [0, 1] },
};

function runFraction(mode, msg) {
  if (msg.stage === 'complete') return 1;
  const span = (STAGE_WEIGHTS[mode] || STAGE_WEIGHTS.both)[msg.stage];
  return span ? span[0] + span[1] * Math.min(1, (msg.percent || 0) / 100) : null;
}

let lastFraction = 0;

function setTaskbarProgress(fraction, mode = 'normal') {
  if (fraction >= 0 && fraction <= 1) lastFraction = fraction;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setProgressBar(fraction, { mode });
}

ipcMain.handle('start-pipeline', async (_, { queue, inputFolder, settings }) => {
  const folders = Array.isArray(queue) && queue.length ? queue : (inputFolder ? [inputFolder] : []);
  const mode = settings?.pipelineMode || 'both';
  // Long batches shouldn't stop because the PC went to sleep.
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  lastFraction = 0;
  setTaskbarProgress(2, 'indeterminate');
  try {
    const result = await pipeline.runPipeline({ queue: folders, settings }, (msg) => {
      send('pipeline-progress', msg);
      const fraction = runFraction(mode, msg);
      if (fraction !== null) setTaskbarProgress(fraction, pipeline.isPaused() ? 'paused' : 'normal');
    });
    if (result.success) {
      send('pipeline-done', result);
      notifyDone(result, settings);
      if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
    }
    setTaskbarProgress(-1);
    return result;
  } catch (err) {
    send('pipeline-progress', { stage: 'error', status: 'error', message: err.message });
    setTaskbarProgress(1, 'error');
    setTimeout(() => { if (!pipeline.isRunning()) setTaskbarProgress(-1); }, 4000);
    return { success: false, error: err.message };
  } finally {
    powerSaveBlocker.stop(blocker);
  }
});
ipcMain.handle('cancel-pipeline', () => pipeline.cancel());
ipcMain.handle('pause-pipeline', () => { pipeline.pause(); if (pipeline.isRunning()) setTaskbarProgress(lastFraction, 'paused'); });
ipcMain.handle('resume-pipeline', () => { pipeline.resume(); if (pipeline.isRunning()) setTaskbarProgress(lastFraction, 'normal'); });

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
// Everything the window can ask the OS to open passes through src/main/guard.js:
// folders only as folders, files only if they're images or logs, and links only
// to PixelForge's own site and repository.
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

ipcMain.handle('open-folder', (_, folderPath) => {
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath) || !isDir(folderPath)) return 'Not a folder.';
  return shell.openPath(folderPath);
});
ipcMain.handle('open-file', (_, filePath) => {
  if (!guard.isOpenableFile(filePath) || !isFile(filePath)) return 'That file can’t be opened from PixelForge.';
  return shell.openPath(filePath);
});
ipcMain.handle('show-in-folder', (_, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) return false;
  shell.showItemInFolder(filePath);
  return true;
});
ipcMain.handle('open-logs', () => { paths.ensureDir(paths.getLogsDir()); return shell.openPath(paths.getLogsDir()); });
ipcMain.handle('open-external', (_, url) => {
  if (!guard.isAllowedExternalUrl(url)) return false;
  shell.openExternal(url);
  return true;
});

// ── Settings ──

// Checks a path the user typed or picked before it's saved, so a bad value is
// caught in Settings rather than failing a run later. Blank means "default".
ipcMain.handle('validate-path', async (_, { kind, value, other } = {}) => {
  const v = String(value || '').trim();
  if (!v) return { ok: true };
  if (!path.isAbsolute(v)) return { ok: false, message: 'Use a full path, such as C:\\Users\\You\\Pictures.' };

  let stat = null;
  try { stat = await fs.promises.stat(v); } catch {}

  if (kind === 'exe') {
    if (!stat) return { ok: false, message: "That file doesn't exist." };
    if (!stat.isFile() || !/\.exe$/i.test(v)) return { ok: false, message: 'Choose the .exe file itself, not a folder.' };
    return { ok: true };
  }
  if (kind === 'models') {
    if (!stat || !stat.isDirectory()) return { ok: false, message: "That folder doesn't exist." };
    if (!paths.listModelsFromDir(v).length) return { ok: false, message: 'No AI models here — the folder needs .param and .bin files.' };
    return { ok: true };
  }
  // Output folder
  if (other && (paths.isSameOrInside(v, other) || paths.isSameOrInside(other, v))) {
    return { ok: false, message: 'The upscaled and compressed folders must be separate.' };
  }
  if (stat && !stat.isDirectory()) return { ok: false, message: 'That path is a file, not a folder.' };
  if (!stat) {
    try {
      if ((await fs.promises.stat(path.dirname(v))).isDirectory()) return { ok: true, message: 'This folder will be created on the next run.' };
    } catch {}
    return { ok: false, message: "This folder doesn't exist, and neither does the folder it would go in." };
  }
  try { await fs.promises.access(v, fs.constants.W_OK); } catch {
    return { ok: false, message: "PixelForge can't write to this folder." };
  }
  return { ok: true };
});

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
// Installers this session downloaded and verified: path → digest. Only these
// can be installed with one click, and each is hashed again first — it has sat
// in Downloads, where anything could have replaced it since.
const verifiedInstallers = new Map();

async function verificationProblem(installerPath) {
  const expected = verifiedInstallers.get(installerPath);
  if (!expected) return 'That installer wasn’t downloaded and verified by PixelForge in this session.';
  try { if ((await sha256File(installerPath)) === expected) return null; } catch {}
  verifiedInstallers.delete(installerPath);
  try { fs.rmSync(installerPath, { force: true }); } catch {}
  return 'The downloaded installer changed after it was verified, so it wasn’t run. Download the update again.';
}

ipcMain.handle('download-update', async (_, { assetUrl, assetName, checksumUrl }) => {
  try {
    const result = await updater.downloadUpdate(assetUrl, assetName, checksumUrl,
      (pct) => send('update-progress', { percent: pct }));
    verifiedInstallers.set(result.path, result.sha256);
    return { success: true, path: result.path, sha256: result.sha256 };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// One click: the installer runs silently over this copy and starts PixelForge
// again when it's done. The app closes itself so no file is left in use.
ipcMain.handle('install-update', async (_, { installerPath, version } = {}) => {
  if (pipeline.isRunning()) return { ok: false, error: 'Finish or cancel the current run first — updating closes PixelForge.' };
  const problem = await verificationProblem(installerPath);
  if (problem) return { ok: false, error: problem };
  try {
    const child = spawn(installerPath, updater.SILENT_UPDATE_ARGS, { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } catch (err) {
    return { ok: false, error: `Couldn't start the installer: ${err.message}` };
  }
  // Checked on the next launch, so an update that didn't take is reported
  // instead of the app quietly carrying on as the old version.
  store.set('app.pendingUpdate', { from: app.getVersion(), to: String(version || ''), installer: installerPath, at: Date.now() });
  forceQuit = true;
  setTimeout(() => app.quit(), 600); // long enough that the screen is never blank
  return { ok: true };
});

// The full setup wizard — the fallback when one-click updating didn't finish.
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
