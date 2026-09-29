'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, exec } = require('child_process');
const paths = require('./paths');
const gpu = require('./gpu');
const { collectInputs } = require('./scan');
const { createWriter } = require('./output');

const POLL_MS = 400;
// Images per engine launch. Small enough that pause and cancel take effect in
// seconds rather than after a whole folder; large enough to amortise the
// engine's start-up cost.
const UPSCALE_BATCH = 8;
const COMPRESS_BATCH = 24;
const KEEP_LOGS = 30;

const state = {
  running: false,
  cancelled: false,
  paused: false,
  pauseStartedAt: 0,
  pausedMs: 0,
  activeProcess: null,
  logStream: null,
  logPath: '',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function isRunning() { return state.running; }
function isPaused() { return state.paused; }

function killActive() {
  if (state.activeProcess) {
    try { exec(`taskkill /PID ${state.activeProcess.pid} /T /F`, { windowsHide: true }); } catch {}
    state.activeProcess = null;
  }
}

function pause() {
  if (!state.running || state.paused) return;
  state.paused = true;
  state.pauseStartedAt = Date.now();
}
function resume() {
  if (!state.paused) return;
  state.paused = false;
  state.pausedMs += Date.now() - state.pauseStartedAt;
  state.pauseStartedAt = 0;
}
function cancel() { state.cancelled = true; resume(); killActive(); }

function pausedSoFar() {
  return state.pausedMs + (state.paused ? Date.now() - state.pauseStartedAt : 0);
}

async function waitWhilePaused() {
  while (state.paused && !state.cancelled) await sleep(200);
}

// ── Logging ──

function pruneLogs(dir) {
  try {
    const logs = fs.readdirSync(dir).filter(f => /^run-.*\.log$/.test(f)).sort();
    for (const f of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
}

function openLog() {
  try {
    const dir = paths.getLogsDir();
    paths.ensureDir(dir);
    pruneLogs(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    state.logPath = path.join(dir, `run-${stamp}.log`);
    state.logStream = fs.createWriteStream(state.logPath, { flags: 'a' });
  } catch { state.logStream = null; state.logPath = ''; }
}

function writeLog(text) {
  if (!state.logStream) return;
  try { state.logStream.write(`[${new Date().toISOString()}] ${text}\n`); } catch {}
}

function closeLog() {
  if (state.logStream) { try { state.logStream.end(); } catch {} state.logStream = null; }
}

// ── Helpers ──

// run-2026-08-17_14-32-05 — sortable and filename-safe.
function runStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `run-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
         `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

// Strips what Windows forbids in a filename: reserved characters, control
// characters, and trailing dots or spaces.
function sanitizeName(name) {
  const printable = [...String(name)].filter(c => c.charCodeAt(0) >= 32).join('');
  return printable.replace(/[<>:"/\\|?*]/g, '').replace(/[. ]+$/, '').trim() || 'image';
}

function applyTemplate(tpl, tokens) {
  return sanitizeName(tpl
    .replace(/\{name\}/g, tokens.name)
    .replace(/\{model\}/g, tokens.model)
    .replace(/\{scale\}/g, tokens.scale)
    .replace(/\{index\}/g, String(tokens.index)));
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

async function linkOrCopy(src, dest) {
  try { await fsp.link(src, dest); }
  catch { await fsp.copyFile(src, dest); }
}

function lastLines(text) {
  return String(text).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(-240);
}

// Splits work into launches where no two inputs share a file stem, so the
// tool's outputs (which keep the stem) can't overwrite one another.
function partitionByStem(work, size) {
  const chunks = [];
  for (const w of work) {
    const stem = path.parse(w.input).name.toLowerCase();
    let chunk = chunks.find(c => c.items.length < size && !c.stems.has(stem));
    if (!chunk) { chunk = { items: [], stems: new Set() }; chunks.push(chunk); }
    chunk.items.push(w);
    chunk.stems.add(stem);
  }
  return chunks.map(c => c.items);
}

// Throughput and ETA are measured per stage, with paused time excluded —
// otherwise compression inherits the whole upscale duration and reports an ETA
// of hours.
function makeReporter(send, runStart) {
  let stage = '';
  let stageStart = 0;
  let pausedAtStageStart = 0;
  let lastLogged = '';
  return (base, completed, total) => {
    const now = Date.now();
    if (base.stage !== stage) {
      stage = base.stage;
      stageStart = now;
      pausedAtStageStart = pausedSoFar();
    }
    const activeSec = Math.max(0, (now - stageStart) - (pausedSoFar() - pausedAtStageStart)) / 1000;
    const throughput = completed > 0 && activeSec > 0 ? completed / activeSec : 0;
    const etaMs = throughput > 0 ? Math.max(0, total - completed) / throughput * 1000 : 0;
    const percent = total > 0 ? Math.min(100, Math.round(completed / total * 100)) : 0;
    if (base.message && base.message !== lastLogged) { writeLog(base.message); lastLogged = base.message; }
    send({ ...base, current: completed, total, percent, elapsedMs: now - runStart, etaMs, throughput });
  };
}

function runWithPolling(bin, args, cwd, onPoll) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, windowsHide: true });
    state.activeProcess = proc;
    proc.stdout.resume();
    // The engine prints progress to stderr continuously; keep only the tail.
    let stderr = '';
    proc.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });

    const poll = setInterval(() => { try { onPoll(); } catch {} }, POLL_MS);
    const settle = () => {
      clearInterval(poll);
      if (state.activeProcess === proc) state.activeProcess = null;
    };

    proc.on('close', (code) => {
      settle();
      if (state.cancelled || code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} exited with code ${code}. ${lastLines(stderr)}`.trim()));
    });
    proc.on('error', (err) => { settle(); reject(err); });
  });
}

// ── Stages ──

async function upscaleStage({ items, writer, report, fail, settings, upscaylBin, gpuId }) {
  const model = settings.upscaylModel || 'upscayl-standard-4x';
  const scale = ['2', '3', '4'].includes(String(settings.upscaylScale)) ? String(settings.upscaylScale) : '4';
  const format = ['png', 'jpg', 'webp'].includes(settings.upscaylFormat) ? settings.upscaylFormat : 'png';
  const template = String(settings.namingTemplate || '').trim() || '{name}';
  const tile = clampInt(settings.upscaylTileSize, 0, 4096, 0);

  const sharedArgs = ['-s', scale, '-m', paths.getModelsDir(), '-n', model, '-f', format];
  if (gpuId !== null) sharedArgs.push('-g', gpuId);
  if (tile > 0) sharedArgs.push('-t', String(tile));
  if (settings.upscaylTta) sharedArgs.push('-x');

  const total = items.length;
  let done = 0;
  let produced = 0;
  report({ stage: 'upscaling', status: 'starting', message: `Starting — ${plural(total, 'image')} queued`, produced }, 0, total);

  // One engine launch over `batch`. Inputs are renamed to their position in the
  // run, so photo.jpg + photo.png — or IMG_0001 from two cameras — can't collide.
  const runBatch = async (batch, tag) => {
    const inDir = path.join(paths.getTempInputDir(), tag);
    await fsp.rm(inDir, { recursive: true, force: true });
    await fsp.mkdir(inDir, { recursive: true });
    for (const it of batch) await linkOrCopy(it.original, path.join(inDir, it.token + it.ext));
    const outDir = await writer.stagingDir(tag);

    let error = null;
    try {
      await runWithPolling(upscaylBin, ['-i', inDir, '-o', outDir, ...sharedArgs], path.dirname(upscaylBin), () => {
        const n = Math.min(countFiles(outDir), batch.length);
        report({ stage: 'upscaling', status: 'running', message: `Upscaling ${done + n} of ${total}`, produced: produced + n }, done + n, total);
      });
    } catch (err) { error = err; }
    await fsp.rm(inDir, { recursive: true, force: true }).catch(() => {});

    const ok = [];
    const missing = [];
    for (const it of batch) (fs.existsSync(path.join(outDir, `${it.token}.${format}`)) ? ok : missing).push(it);
    return { ok, missing, error, outDir };
  };

  const place = async (it, outDir) => {
    const name = template === '{name}'
      ? `${it.base}.${format}`
      : `${applyTemplate(template, { name: it.base, model, scale, index: it.index })}.${format}`;
    it.upscaled = await writer.place(path.join(outDir, `${it.token}.${format}`), it.relDir, name);
    produced++;
  };

  const reasonFrom = (err) => err
    ? err.message
    : 'The engine produced no output for this image. It may be corrupt or in an unsupported format.';

  for (let b = 0; b < total; b += UPSCALE_BATCH) {
    await waitWhilePaused();
    if (state.cancelled) return;

    const batch = items.slice(b, b + UPSCALE_BATCH);
    const result = await runBatch(batch, `u${b}`);
    if (state.cancelled) return;
    for (const it of result.ok) await place(it, result.outDir);

    if (result.missing.length) {
      // One bad image can take a whole launch down, so retry the rest one at a
      // time — only the image that is actually broken should fail.
      let lastError = result.error;
      if (result.missing.length > 1) {
        for (const it of result.missing) {
          await waitWhilePaused();
          if (state.cancelled) return;
          const single = await runBatch([it], `u${b}-${it.token}`);
          if (state.cancelled) return;
          if (single.ok.length) await place(it, single.outDir);
          else { lastError = single.error || lastError; fail(it, 'upscale', reasonFrom(single.error)); }
        }
      } else {
        fail(result.missing[0], 'upscale', reasonFrom(result.error));
      }
      // Every image so far has failed even on its own: the engine itself is
      // broken (driver, GPU, model), and carrying on would only repeat that.
      if (produced === 0) {
        throw new Error(`The upscaling engine couldn't process any images. ${reasonFrom(lastError)} ` +
          'Try Settings → Re-detect GPUs, or choose a different GPU.');
      }
    }

    done += batch.length;
    report({ stage: 'upscaling', status: 'running', message: `Upscaling ${done} of ${total}`, produced }, done, total);
  }

  const skipped = total - produced;
  report({
    stage: 'upscaling', status: 'done', produced,
    message: `Upscaling complete — ${produced} of ${total}${skipped ? `, ${skipped} failed` : ''}`,
  }, total, total);
}

async function compressStage({ items, writer, report, fail, settings, caesiumBin, fromUpscale }) {
  const work = (fromUpscale ? items.filter(it => it.upscaled) : items).map(it => ({
    it,
    input: fromUpscale ? it.upscaled : it.original,
    relDir: it.relDir,
  }));
  const total = work.length;
  if (!total) {
    report({ stage: 'compressing', status: 'done', message: 'Nothing to compress.', produced: 0 }, 0, 0);
    return;
  }

  // caesium accepts exactly one of --quality / --lossless / --max-size; passing
  // both makes it reject the whole command.
  const flags = settings.caesiumLossless
    ? ['--lossless']
    : ['-q', String(clampInt(settings.caesiumQuality, 0, 100, 82))];
  if (settings.caesiumKeepMeta) flags.push('-e');
  if (['jpeg', 'png', 'webp'].includes(settings.caesiumFormat)) flags.push('--format', settings.caesiumFormat);

  let done = 0;
  let produced = 0;
  report({ stage: 'compressing', status: 'starting', message: `Compressing ${plural(total, 'image')}`, produced }, 0, total);

  const runChunk = async (chunk, tag) => {
    const outDir = await writer.stagingDir(tag);
    let error = null;
    try {
      await runWithPolling(caesiumBin, [...flags, '-o', outDir, ...chunk.map(w => w.input)], undefined, () => {
        const n = Math.min(countFiles(outDir), chunk.length);
        report({ stage: 'compressing', status: 'running', message: `Compressing ${done + n} of ${total}`, produced: produced + n }, done + n, total);
      });
    } catch (err) { error = err; }

    // Output keeps the input's stem; the extension changes with --format.
    const byStem = new Map();
    try { for (const f of fs.readdirSync(outDir)) byStem.set(path.parse(f).name.toLowerCase(), f); } catch {}
    const ok = [];
    const missing = [];
    for (const w of chunk) {
      const file = byStem.get(path.parse(w.input).name.toLowerCase());
      if (file) ok.push({ w, staged: path.join(outDir, file), file }); else missing.push(w);
    }
    return { ok, missing, error };
  };

  const place = async ({ w, staged, file }) => {
    w.it.compressed = await writer.place(staged, w.relDir, file);
    produced++;
  };

  const reasonFrom = (err) => err ? err.message : 'The compressor produced no output for this image.';

  const chunks = partitionByStem(work, COMPRESS_BATCH);
  for (let c = 0; c < chunks.length; c++) {
    await waitWhilePaused();
    if (state.cancelled) return;

    const chunk = chunks[c];
    const result = await runChunk(chunk, `c${c}`);
    if (state.cancelled) return;
    for (const entry of result.ok) await place(entry);

    if (result.missing.length) {
      let lastError = result.error;
      if (result.missing.length > 1 && result.error) {
        for (const w of result.missing) {
          await waitWhilePaused();
          if (state.cancelled) return;
          const single = await runChunk([w], `c${c}-${path.parse(w.input).name}`);
          if (state.cancelled) return;
          if (single.ok.length) await place(single.ok[0]);
          else { lastError = single.error || lastError; fail(w.it, 'compress', reasonFrom(single.error)); }
        }
      } else {
        for (const w of result.missing) fail(w.it, 'compress', reasonFrom(result.error));
      }
      if (produced === 0 && lastError) {
        throw new Error(`The compressor couldn't process any images. ${reasonFrom(lastError)}`);
      }
    }

    done += chunk.length;
    report({ stage: 'compressing', status: 'running', message: `Compressing ${done} of ${total}`, produced }, done, total);
  }

  const skipped = total - produced;
  report({
    stage: 'compressing', status: 'done', produced,
    message: `Compression complete — ${produced} of ${total}${skipped ? `, ${skipped} failed` : ''}`,
  }, total, total);
}

// ── Run ──

async function runPipeline(args, send) {
  if (state.running) return { success: false, error: 'A run is already in progress.' };
  Object.assign(state, { running: true, cancelled: false, paused: false, pauseStartedAt: 0, pausedMs: 0 });
  openLog();
  try {
    return await runPipelineInner(args, send);
  } finally {
    closeLog();
    state.running = false;
    state.activeProcess = null;
  }
}

async function runPipelineInner({ queue, settings }, send) {
  const runStart = Date.now();
  const mode = ['both', 'upscale', 'compress'].includes(settings.pipelineMode) ? settings.pipelineMode : 'both';
  const doUpscale = mode !== 'compress';
  const doCompress = mode !== 'upscale';
  const keepRuns = settings.outputMode === 'keep';

  const upscaylBin = paths.getUpscaylBin();
  const caesiumBin = paths.getCaesiumBin();
  if (doUpscale && !fs.existsSync(upscaylBin)) throw new Error('The upscaling engine is missing. Open Settings and choose Re-run Setup to install it.');
  if (doCompress && !fs.existsSync(caesiumBin)) throw new Error('The compression tool is missing. Open Settings and choose Re-run Setup to install it.');

  const upBase = paths.getUpscaledDir();
  const compBase = paths.getCompressedDir();
  const targets = [];
  if (doUpscale) targets.push({ base: upBase, label: 'upscaled', isDefault: paths.samePath(upBase, paths.defaultUpscaledDir()) });
  if (doCompress) targets.push({ base: compBase, label: 'compressed', isDefault: paths.samePath(compBase, paths.defaultCompressedDir()) });

  // ── Pre-flight: refuse anything that could lose data, before touching disk ──
  for (const t of targets) {
    if (!paths.tryEnsureDir(t.base)) {
      throw new Error(`The ${t.label} output folder isn't reachable: ${t.base}. Reconnect the drive, or choose another folder in Settings.`);
    }
  }
  if (doUpscale && doCompress && (paths.isSameOrInside(upBase, compBase) || paths.isSameOrInside(compBase, upBase))) {
    throw new Error('The upscaled and compressed output folders overlap. Choose two separate folders in Settings.');
  }
  if (!keepRuns) {
    for (const input of queue) {
      const clash = targets.find(t => paths.isSameOrInside(input, t.base));
      if (clash) {
        throw new Error(`"${path.basename(input) || input}" is inside the ${clash.label} output folder, so Replace mode would overwrite it. ` +
          'Switch Previous Results to "Keep all" in Settings, or pick a different output folder.');
      }
    }
  }

  const collected = await collectInputs(queue, { recursive: !!settings.recursive, excludeDirs: [upBase, compBase] });
  const multiFolder = collected.filter(e => e.isDir).length > 1;
  const items = [];
  for (const entry of collected) {
    const label = entry.isDir && multiFolder ? sanitizeName(path.basename(entry.input)) : '';
    for (const f of entry.files) {
      const sub = path.dirname(f.rel);
      const { name, ext } = path.parse(f.abs);
      const index = items.length + 1;
      items.push({
        original: f.abs,
        relDir: entry.isDir ? path.join(label, sub === '.' ? '' : sub) : '',
        base: name,
        ext,
        index,
        token: String(index).padStart(6, '0'),
        upscaled: '',
        compressed: '',
      });
    }
  }
  if (!items.length) return { success: false, error: 'No supported images were found in the selection.' };

  const stamp = keepRuns ? runStamp() : '';
  const writerFor = (t) => createWriter(keepRuns ? path.join(t.base, stamp) : t.base, {
    replace: !keepRuns,
    legacyOwned: t.isDefault,
  });
  const upWriter = doUpscale ? writerFor(targets[0]) : null;
  const compWriter = doCompress ? writerFor(targets[targets.length - 1]) : null;

  let gpuId = settings.upscaylGpu && settings.upscaylGpu !== 'auto' ? String(settings.upscaylGpu) : null;
  if (gpuId === null && doUpscale) gpuId = await gpu.resolveDedicatedGpuId();

  const report = makeReporter(send, runStart);
  const failures = [];
  const fail = (item, stage, reason) => {
    failures.push({ path: item.original, stage, reason });
    writeLog(`FAILED [${stage}] ${item.original} — ${reason}`);
  };

  writeLog(`Run: mode=${mode} output=${keepRuns ? 'keep' : 'replace'} images=${items.length}`);
  try {
    for (const w of [upWriter, compWriter]) if (w) await w.begin();
    if (doUpscale) await upscaleStage({ items, writer: upWriter, report, fail, settings, upscaylBin, gpuId });
    if (doCompress && !state.cancelled) {
      await compressStage({ items, writer: compWriter, report, fail, settings, caesiumBin, fromUpscale: doUpscale });
    }
  } finally {
    // Always record what was written, so the next Replace run can clean it up.
    for (const w of [upWriter, compWriter]) if (w) await w.finish();
    await fsp.rm(paths.getTempInputDir(), { recursive: true, force: true }).catch(() => {});
  }

  const results = items
    .filter(it => it.upscaled || it.compressed)
    .map(it => ({ original: it.original, upscaled: it.upscaled, compressed: it.compressed }));

  if (state.cancelled) {
    send({ stage: 'cancelled', status: 'cancelled', message: 'Pipeline cancelled.' });
    writeLog('Cancelled by user.');
    return { success: false, cancelled: true, results };
  }

  const upscaledCount = items.filter(it => it.upscaled).length;
  const compressedCount = items.filter(it => it.compressed).length;
  // Savings compare like with like: each compressed file against the file it
  // was made from, measured on the files this run produced — not whatever else
  // happens to live in the output folder.
  const compressedItems = items.filter(it => it.compressed);
  const beforeSize = compressedItems.reduce((a, it) => a + fileSize(doUpscale ? it.upscaled : it.original), 0);
  const afterSize = compressedItems.reduce((a, it) => a + fileSize(it.compressed), 0);
  const savedPct = beforeSize > 0 ? Math.round((beforeSize - afterSize) / beforeSize * 100) : 0;

  report({ stage: 'complete', status: 'done', message: 'Pipeline complete.' }, items.length, items.length);
  writeLog(`Done. upscaled=${upscaledCount} compressed=${compressedCount} failed=${failures.length} saved=${savedPct}%`);

  return {
    success: true,
    upscaledCount,
    compressedCount,
    failedCount: failures.length,
    failures,
    savedPct: doCompress ? savedPct : null,
    beforeSize,
    afterSize,
    durationMs: Date.now() - runStart,
    upscaledDir: upWriter ? upWriter.root : '',
    compressedDir: compWriter ? compWriter.root : '',
    results,
    logPath: state.logPath || '',
  };
}

module.exports = { runPipeline, cancel, pause, resume, isRunning, isPaused };
