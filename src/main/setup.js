'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const extractZip = require('extract-zip');
const paths = require('./paths');
const store = require('./store');
const { downloadFile, findFileRecursive, isValidZip, verifyChecksum } = require('./download');

// Pinned to specific, verified releases so setup never depends on the GitHub API
// (rate limits) and the upscayl/caesium CLI contract stays stable.
const CAESIUM_URL = 'https://github.com/Lymphatus/caesium-clt/releases/download/v1.3.0/caesiumclt-v1.3.0-x86_64-pc-windows-msvc.zip';
const CAESIUM_SHA = '760bab6effbd0e9aaabfb3275ce327b258103648b8ca0c455fcd2546d656c436';
const UPSCAYL_URL = 'https://github.com/upscayl/upscayl-ncnn/releases/download/20251207-174704/upscayl-bin-20251207-174704-windows.zip';
const UPSCAYL_SHA = '1f0f65c5d2ade866555e2ac467d35952c35a47080a4060fe56a1ab028f67258a';

function detectUpscaylInstallation() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  const resourceCandidates = [
    path.join(programFiles, 'Upscayl', 'resources'),
    path.join(programFiles, 'upscayl', 'resources'),
    path.join(localAppData, 'Programs', 'upscayl', 'resources'),
    path.join(localAppData, 'Programs', 'Upscayl', 'resources'),
    path.join(programFilesX86, 'Upscayl', 'resources'),
  ];

  for (const resPath of resourceCandidates) {
    const binPath = path.join(resPath, 'bin', 'upscayl-bin.exe');
    const modelsPath = path.join(resPath, 'models');
    if (fs.existsSync(binPath)) {
      const hasModels = fs.existsSync(modelsPath) &&
        fs.readdirSync(modelsPath).some(f => f.endsWith('.param'));
      return { found: true, binPath, modelsPath, hasModels, resPath };
    }
  }
  return { found: false };
}

function checkSetup() {
  const detected = detectUpscaylInstallation();
  if (detected.found) store.set('paths.upscaylBin', detected.binPath);

  const upscaylBinOk = fs.existsSync(paths.getUpscaylBin());
  const modelsDir = paths.getModelsDir();
  const modelsOk = fs.existsSync(modelsDir) && paths.listModelsFromDir(modelsDir).length > 0;
  const caesiumOk = fs.existsSync(paths.getCaesiumBin());

  return {
    upscaylOk: upscaylBinOk,
    modelsOk,
    caesiumOk,
    upscaylDetected: detected.found,
    detectedBinPath: detected.binPath || '',
    detectedModelsPath: modelsDir,
    availableModels: paths.listModelsFromDir(modelsDir),
  };
}

async function extractAndPlace(zipPath, exeName, placeAllSiblings, binDir, sha256) {
  if (!isValidZip(zipPath)) throw new Error('Downloaded archive is invalid or incomplete.');
  if (!(await verifyChecksum(zipPath, sha256))) throw new Error('Checksum verification failed.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-extract-'));
  try {
    await extractZip(zipPath, { dir: tmpDir });
    try { fs.unlinkSync(zipPath); } catch {}

    const exePath = findFileRecursive(tmpDir, exeName);
    if (!exePath) throw new Error(`${exeName} not found in archive.`);

    if (placeAllSiblings) {
      const srcDir = path.dirname(exePath);
      for (const f of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, f);
        if (!fs.statSync(src).isDirectory()) {
          try { fs.copyFileSync(src, path.join(binDir, f)); } catch {}
        }
      }
    } else {
      fs.copyFileSync(exePath, path.join(binDir, exeName));
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function downloadDeps({ downloadUpscayl, downloadCaesium }, send) {
  const binDir = paths.getBinDir();
  paths.ensureDir(binDir);

  try {
    if (downloadCaesium) {
      send({ stage: 'caesium', status: 'downloading', message: 'Downloading caesiumclt...', percent: 0 });
      const zipPath = path.join(binDir, '_caesiumclt.zip');
      await downloadFile(CAESIUM_URL, zipPath, pct => send({ stage: 'caesium', status: 'downloading', message: 'Downloading caesiumclt...', percent: pct }));
      send({ stage: 'caesium', status: 'extracting', message: 'Verifying and extracting caesiumclt...', percent: 100 });
      await extractAndPlace(zipPath, 'caesiumclt.exe', false, binDir, CAESIUM_SHA);
      store.set('paths.caesiumBin', path.join(binDir, 'caesiumclt.exe'));
      send({ stage: 'caesium', status: 'done', message: 'Caesium CLT ready.', percent: 100 });
    }

    if (downloadUpscayl) {
      send({ stage: 'upscayl', status: 'downloading', message: 'Downloading upscayl engine...', percent: 0 });
      const zipPath = path.join(binDir, '_upscayl_bin.zip');
      await downloadFile(UPSCAYL_URL, zipPath, pct => send({ stage: 'upscayl', status: 'downloading', message: `Downloading engine... ${pct}%`, percent: pct }));
      send({ stage: 'upscayl', status: 'extracting', message: 'Verifying and extracting binary...', percent: 98 });
      await extractAndPlace(zipPath, 'upscayl-bin.exe', true, binDir, UPSCAYL_SHA);
      store.set('paths.upscaylBin', path.join(binDir, 'upscayl-bin.exe'));
      send({ stage: 'upscayl', status: 'done', message: 'Upscayl engine ready. AI models are bundled.', percent: 100 });
    }

    send({ stage: 'complete', status: 'done', message: 'All dependencies installed.' });
    return { success: true };
  } catch (err) {
    send({ stage: 'error', status: 'error', message: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { detectUpscaylInstallation, checkSetup, downloadDeps };
