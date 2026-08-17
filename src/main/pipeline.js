'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const paths = require('./paths');
const gpu = require('./gpu');
const { IMAGE_RE } = paths;

const POLL_MS = 400;
const COMPRESS_CHUNK = 60;

const state = {
  running: false,
  cancelled: false,
  paused: false,
  activeProcess: null,
  logStream: null,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isRunning() { return state.running; }
function isPaused() { return state.paused; }

function killActive() {
  if (state.activeProcess) {
    try { exec(`taskkill /PID ${state.activeProcess.pid} /T /F`); } catch {}
    state.activeProcess = null;
  }
}

function cancel() { state.cancelled = true; state.paused = false; killActive(); }
function pause() { if (state.running) state.paused = true; }
function resume() { state.paused = false; }

async function waitWhilePaused() {
  while (state.paused && !state.cancelled) await sleep(200);
}

function openLog() {
  try {
    paths.ensureDir(paths.getLogsDir());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(paths.getLogsDir(), `run-${stamp}.log`);
    state.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    state.logPath = logPath;
  } catch { state.logStream = null; }
}

function writeLog(text) {
  if (!state.logStream) return;
  const ts = new Date().toISOString();
  try { state.logStream.write(`[${ts}] ${text}\n`); } catch {}
}

function closeLog() {
  if (state.logStream) { try { state.logStream.end(); } catch {} state.logStream = null; }
}

function clearDir(dir) {
  paths.ensureDir(dir);
  try {
    for (const entry of fs.readdirSync(dir)) {
      try { fs.rmSync(path.join(dir, entry), { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

// run-2026-08-17_14-32-05 — sortable and filename-safe.
function runStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `run-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
         `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

function placeFile(src, dest) {
  try { fs.linkSync(src, dest); }
  catch { fs.copyFileSync(src, dest); }
}

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').trim() || 'image';
}

function applyTemplate(tpl, tokens) {
  const out = tpl
    .replace(/\{name\}/g, tokens.name)
    .replace(/\{model\}/g, tokens.model)
    .replace(/\{scale\}/g, tokens.scale)
    .replace(/\{index\}/g, String(tokens.index));
  return sanitizeName(out);
}

function walkImages(root, recursive) {
  const out = [];
  const walk = (dir, relBase) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (e.isDirectory()) { if (recursive) walk(abs, rel); }
      else if (IMAGE_RE.test(e.name)) out.push({ abs, rel });
    }
  };
  walk(root, '');
  return out;
}

function countImages(dir) {
  try { return fs.readdirSync(dir).filter(f => IMAGE_RE.test(f)).length; }
  catch { return 0; }
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

function makeReporter(send, startTime, total) {
  return (base, completed) => {
    const elapsedMs = Date.now() - startTime;
    const sec = elapsedMs / 1000;
    const throughput = completed > 0 && sec > 0 ? completed / sec : 0;
    const etaMs = throughput > 0 ? (total - completed) / throughput * 1000 : 0;
    const percent = total > 0 ? Math.min(100, Math.round(completed / total * 100)) : 0;
    const payload = { ...base, current: completed, total, percent, elapsedMs, etaMs, throughput };
    if (base.message) writeLog(base.message);
    send(payload);
  };
}

function runWithPolling(bin, args, cwd, watchDir, onPoll) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd });
    state.activeProcess = proc;
    proc.stdout.resume();
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const poll = setInterval(() => { try { onPoll(); } catch {} }, POLL_MS);

    proc.on('close', (code) => {
      clearInterval(poll);
      state.activeProcess = null;
      if (state.cancelled) { resolve({ cancelled: true }); return; }
      if (code === 0) resolve({ cancelled: false });
      else reject(new Error(`${path.basename(bin)} exited with code ${code}. ${stderr.trim().slice(-240)}`));
    });
    proc.on('error', (err) => {
      clearInterval(poll);
      state.activeProcess = null;
      reject(err);
    });
  });
}

async function runPipeline(args, send) {
  if (state.running) return { success: false, error: 'A run is already in progress.' };
  state.running = true;
  state.cancelled = false;
  state.paused = false;
  openLog();
  try {
    return await runPipelineInner(args, send);
  } finally {
    closeLog();
    state.running = false;
  }
}

async function runPipelineInner({ queue, settings }, send) {
  const startTime = Date.now();
  const mode = settings.pipelineMode || 'both';
  const doUpscale = mode === 'both' || mode === 'upscale';
  const doCompress = mode === 'both' || mode === 'compress';
  const recursive = !!settings.recursive;

  const upscaylBin = paths.getUpscaylBin();
  const caesiumBin = paths.getCaesiumBin();
  const modelsDir = paths.getModelsDir();
  const tmpInputDir = paths.getTempInputDir();

  // 'keep' writes each run into its own timestamped subfolder so earlier
  // results survive; 'replace' reuses the root and wipes it first.
  const keepRuns = settings.outputMode === 'keep';
  const stamp = keepRuns ? runStamp() : '';
  const upscaledRoot = keepRuns ? path.join(paths.getUpscaledDir(), stamp) : paths.getUpscaledDir();
  const compressedRoot = keepRuns ? path.join(paths.getCompressedDir(), stamp) : paths.getCompressedDir();

  const model = settings.upscaylModel || 'upscayl-standard-4x';
  const scale = String(settings.upscaylScale || '4');
  const format = settings.upscaylFormat || 'png';
  const template = settings.namingTemplate || '{name}';
  let gpuId = settings.upscaylGpu && settings.upscaylGpu !== 'auto' ? String(settings.upscaylGpu) : null;
  if (gpuId === null && doUpscale) gpuId = await gpu.resolveDedicatedGpuId();

  if (keepRuns) {
    if (doUpscale) paths.ensureDir(upscaledRoot);
    if (doCompress) paths.ensureDir(compressedRoot);
  } else {
    if (doUpscale) clearDir(upscaledRoot);
    if (doCompress) clearDir(compressedRoot);
  }

  const folderEntries = [];
  const fileEntries = [];
  for (const p of queue) {
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    if (stat.isDirectory()) folderEntries.push(p);
    else if (IMAGE_RE.test(p)) fileEntries.push(p);
  }

  const multiFolder = folderEntries.length > 1;
  const sources = [];
  let totalImages = 0;
  for (const folder of folderEntries) {
    const label = multiFolder ? sanitizeName(path.basename(folder)) : '';
    const images = walkImages(folder, recursive);
    totalImages += images.length;
    sources.push({ label, images });
  }
  if (fileEntries.length) {
    const images = fileEntries.map(f => ({ abs: f, rel: path.basename(f) }));
    totalImages += images.length;
    sources.push({ label: '', images });
  }

  if (totalImages === 0) {
    send({ stage: 'upscaling', status: 'done', message: 'No images found in selected folder(s).', percent: 100 });
    closeLog();
    state.running = false;
    return { success: false, error: 'No images found.' };
  }

  if (doUpscale && !fs.existsSync(upscaylBin)) {
    closeLog();
    state.running = false;
    throw new Error('upscayl-bin.exe not found. Please run setup.');
  }
  if (doCompress && !fs.existsSync(caesiumBin)) {
    closeLog();
    state.running = false;
    throw new Error('caesiumclt.exe not found. Please run setup.');
  }

  const report = makeReporter(send, startTime, totalImages);
  const manifest = [];

  // ── Stage 1: Upscaling ──
  let upscaledCount = 0;
  if (doUpscale) {
    report({ stage: 'upscaling', status: 'starting', message: `Starting — ${totalImages} image${totalImages !== 1 ? 's' : ''} queued` }, 0);

    for (const source of sources) {
      if (state.cancelled) break;
      const groups = new Map();
      for (const img of source.images) {
        const outRelDir = path.join(source.label, path.dirname(img.rel) === '.' ? '' : path.dirname(img.rel));
        if (!groups.has(outRelDir)) groups.set(outRelDir, []);
        groups.get(outRelDir).push({ abs: img.abs, name: path.basename(img.rel) });
      }

      for (const [outRelDir, files] of groups) {
        if (state.cancelled) break;
        await waitWhilePaused();

        const outDir = path.join(upscaledRoot, outRelDir);
        paths.ensureDir(outDir);
        clearDir(tmpInputDir);
        for (const f of files) placeFile(f.abs, path.join(tmpInputDir, f.name));

        const args = ['-i', tmpInputDir, '-o', outDir, '-s', scale, '-m', modelsDir, '-n', model, '-f', format];
        if (gpuId !== null) args.push('-g', gpuId);
        if (settings.upscaylTileSize && String(settings.upscaylTileSize) !== '0') args.push('-t', String(settings.upscaylTileSize));
        if (settings.upscaylTta) args.push('-x');

        const groupBase = upscaledCount;
        // Two groups can share an output directory, so progress is measured
        // against what was already there rather than the raw file count.
        const preexisting = countImages(outDir);
        await runWithPolling(upscaylBin, args, path.dirname(upscaylBin), outDir, () => {
          const done = Math.min(Math.max(0, countImages(outDir) - preexisting), files.length);
          report({ stage: 'upscaling', status: 'running', message: `Upscaling ${groupBase + done} of ${totalImages}` }, groupBase + done);
        });

        let produced = 0;
        files.forEach((f, i) => {
          const base = path.parse(f.name).name;
          const outPath = path.join(outDir, `${base}.${format}`);
          if (!fs.existsSync(outPath)) return;
          produced++;
          let finalName = `${base}.${format}`;
          if (template && template !== '{name}') {
            finalName = `${applyTemplate(template, { name: base, model, scale, index: groupBase + i + 1 })}.${format}`;
            const renamed = path.join(outDir, finalName);
            try { if (renamed !== outPath) fs.renameSync(outPath, renamed); } catch { finalName = `${base}.${format}`; }
          }
          manifest.push({
            original: f.abs,
            upscaled: path.join(outDir, finalName),
            outRel: path.join(outRelDir, finalName),
            compressed: '',
          });
        });

        upscaledCount = groupBase + produced;
      }
    }

    try { fs.rmSync(tmpInputDir, { recursive: true, force: true }); } catch {}

    if (!state.cancelled) {
      upscaledCount = manifest.length;
      report({ stage: 'upscaling', status: 'done', message: `Upscaling complete — ${upscaledCount} of ${totalImages} done` }, upscaledCount);
    }
  } else {
    for (const source of sources) {
      for (const img of source.images) {
        const outRel = path.join(source.label, img.rel);
        manifest.push({ original: img.abs, upscaled: img.abs, outRel, compressed: '' });
      }
    }
  }

  if (state.cancelled) return finishCancelled(send);

  // ── Stage 2: Compression ──
  let compressedCount = 0;
  if (doCompress) {
    const items = manifest.filter(m => m.upscaled && fs.existsSync(m.upscaled));
    const total = items.length || 1;
    report({ stage: 'compressing', status: 'starting', message: `Compressing ${total} image${total !== 1 ? 's' : ''}` }, 0);

    const byDir = new Map();
    for (const item of items) {
      const targetDir = path.join(compressedRoot, path.dirname(item.outRel) === '.' ? '' : path.dirname(item.outRel));
      if (!byDir.has(targetDir)) byDir.set(targetDir, []);
      byDir.get(targetDir).push(item.upscaled);
    }

    const quality = String(settings.caesiumQuality !== undefined ? settings.caesiumQuality : 82);
    const flags = ['-q', quality];
    if (settings.caesiumLossless) flags.push('--lossless');
    if (settings.caesiumKeepMeta) flags.push('-e');
    if (settings.caesiumFormat && settings.caesiumFormat !== 'same') flags.push('--format', settings.caesiumFormat);

    for (const [targetDir, files] of byDir) {
      if (state.cancelled) break;
      paths.ensureDir(targetDir);
      for (let i = 0; i < files.length; i += COMPRESS_CHUNK) {
        if (state.cancelled) break;
        await waitWhilePaused();
        const chunk = files.slice(i, i + COMPRESS_CHUNK);
        const args = [...flags, '-o', targetDir, ...chunk];
        await runWithPolling(caesiumBin, args, undefined, targetDir, () => {
          const seen = Math.min(dirCountImagesRecursive(compressedRoot), total);
          report({ stage: 'compressing', status: 'running', message: `Compressing ${seen} of ${total}` }, seen);
        });
        compressedCount += chunk.length;
      }
    }

    compressedCount = dirCountImagesRecursive(compressedRoot);
    if (!state.cancelled) report({ stage: 'compressing', status: 'done', message: `Compression complete — ${compressedCount} images` }, total);

    for (const item of items) {
      const dir = path.join(compressedRoot, path.dirname(item.outRel) === '.' ? '' : path.dirname(item.outRel));
      const baseNoExt = path.parse(item.outRel).name;
      try {
        const match = fs.readdirSync(dir).find(f => IMAGE_RE.test(f) && path.parse(f).name === baseNoExt);
        if (match) item.compressed = path.join(dir, match);
      } catch {}
    }
  }

  if (state.cancelled) return finishCancelled(send);

  const beforeSize = doUpscale ? dirSize(upscaledRoot) : manifest.reduce((a, m) => a + safeSize(m.original), 0);
  const afterSize = doCompress ? dirSize(compressedRoot) : dirSize(upscaledRoot);
  const savedPct = beforeSize > 0 ? Math.round((beforeSize - afterSize) / beforeSize * 100) : 0;

  report({ stage: 'complete', status: 'done', message: 'Pipeline complete.' }, totalImages);
  writeLog(`Done. upscaled=${upscaledCount} compressed=${compressedCount} saved=${savedPct}%`);
  closeLog();
  state.running = false;

  return {
    success: true,
    upscaledCount: doUpscale ? upscaledCount : 0,
    compressedCount: doCompress ? compressedCount : 0,
    savedPct,
    beforeSize,
    afterSize,
    durationMs: Date.now() - startTime,
    upscaledDir: doUpscale ? upscaledRoot : '',
    compressedDir: doCompress ? compressedRoot : '',
    results: manifest,
    logPath: state.logPath || '',
  };
}

function dirCountImagesRecursive(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (IMAGE_RE.test(e.name)) n++;
    }
  };
  walk(dir);
  return n;
}

function safeSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

function finishCancelled(send) {
  send({ stage: 'cancelled', status: 'cancelled', message: 'Pipeline cancelled by user.' });
  writeLog('Cancelled by user.');
  closeLog();
  state.running = false;
  return { success: false, cancelled: true };
}

module.exports = { runPipeline, cancel, pause, resume, isRunning, isPaused };
