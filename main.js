'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, exec } = require('child_process');
const os = require('os');

// electron-store
let Store, store;
try {
  Store = require('electron-store');
  store = new Store();
} catch {
  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  const loadCfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath,'utf8')); } catch { return {}; } };
  store = {
    get: (k, def) => { const d = loadCfg(); return d[k] !== undefined ? d[k] : def; },
    set: (k, v) => { const d = loadCfg(); d[k] = v; fs.writeFileSync(cfgPath, JSON.stringify(d,null,2)); },
  };
}

let mainWindow = null;
let activeProcess = null;
let cancelled = false;

// ─── Path Helpers ─────────────────────────────────────────────────────────────
function getBinDir()      { return path.join(app.getPath('userData'), 'bin'); }
// Bundled models: packaged → resources/models, dev → src/models
function getBundledModelsDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'models');
  return path.join(__dirname, 'src', 'models');
}
function getModelsDir() {
  const bundled = getBundledModelsDir();
  if (fs.existsSync(bundled) && fs.readdirSync(bundled).some(f => f.endsWith('.param'))) return bundled;
  return store.get('paths.models', path.join(getBinDir(), 'models'));
}
function getUpscaylBin()  { return store.get('paths.upscaylBin', path.join(getBinDir(), 'upscayl-bin.exe')); }
function getCaesiumBin()  { return store.get('paths.caesiumBin', path.join(getBinDir(), 'caesiumclt.exe')); }
function getUpscaledDir() { return store.get('paths.upscaled', path.join(app.getPath('documents'), 'PixelForge', 'upscaled')); }
function getCompressedDir(){ return store.get('paths.compressed', path.join(app.getPath('documents'), 'PixelForge', 'compressed')); }

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// ─── Detect System Upscayl Installation ──────────────────────────────────────
function detectUpscaylInstallation() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles  = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  const resourceCandidates = [
    path.join(programFiles, 'Upscayl', 'resources'),
    path.join(programFiles, 'upscayl', 'resources'),
    path.join(localAppData, 'Programs', 'upscayl', 'resources'),
    path.join(localAppData, 'Programs', 'Upscayl', 'resources'),
    path.join(programFilesX86, 'Upscayl', 'resources'),
  ];

  for (const resPath of resourceCandidates) {
    const binPath    = path.join(resPath, 'bin', 'upscayl-bin.exe');
    const modelsPath = path.join(resPath, 'models');
    if (fs.existsSync(binPath)) {
      const hasModels = fs.existsSync(modelsPath) &&
        fs.readdirSync(modelsPath).some(f => f.endsWith('.param'));
      return { found: true, binPath, modelsPath, hasModels, resPath };
    }
  }
  return { found: false };
}

// ─── Copy models into our local bin/models directory ────────────────────────
// This is crucial: upscayl-bin always resolves -m RELATIVE to its own directory.
// So the models MUST be at a simple relative path from where we run the binary.
function syncModels(srcDir) {
  const destDir = path.join(getBinDir(), 'models');
  ensureDir(destDir);
  if (!srcDir || !fs.existsSync(srcDir)) return false;
  let synced = 0;
  for (const f of fs.readdirSync(srcDir)) {
    const src  = path.join(srcDir, f);
    const dest = path.join(destDir, f);
    if (fs.statSync(src).isFile() && (f.endsWith('.param') || f.endsWith('.bin'))) {
      if (!fs.existsSync(dest) || fs.statSync(src).size !== fs.statSync(dest).size) {
        fs.copyFileSync(src, dest);
        synced++;
      }
    }
  }
  return synced >= 0;
}

// ─── List models from a directory ────────────────────────────────────────────
function listModelsFromDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.param'))
      .map(f => f.replace('.param', ''))
      .sort();
  } catch { return []; }
}

// Friendly display name for a model filename
function modelDisplayName(id) {
  const map = {
    'upscayl-standard-4x':      'Upscayl Standard 4x (Recommended)',
    'upscayl-lite-4x':          'Upscayl Lite 4x (Faster)',
    'ultrasharp-4x':            'Ultrasharp 4x',
    'remacri-4x':               'Remacri 4x',
    'ultramix-balanced-4x':     'Ultramix Balanced 4x',
    'digital-art-4x':           'Digital Art 4x',
    'high-fidelity-4x':         'High Fidelity 4x',
    'realesrgan-x4plus':        'Real-ESRGAN 4x (General)',
    'realesrgan-x4plus-anime':  'Real-ESRGAN Anime 4x',
  };
  return map[id] || id;
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120, height: 720,
    minWidth: 1080, minHeight: 600,
    frame: false,
    transparent: false,
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
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  ensureDir(getBinDir());
  ensureDir(getUpscaledDir());
  ensureDir(getCompressedDir());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── Window Controls ──────────────────────────────────────────────────────────
ipcMain.handle('window-minimize',   () => mainWindow?.minimize());
ipcMain.handle('window-maximize',   () => { mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize(); });
ipcMain.handle('window-close',      () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// ─── GPU Detection ────────────────────────────────────────────────────────────
// Use upscayl-bin.exe itself to enumerate Vulkan GPUs (the indices it uses)
// Fallback: use powershell WMI but mark with a note that IDs may not match
ipcMain.handle('list-gpus', async () => {
  // First try: use upscayl-bin --version or a quick run to see GPU list
  const binPath = getUpscaylBin();
  return new Promise((resolve) => {
    if (fs.existsSync(binPath)) {
      // Run upscayl-bin with invalid args to make it fail fast — it prints GPU info on stderr
      const proc = spawn(binPath, ['-i', '.', '-o', '.'], {
        cwd: path.dirname(binPath),
        timeout: 5000,
      });
      let output = '';
      proc.stderr.on('data', d => output += d.toString());
      proc.stdout.on('data', d => output += d.toString());
      proc.on('close', () => {
        // Parse lines like: [0 Intel(R) UHD Graphics]  or  [1 NVIDIA GeForce RTX 3050]
        const gpuRegex = /\[(\d+)\s+([^\]]+)\]/g;
        const gpus = [];
        const seen = new Set();
        let m;
        while ((m = gpuRegex.exec(output)) !== null) {
          const id = m[1];
          if (seen.has(id)) continue;
          seen.add(id);
          const name = m[2].trim();
          const isIntegrated = /intel|microsoft basic|display adapter|parsec/i.test(name);
          gpus.push({ id, name, vramMB: 0, vramLabel: '', isIntegrated });
        }
        resolve(gpus);
      });
      proc.on('error', () => resolve([]));
      setTimeout(() => { try { proc.kill(); } catch {} }, 5000);
    } else {
      // Fallback: powershell WMI (indices may not match Vulkan)
      const cmd = `powershell -NoProfile -Command "Get-WmiObject Win32_VideoController | Select-Object Name,AdapterRAM,DeviceID | ConvertTo-Json -Compress"`;
      exec(cmd, { timeout: 6000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          let data = JSON.parse(stdout.trim());
          if (!Array.isArray(data)) data = [data];
          const gpus = data
            .filter(g => g && g.Name)
            .map((g, i) => {
              const name = g.Name || `GPU ${i}`;
              const vram = g.AdapterRAM ? Math.round(g.AdapterRAM / 1024 / 1024) : 0;
              const isIntegrated = /intel|microsoft basic|display adapter|parsec/i.test(name);
              return { id: String(i), name, vramMB: vram, vramLabel: vram > 0 ? `${vram} MB` : '', isIntegrated };
            });
          resolve(gpus);
        } catch { resolve([]); }
      });
    }
  });
});

// ─── Setup Check ─────────────────────────────────────────────────────────────
ipcMain.handle('check-setup', () => {
  const detected = detectUpscaylInstallation();

  if (detected.found) {
    // Use the system binary (it carries its own DLLs)
    store.set('paths.upscaylBin', detected.binPath);
  }

  const upscaylBinOk = fs.existsSync(getUpscaylBin());
  const modelsDir    = getModelsDir(); // prefers bundled src/models
  const modelsOk     = fs.existsSync(modelsDir) && listModelsFromDir(modelsDir).length > 0;
  const caesiumOk    = fs.existsSync(getCaesiumBin());

  return {
    upscaylOk: upscaylBinOk,
    modelsOk,
    caesiumOk,
    upscaylDetected: detected.found,
    detectedBinPath: detected.binPath || '',
    detectedModelsPath: modelsDir,
    availableModels: listModelsFromDir(modelsDir),
  };
});

// ─── Download Helpers ─────────────────────────────────────────────────────────
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const followRedirect = (targetUrl) => {
      const protocol = targetUrl.startsWith('https') ? https : http;
      protocol.get(targetUrl, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode)) {
          followRedirect(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', chunk => {
          downloaded += chunk.length;
          file.write(chunk);
          if (total > 0 && onProgress) onProgress(Math.round(downloaded/total*100), downloaded, total);
        });
        res.on('end', () => { file.end(); resolve(); });
        res.on('error', err => { fs.unlink(destPath,()=>{}); reject(err); });
      }).on('error', err => { fs.unlink(destPath,()=>{}); reject(err); });
    };
    followRedirect(url);
  });
}

async function getGithubLatestRelease(owner, repo) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: `/repos/${owner}/${repo}/releases/latest`, method: 'GET', headers: { 'User-Agent': 'PixelForge' } };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Download Dependencies ────────────────────────────────────────────────────
ipcMain.handle('download-deps', async (event, { downloadUpscayl, downloadCaesium }) => {
  const send = (msg) => mainWindow?.webContents.send('download-progress', msg);
  const binDir = getBinDir();
  ensureDir(binDir);

  try {
    // ── caesiumclt ──
    if (downloadCaesium) {
      send({ stage:'caesium', status:'fetching', message:'Fetching caesium-clt release info...', percent:0 });
      let caesiumUrl;
      try {
        const rel = await getGithubLatestRelease('Lymphatus', 'caesium-clt');
        const asset = rel.assets?.find(a => /windows/i.test(a.name) && a.name.endsWith('.zip'))
                   || rel.assets?.find(a => a.name.endsWith('.zip'));
        caesiumUrl = asset?.browser_download_url;
      } catch {}
      caesiumUrl = caesiumUrl || 'https://github.com/Lymphatus/caesium-clt/releases/download/1.0.0-beta/caesiumclt-1.0.0-beta-windows.zip';

      send({ stage:'caesium', status:'downloading', message:'Downloading caesiumclt...', percent:0 });
      const zipPath = path.join(binDir, '_caesiumclt.zip');
      await downloadFile(caesiumUrl, zipPath, pct => send({ stage:'caesium', status:'downloading', message:'Downloading caesiumclt...', percent:pct }));

      send({ stage:'caesium', status:'extracting', message:'Extracting caesiumclt...', percent:100 });
      const extractZip = require('extract-zip');
      const tmpDir = path.join(binDir, '_caes_tmp');
      try { fs.rmSync(tmpDir, {recursive:true,force:true}); } catch {}
      ensureDir(tmpDir);
      await extractZip(zipPath, { dir: tmpDir });
      try { fs.unlinkSync(zipPath); } catch {}

      const findFile = (dir, name) => {
        if (!fs.existsSync(dir)) return null;
        for (const item of fs.readdirSync(dir)) {
          const full = path.join(dir, item);
          if (fs.statSync(full).isDirectory()) { const r = findFile(full,name); if(r) return r; }
          else if (item.toLowerCase() === name.toLowerCase()) return full;
        }
        return null;
      };

      const exePath = findFile(tmpDir, 'caesiumclt.exe') || findFile(tmpDir, 'caesium.exe');
      if (exePath) fs.copyFileSync(exePath, path.join(binDir, 'caesiumclt.exe'));
      try { fs.rmSync(tmpDir, {recursive:true,force:true}); } catch {}
      send({ stage:'caesium', status:'done', message:'Caesium CLT ready.', percent:100 });
    }

    // ── upscayl-bin — download binary only (models are bundled with the installer) ──
    if (downloadUpscayl) {
      send({ stage:'upscayl', status:'fetching', message:'Fetching upscayl-bin release info...', percent:0 });
      let upscaylBinUrl;
      try {
        const rel = await getGithubLatestRelease('upscayl', 'upscayl-ncnn');
        const asset = rel.assets?.find(a => /windows/i.test(a.name) && a.name.endsWith('.zip'));
        upscaylBinUrl = asset?.browser_download_url;
      } catch {}
      upscaylBinUrl = upscaylBinUrl || 'https://github.com/upscayl/upscayl-ncnn/releases/download/20251207-174704/upscayl-bin-20251207-174704-windows.zip';

      send({ stage:'upscayl', status:'downloading', message:'Downloading upscayl engine...', percent:0 });
      const binZipPath = path.join(binDir, '_upscayl_bin.zip');
      await downloadFile(upscaylBinUrl, binZipPath, pct =>
        send({ stage:'upscayl', status:'downloading', message:`Downloading engine... ${pct}%`, percent: pct })
      );

      send({ stage:'upscayl', status:'extracting', message:'Extracting binary...', percent:98 });
      const extractZip = require('extract-zip');
      const binTmpDir = path.join(binDir, '_up_tmp');
      try { fs.rmSync(binTmpDir, {recursive:true,force:true}); } catch {}
      ensureDir(binTmpDir);
      await extractZip(binZipPath, { dir: binTmpDir });
      try { fs.unlinkSync(binZipPath); } catch {}

      const findFile = (dir, name) => {
        if (!fs.existsSync(dir)) return null;
        for (const item of fs.readdirSync(dir)) {
          const full = path.join(dir, item);
          if (fs.statSync(full).isDirectory()) { const r = findFile(full, name); if (r) return r; }
          else if (item.toLowerCase() === name.toLowerCase()) return full;
        }
        return null;
      };

      const binExe = findFile(binTmpDir, 'upscayl-bin.exe');
      if (binExe) {
        const srcDir = path.dirname(binExe);
        for (const f of fs.readdirSync(srcDir)) {
          const src = path.join(srcDir, f);
          if (!fs.statSync(src).isDirectory()) {
            try { fs.copyFileSync(src, path.join(binDir, f)); } catch {}
          }
        }
      }
      try { fs.rmSync(binTmpDir, {recursive:true,force:true}); } catch {}
      store.set('paths.upscaylBin', path.join(binDir, 'upscayl-bin.exe'));
      send({ stage:'upscayl', status:'done', message:'Upscayl engine ready. AI models are bundled.', percent:100 });
    }

    send({ stage:'complete', status:'done', message:'All dependencies installed.' });
    return { success: true };
  } catch (err) {
    send({ stage:'error', status:'error', message: err.message });
    return { success: false, error: err.message };
  }
});

// ─── Folder Picker ────────────────────────────────────────────────────────────
ipcMain.handle('select-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('select-file', async (_, filters) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: filters || [{ name: 'Executables', extensions: ['exe'] }] });
  return r.canceled ? null : r.filePaths[0];
});

// ─── Image Scan ───────────────────────────────────────────────────────────────
ipcMain.handle('scan-images', async (_, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return { error: 'Not found', images: [] };
  const exts = ['.jpg','.jpeg','.png','.webp','.bmp','.tiff','.tif'];
  const images = [];
  try {
    for (const file of fs.readdirSync(folderPath)) {
      const full = path.join(folderPath, file);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && exts.includes(path.extname(file).toLowerCase())) {
          images.push({ name: file, path: full, size: stat.size, ext: path.extname(file).toLowerCase() });
        }
      } catch {}
    }
  } catch {}
  return { images, count: images.length };
});

// ─── Pipeline ─────────────────────────────────────────────────────────────────
ipcMain.handle('start-pipeline', async (_, { inputFolder, settings }) => {
  cancelled = false;
  const send = (msg) => mainWindow?.webContents.send('pipeline-progress', msg);

  const upscaledDir   = getUpscaledDir();
  const compressedDir = getCompressedDir();
  ensureDir(upscaledDir);
  ensureDir(compressedDir);

  // Clear previous output
  for (const dir of [upscaledDir, compressedDir]) {
    try { for (const f of fs.readdirSync(dir)) try { fs.unlinkSync(path.join(dir,f)); } catch {} } catch {}
  }

  const upscaylBin = getUpscaylBin();
  const caesiumBin = getCaesiumBin();
  const model      = settings.upscaylModel || 'upscayl-standard-4x';
  const scale      = String(settings.upscaylScale || '4');
  const format     = settings.upscaylFormat || 'png';

  // Models: always use bundled/detected absolute path — no relative path guessing
  const modelsDir = getModelsDir();
  const spawnCwd  = path.dirname(upscaylBin); // binary dir for DLL loading

  // GPU: use the Vulkan GPU index directly
  const gpuId = settings.upscaylGpu !== undefined && settings.upscaylGpu !== '' && settings.upscaylGpu !== 'auto'
    ? String(settings.upscaylGpu)
    : null;

  // ── Build image list for one-by-one processing ──
  const imgExts = /\.(jpg|jpeg|png|webp|bmp|tiff|tif)$/i;
  const imageFiles = fs.existsSync(inputFolder)
    ? fs.readdirSync(inputFolder).filter(f => imgExts.test(f))
    : [];
  const totalImages = imageFiles.length;

  if (totalImages === 0) {
    send({ stage:'upscaling', status:'done', message:'No images found in input folder.', percent:100 });
    return { success: false, error: 'No images found.' };
  }

  if (!fs.existsSync(upscaylBin)) {
    throw new Error('upscayl-bin.exe not found. Please run setup.');
  }

  // upscayl-bin ONLY accepts a FOLDER for -i (not a single file path).
  // We use a single reusable temp folder: drop one image in, run, clear, repeat.
  const tmpInputDir = path.join(getBinDir(), '_tmp_input');
  ensureDir(tmpInputDir);
  // Clear any stale files from a previous run
  try { for (const f of fs.readdirSync(tmpInputDir)) fs.unlinkSync(path.join(tmpInputDir, f)); } catch {}

  send({ stage:'upscaling', status:'starting', message:`Ready — ${totalImages} image${totalImages !== 1 ? 's' : ''} to process`, percent:0, current:0, total:totalImages });

  // ── Stage 1: Process one image at a time via temp folder ──
  let completedCount = 0;
  try {
    for (const imgFile of imageFiles) {
      if (cancelled) break;

      // Put just this one image into the temp input folder
      const srcPath  = path.join(inputFolder, imgFile);
      const tmpPath  = path.join(tmpInputDir, imgFile);
      try {
        // Hard-link = instant, no data copy (works when src & tmp are same drive)
        fs.linkSync(srcPath, tmpPath);
      } catch {
        // Fallback: full copy (cross-drive, or if hard links not supported)
        fs.copyFileSync(srcPath, tmpPath);
      }

      send({
        stage: 'upscaling', status: 'running',
        message: `Upscaling ${completedCount + 1} of ${totalImages}: ${imgFile}`,
        percent: Math.round(completedCount / totalImages * 100),
        current: completedCount, total: totalImages,
      });

      const imgArgs = [
        '-i', tmpInputDir,
        '-o', upscaledDir,
        '-s', scale, '-m', modelsDir, '-n', model, '-f', format,
      ];
      if (gpuId !== null) imgArgs.push('-g', gpuId);
      if (settings.upscaylTileSize && String(settings.upscaylTileSize) !== '0') imgArgs.push('-t', String(settings.upscaylTileSize));
      if (settings.upscaylTta) imgArgs.push('-x');

      await new Promise((resolve, reject) => {
        const proc = spawn(upscaylBin, imgArgs, { cwd: spawnCwd });
        activeProcess = proc;
        proc.stdout.resume();
        proc.stderr.resume();
        proc.on('close', code => {
          activeProcess = null;
          // Remove the temp file for this image before next iteration
          try { fs.unlinkSync(tmpPath); } catch {}
          if (cancelled) { resolve(); return; }
          if (code === 0) resolve();
          else reject(new Error(`upscayl-bin exited with code ${code} on: ${imgFile}`));
        });
        proc.on('error', err => {
          activeProcess = null;
          try { fs.unlinkSync(tmpPath); } catch {}
          reject(err);
        });
      });

      if (!cancelled) {
        completedCount++;
        const pct = Math.round(completedCount / totalImages * 100);
        send({
          stage: 'upscaling',
          status: completedCount === totalImages ? 'done' : 'running',
          message: completedCount === totalImages
            ? `Upscaling complete — all ${totalImages} images done`
            : `Upscaled ${completedCount} of ${totalImages} images`,
          percent: pct, current: completedCount, total: totalImages,
        });
      }
    }
  } finally {
    // Always clean up the temp folder
    try { fs.rmSync(tmpInputDir, { recursive: true, force: true }); } catch {}
  }

  if (cancelled) { send({ stage:'cancelled', status:'cancelled', message:'Pipeline cancelled by user.' }); return { success:false, cancelled:true }; }

  const upscaledFiles = fs.readdirSync(upscaledDir).filter(f => /\.(jpg|jpeg|png|webp|bmp|tiff)$/i.test(f));

  // ── Stage 2: Compression ──
  send({ stage:'compressing', status:'starting', message:'Starting compression batch...', percent:0 });

  const quality = String(settings.caesiumQuality !== undefined ? settings.caesiumQuality : 82);
  const caesiumArgs = ['-R', '-q', quality, '-o', compressedDir];
  if (settings.caesiumLossless) caesiumArgs.push('--lossless');
  if (settings.caesiumKeepMeta) caesiumArgs.push('-e');
  if (settings.caesiumFormat && settings.caesiumFormat !== 'same') caesiumArgs.push('--format', settings.caesiumFormat);
  caesiumArgs.push(upscaledDir);

  await new Promise((resolve, reject) => {
    if (!fs.existsSync(caesiumBin)) { reject(new Error('caesiumclt.exe not found. Please run setup.')); return; }
    activeProcess = spawn(caesiumBin, caesiumArgs);
    let processed = 0;
    const total = upscaledFiles.length || 1;
    const onData = (d) => {
      const str = d.toString();
      if (/\.(jpg|jpeg|png|webp)/i.test(str)) {
        processed++;
        const pct = Math.min(99, Math.round(processed/total*100));
        send({ stage:'compressing', status:'running', message:`Compressing ${processed}/${total}...`, percent:pct, current:processed, total });
      }
    };
    activeProcess.stdout.on('data', onData);
    activeProcess.stderr.on('data', onData);
    activeProcess.on('close', () => {
      activeProcess = null;
      if (cancelled) { resolve({ cancelled: true }); return; }
      resolve({ cancelled: false });
    });
    activeProcess.on('error', err => { activeProcess = null; reject(err); });
  });

  if (cancelled) { send({ stage:'cancelled', status:'cancelled', message:'Pipeline cancelled by user.' }); return { success:false, cancelled:true }; }

  // Calculate space saved
  let upscaledSize = 0, compressedSize = 0;
  try { for (const f of fs.readdirSync(upscaledDir)) { try { upscaledSize += fs.statSync(path.join(upscaledDir,f)).size; } catch {} } } catch {}
  try { for (const f of fs.readdirSync(compressedDir)) { try { compressedSize += fs.statSync(path.join(compressedDir,f)).size; } catch {} } } catch {}
  const savedPct = upscaledSize > 0 ? Math.round((upscaledSize-compressedSize)/upscaledSize*100) : 0;
  const compressedFiles = fs.readdirSync(compressedDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

  send({ stage:'complete', status:'done', message:'Pipeline complete!', percent:100, upscaledCount:upscaledFiles.length, compressedCount:compressedFiles.length, savedPct });
  mainWindow?.webContents.send('pipeline-done', { upscaledCount:upscaledFiles.length, compressedCount:compressedFiles.length, savedPct });
  return { success:true };
});

ipcMain.handle('cancel-pipeline', () => {
  cancelled = true;
  if (activeProcess) {
    try { exec(`taskkill /PID ${activeProcess.pid} /T /F`); } catch {}
    activeProcess = null;
  }
});

// ─── Open Folder ──────────────────────────────────────────────────────────────
ipcMain.handle('open-folder', (_, folderPath) => shell.openPath(folderPath));

// ─── Settings ─────────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => ({
  upscaylModel:    store.get('upscayl.model',    'upscayl-standard-4x'),
  upscaylScale:    store.get('upscayl.scale',    '4'),
  upscaylFormat:   store.get('upscayl.format',   'png'),
  upscaylGpu:      store.get('upscayl.gpu',      'auto'),
  upscaylTileSize: store.get('upscayl.tileSize', '0'),
  upscaylTta:      store.get('upscayl.tta',      false),
  caesiumQuality:  store.get('caesium.quality',  82),
  caesiumFormat:   store.get('caesium.format',   'same'),
  caesiumLossless: store.get('caesium.lossless', false),
  caesiumKeepMeta: store.get('caesium.keepMeta', false),
  modelsPath:      store.get('paths.models',     path.join(getBinDir(),'models')),
  upscaylBinPath:  store.get('paths.upscaylBin', path.join(getBinDir(),'upscayl-bin.exe')),
  caesiumBinPath:  store.get('paths.caesiumBin', path.join(getBinDir(),'caesiumclt.exe')),
  upscaledPath:    store.get('paths.upscaled',   path.join(app.getPath('documents'),'PixelForge','upscaled')),
  compressedPath:  store.get('paths.compressed', path.join(app.getPath('documents'),'PixelForge','compressed')),
  savedInputFolder:store.get('app.inputFolder',  ''),
  accentColor:     store.get('app.accentColor',  '#6366f1'),
  setupDone:       store.get('app.setupDone',    false),
}));

ipcMain.handle('save-settings', (_, s) => {
  const k = {
    'upscayl.model':   'upscaylModel',    'upscayl.scale':   'upscaylScale',
    'upscayl.format':  'upscaylFormat',   'upscayl.gpu':     'upscaylGpu',
    'upscayl.tileSize':'upscaylTileSize', 'upscayl.tta':     'upscaylTta',
    'caesium.quality': 'caesiumQuality',  'caesium.format':  'caesiumFormat',
    'caesium.lossless':'caesiumLossless', 'caesium.keepMeta':'caesiumKeepMeta',
    'paths.models':    'modelsPath',      'paths.upscaylBin':'upscaylBinPath',
    'paths.caesiumBin':'caesiumBinPath',  'paths.upscaled':  'upscaledPath',
    'paths.compressed':'compressedPath',  'app.inputFolder': 'savedInputFolder',
    'app.accentColor': 'accentColor',     'app.setupDone':   'setupDone',
  };
  for (const [storeKey, settingKey] of Object.entries(k)) {
    if (s[settingKey] !== undefined) store.set(storeKey, s[settingKey]);
  }
  return { ok: true };
});

ipcMain.handle('get-app-paths', () => ({
  upscaled:   getUpscaledDir(),
  compressed: getCompressedDir(),
  binDir:     getBinDir(),
}));

// ─── Dynamic Model List ────────────────────────────────────────────────────────
ipcMain.handle('list-models', () => {
  // Prefer local bin/models if populated, fallback to stored models path
  const localModels = path.join(getBinDir(), 'models');
  const modelsDir = (fs.existsSync(localModels) && listModelsFromDir(localModels).length > 0)
    ? localModels
    : getModelsDir();
  const ids = listModelsFromDir(modelsDir);
  return ids.map(id => ({ id, name: modelDisplayName(id) }));
});
