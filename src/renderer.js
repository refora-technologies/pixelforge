'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let inputFolder = '';
let scannedImages = [];
let pipelineRunning = false;
let settings = {};
let appPaths = {};

// ─── Utilities ────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function numFmt(n) { return Number(n).toLocaleString(); }
function byteFmt(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}
function log(text, cls = '') {
  const box = $('pipeline-log');
  if (!box) return;
  const line = document.createElement('span');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${ts}] ${text}`;
  box.appendChild(line);
  box.appendChild(document.createElement('br'));
  box.scrollTop = box.scrollHeight;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  settings = await window.pixelforge.getSettings();
  appPaths = await window.pixelforge.getAppPaths();

  applyAccentColor(settings.accentColor || '#6366f1');
  updateOutputPathDisplays();

  if (settings.savedInputFolder) {
    setInputFolder(settings.savedInputFolder);
    $('chk-remember-folder').checked = true;
  }

  // Load models and GPUs before populating settings
  await loadModels(settings.upscaylModel);
  await loadGpus(settings.upscaylGpu);
  populateSettingsForm();

  // Titlebar controls
  $('btn-minimize').addEventListener('click', () => window.pixelforge.minimize());
  $('btn-maximize').addEventListener('click', () => window.pixelforge.maximize());
  $('btn-close').addEventListener('click', () => window.pixelforge.close());

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
  });

  // Dashboard
  $('btn-browse').addEventListener('click', onBrowse);
  $('btn-scan').addEventListener('click', onScan);
  $('btn-start').addEventListener('click', onStartPipeline);
  $('btn-cancel').addEventListener('click', onCancelPipeline);
  $('btn-open-upscaled').addEventListener('click', () => window.pixelforge.openFolder(appPaths.upscaled));
  $('btn-open-compressed').addEventListener('click', () => window.pixelforge.openFolder(appPaths.compressed));

  // Settings
  $('btn-save-settings').addEventListener('click', onSaveSettings);
  $('set-caesium-quality').addEventListener('input', () => {
    $('set-caesium-quality-val').textContent = $('set-caesium-quality').value;
  });
  $('set-accent-color').addEventListener('input', () => {
    const val = $('set-accent-color').value;
    $('set-accent-preview').textContent = val;
    applyAccentColor(val);
  });

  // Path browse
  $('btn-browse-upscayl-bin').addEventListener('click', async () => {
    const f = await window.pixelforge.selectFile([{ name: 'Executable', extensions: ['exe'] }]);
    if (f) $('set-upscayl-bin-path').value = f;
  });
  $('btn-browse-caesium-bin').addEventListener('click', async () => {
    const f = await window.pixelforge.selectFile([{ name: 'Executable', extensions: ['exe'] }]);
    if (f) $('set-caesium-bin-path').value = f;
  });
  $('btn-browse-models').addEventListener('click', async () => {
    const f = await window.pixelforge.selectFolder();
    if (f) $('set-models-path').value = f;
  });
  $('btn-browse-upscaled').addEventListener('click', async () => {
    const f = await window.pixelforge.selectFolder();
    if (f) $('set-upscaled-path').value = f;
  });
  $('btn-browse-compressed').addEventListener('click', async () => {
    const f = await window.pixelforge.selectFolder();
    if (f) $('set-compressed-path').value = f;
  });

  $('btn-rerun-setup').addEventListener('click', () => showSetupOverlay(true));

  // Pipeline listeners
  window.pixelforge.onPipelineProgress(onPipelineProgress);
  window.pixelforge.onPipelineDone(onPipelineDone);

  await runSetupCheck();
}

// ─── Dynamic Model Loading ────────────────────────────────────────────────────
async function loadModels(currentModel) {
  const sel = $('set-upscayl-model');
  if (!sel) return;
  try {
    const models = await window.pixelforge.listModels();
    sel.innerHTML = '';
    if (models.length === 0) {
      // Fallback list if models folder is empty/not found yet
      const fallbacks = [
        { id: 'upscayl-standard-4x',      name: 'Upscayl Standard 4x (Recommended)' },
        { id: 'upscayl-standard-lite-4x', name: 'Upscayl Standard Lite 4x' },
        { id: 'upscayl-ultra-fast-4x',    name: 'Upscayl Ultra Fast 4x' },
        { id: 'realesrgan-x4plus',        name: 'Real-ESRGAN 4x (General)' },
        { id: 'realesrgan-x4plus-anime',  name: 'Real-ESRGAN Anime 4x' },
        { id: 'ultrasharp',               name: 'Ultrasharp' },
        { id: 'remacri',                  name: 'Remacri' },
      ];
      for (const m of fallbacks) {
        const opt = document.createElement('option');
        opt.value = m.id; opt.textContent = m.name;
        sel.appendChild(opt);
      }
    } else {
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id; opt.textContent = m.name;
        sel.appendChild(opt);
      }
    }
    // Set currently saved model
    if (currentModel) sel.value = currentModel;
    if (!sel.value && sel.options.length > 0) sel.selectedIndex = 0;
  } catch (e) {
    console.error('loadModels error:', e);
  }
}

// ─── Dynamic GPU Loading ───────────────────────────────────────────────────────
async function loadGpus(currentGpu) {
  const sel = $('set-upscayl-gpu');
  if (!sel) return;
  try {
    const gpus = await window.pixelforge.listGpus();
    // Keep the 'auto' option, then append real GPUs
    sel.innerHTML = '<option value="auto">Auto-detect (Recommended)</option>';
    let dedicatedIdx = null;
    for (const g of gpus) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `GPU ${g.id}: ${g.name}${g.vramLabel ? ' (' + g.vramLabel + ')' : ''}${g.isIntegrated ? ' — Integrated' : ' — Dedicated'}`;
      sel.appendChild(opt);
      // Track the first dedicated GPU
      if (!g.isIntegrated && dedicatedIdx === null) dedicatedIdx = g.id;
    }
    // Set saved value or default to dedicated GPU
    if (currentGpu && currentGpu !== 'auto') {
      sel.value = currentGpu;
    } else if (dedicatedIdx !== null && (!currentGpu || currentGpu === 'auto')) {
      sel.value = dedicatedIdx;
      // Auto-save dedicated GPU as default
      await window.pixelforge.saveSettings({ upscaylGpu: dedicatedIdx });
    }
  } catch (e) {
    console.error('loadGpus error:', e);
  }
}

function applyAccentColor(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-hover', shadeHex(hex, -20));
  document.documentElement.style.setProperty('--accent-muted', `rgba(${r},${g},${b},0.12)`);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.18)`);
  document.documentElement.style.setProperty('--border-accent', `rgba(${r},${g},${b},0.4)`);
}
function shadeHex(hex, amt) {
  let r = Math.min(255, Math.max(0, parseInt(hex.slice(1,3),16) + amt));
  let g = Math.min(255, Math.max(0, parseInt(hex.slice(3,5),16) + amt));
  let b = Math.min(255, Math.max(0, parseInt(hex.slice(5,7),16) + amt));
  return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}

// ─── Navigation ────────────────────────────────────────────────────────────────
function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  const pageEl = $(`page-${page}`);
  if (navEl) navEl.classList.add('active');
  if (pageEl) pageEl.classList.add('active');
  currentPage = page;
}

// ─── Setup ────────────────────────────────────────────────────────────────────
async function runSetupCheck() {
  $('setup-overlay').style.display = 'flex';
  const result = await window.pixelforge.checkSetup();

  const upOk = result.upscaylOk && result.modelsOk;
  const csOk = result.caesiumOk;

  updateDepRow('dep-upscayl', 'dep-upscayl-status', upOk);
  updateDepRow('dep-caesium', 'dep-caesium-status', csOk);

  if (upOk && csOk) {
    let msg = 'All dependencies found. Ready to launch.';
    if (result.upscaylDetected) msg = 'Upscayl installation auto-detected. All dependencies ready.';
    $('setup-info-text').textContent = msg;
    $('setup-info-text').className = 'setup-info';
    $('setup-actions').style.display = 'none';
    $('setup-all-ok').classList.remove('hidden');
    $('btn-enter-app').addEventListener('click', hideSetupOverlay);
  } else {
    const missing = [];
    if (!upOk) missing.push('Upscayl engine + AI models');
    if (!csOk) missing.push('Caesium CLT');

    let detectionNote = '';
    if (result.upscaylDetected && !result.modelsOk) {
      detectionNote = `<br/><br/><span style="color:var(--green);font-size:11px;">Upscayl binary detected — only models are missing from its models folder.</span>`;
    }

    $('setup-info-text').innerHTML = `
      <strong>Missing dependencies detected:</strong><br/>
      ${missing.map(m => `&bull; ${m}`).join('<br/>')}${detectionNote}
      <br/><br/>
      PixelForge will download and install these tools automatically. They will be stored in the app
      data folder and used exclusively by PixelForge.
      <br/><br/>
      <span style="color:var(--text-3);font-size:11px;">Estimated download size: ~200 MB (includes AI models)</span>
    `;
    $('setup-actions').style.display = 'flex';
    $('setup-all-ok').classList.add('hidden');
    $('btn-start-download').onclick = () => startDownload(result);
    $('btn-skip-setup').onclick = hideSetupOverlay;
  }
}

function updateDepRow(rowId, statusId, isOk) {
  const row = $(rowId);
  row.className = 'dep-row ' + (isOk ? 'dep-ok' : 'dep-missing');
  const statusEl = $(statusId);
  if (isOk) {
    statusEl.innerHTML = '<svg width="16" height="16"><use href="#ic-check"/></svg>';
  } else {
    statusEl.innerHTML = '<svg width="16" height="16"><use href="#ic-warn"/></svg>';
  }
}

function showSetupOverlay(recheck) {
  $('setup-overlay').style.display = 'flex';
  $('setup-step-check').classList.remove('hidden');
  $('setup-step-download').classList.add('hidden');
  if (recheck) runSetupCheck();
}
function hideSetupOverlay() {
  $('setup-overlay').style.display = 'none';
  window.pixelforge.getSettings().then(async s => {
    settings = s;
    await loadModels(s.upscaylModel);
    await loadGpus(s.upscaylGpu);
  });
  window.pixelforge.getAppPaths().then(p => { appPaths = p; updateOutputPathDisplays(); });
}

async function startDownload(checkResult) {
  $('setup-step-check').classList.add('hidden');
  $('setup-step-download').classList.remove('hidden');
  $('dl-done-wrap').classList.add('hidden');
  $('dl-error-msg').classList.add('hidden');

  const down = {
    downloadUpscayl: !(checkResult.upscaylOk && checkResult.modelsOk),
    downloadCaesium: !checkResult.caesiumOk,
  };

  if (!down.downloadCaesium) $('dl-caesium-wrap').classList.add('hidden');
  if (!down.downloadUpscayl) $('dl-upscayl-wrap').classList.add('hidden');

  window.pixelforge.removeAllListeners('download-progress');
  window.pixelforge.onDownloadProgress((data) => {
    if (data.stage === 'caesium') {
      $('dl-caesium-bar').style.width = (data.percent || 0) + '%';
      $('dl-caesium-pct').textContent = (data.percent || 0) + '%';
      $('dl-caesium-status').textContent = data.message || '';
      $('dl-caesium-status').className = 'dl-status' + (data.status === 'done' ? ' ok' : '');
      if (data.status === 'done') $('dl-caesium-bar').classList.add('done');
    } else if (data.stage === 'upscayl' || data.stage === 'models') {
      // Both binary and per-model progress use the upscayl bar
      $('dl-upscayl-bar').style.width = (data.percent || 0) + '%';
      $('dl-upscayl-pct').textContent = (data.percent || 0) + '%';
      $('dl-upscayl-status').textContent = data.message || '';
      $('dl-upscayl-status').className = 'dl-status' + (data.status === 'done' && data.percent >= 100 ? ' ok' : '');
      if (data.status === 'done' && data.percent >= 100) $('dl-upscayl-bar').classList.add('done');
    } else if (data.stage === 'complete') {
      $('dl-done-wrap').classList.remove('hidden');
      $('btn-dl-enter').addEventListener('click', hideSetupOverlay);
    } else if (data.stage === 'error') {
      $('dl-error-msg').classList.remove('hidden');
      $('dl-error-text').textContent = 'Download failed: ' + data.message;
    }
  });

  const result = await window.pixelforge.downloadDeps(down);
  if (!result.success && !result.cancelled) {
    $('dl-error-msg').classList.remove('hidden');
    $('dl-error-text').textContent = 'Download failed: ' + (result.error || 'Unknown error');
  }
}

// ─── Dashboard: Browse & Scan ─────────────────────────────────────────────────
async function onBrowse() {
  const folder = await window.pixelforge.selectFolder();
  if (folder) {
    setInputFolder(folder);
    await onScan();
  }
}

function setInputFolder(folder) {
  inputFolder = folder;
  const el = $('input-path-display');
  el.textContent = folder;
  el.classList.add('filled');
  $('btn-scan').disabled = false;
}

async function onScan() {
  if (!inputFolder) return;
  const btnScan = $('btn-scan');
  btnScan.disabled = true;
  btnScan.textContent = 'Scanning...';

  const result = await window.pixelforge.scanImages(inputFolder);
  scannedImages = result.images || [];

  btnScan.textContent = 'Scan';
  btnScan.disabled = false;

  if (scannedImages.length === 0) {
    $('scan-results-card').classList.add('hidden');
    $('btn-start').disabled = true;
    $('stats-row').classList.add('hidden');
    return;
  }

  $('scan-count').textContent = numFmt(scannedImages.length);
  const totalSize = scannedImages.reduce((a, img) => a + img.size, 0);
  $('scan-size-text').textContent = `Total size: ${byteFmt(totalSize)}`;

  const types = {};
  scannedImages.forEach(img => {
    const ext = (img.ext || '.???').replace('.','').toUpperCase();
    types[ext] = (types[ext] || 0) + 1;
  });
  $('scan-type-pills').innerHTML = Object.entries(types)
    .map(([ext, n]) => `<span class="type-pill">${ext} (${n})</span>`).join('');

  $('scan-results-card').classList.remove('hidden');
  $('btn-start').disabled = false;
  updateStats(scannedImages.length, 0, 0, null);
  $('stats-row').classList.remove('hidden');

  if ($('chk-remember-folder').checked) {
    await window.pixelforge.saveSettings({ savedInputFolder: inputFolder });
  }
}

// ─── Pipeline ──────────────────────────────────────────────────────────────────
async function onStartPipeline() {
  if (!inputFolder || scannedImages.length === 0 || pipelineRunning) return;

  pipelineRunning = true;
  $('btn-start').disabled = true;
  $('btn-cancel').classList.remove('hidden');
  $('progress-card').classList.remove('hidden');
  $('pipeline-log').innerHTML = '';

  resetStage('upscaling', 'Waiting');
  resetStage('compressing', 'Waiting');
  setBadge('pipeline-status-badge', 'running', 'Processing...');

  log('Pipeline started — scanning batch...', 'log-hl');

  try {
    const s = await window.pixelforge.getSettings();
    await window.pixelforge.startPipeline({ inputFolder, settings: s });
  } catch (err) {
    log('Error: ' + err.message, 'log-err');
    pipelineRunning = false;
    $('btn-start').disabled = false;
    $('btn-cancel').classList.add('hidden');
    setBadge('pipeline-status-badge', 'error', 'Error');
  }
}

async function onCancelPipeline() {
  await window.pixelforge.cancelPipeline();
  pipelineRunning = false;
  $('btn-start').disabled = false;
  $('btn-cancel').classList.add('hidden');
  // Show 'Cancelled' in the top-right badge — NOT an error
  setBadge('pipeline-status-badge', 'cancelled', 'Cancelled');
  log('Pipeline cancelled by user.', 'log-warn');
}

function onPipelineProgress(data) {
  const { stage, percent = 0, message = '', status, current, total } = data;

  if (stage === 'upscaling') {
    if (status === 'done') {
      setStage('upscaling', 100, message, 'done');
      log(message, 'log-ok');
      // Final accurate count
      if (current !== undefined) updateStats(scannedImages.length, current, 0, null);
    } else {
      const displayMsg = (current !== undefined && total !== undefined)
        ? `Upscaled ${current} of ${total} images`
        : message;
      setStage('upscaling', percent, displayMsg, 'run');
      // Update UPSCALED counter in real-time
      if (current !== undefined) {
        updateStats(scannedImages.length, current, 0, null);
        if (current > 0) log(displayMsg);
      }
    }
  } else if (stage === 'compressing') {
    if (status === 'done') {
      setStage('compressing', 100, message, 'done');
    } else {
      setStage('compressing', percent, message, 'run');
      // Update COMPRESSED counter in real-time
      if (data.current !== undefined) {
        updateStats(scannedImages.length, scannedImages.length, data.current, null);
        log(`Compression: ${data.current}/${data.total}`);
      }
    }
  } else if (stage === 'complete') {
    setStage('upscaling', 100, 'Complete', 'done');
    setStage('compressing', 100, 'Complete', 'done');
    setBadge('pipeline-status-badge', 'done', 'Complete');
    log('Pipeline complete.', 'log-ok');
  } else if (stage === 'cancelled') {
    const lastUpPct = parseInt($('pct-upscaling')?.textContent) || 0;
    setStage('upscaling',   lastUpPct, 'Cancelled', 'cancelled');
    setStage('compressing', 0,         'Cancelled', 'cancelled');
    setBadge('pipeline-status-badge', 'cancelled', 'Cancelled');
    log('Pipeline cancelled by user.', 'log-warn');
    pipelineRunning = false;
    $('btn-start').disabled = false;
    $('btn-cancel').classList.add('hidden');
  }
}

function onPipelineDone(data) {
  pipelineRunning = false;
  $('btn-start').disabled = false;
  $('btn-cancel').classList.add('hidden');
  if (data) updateStats(scannedImages.length, data.upscaledCount || 0, data.compressedCount || 0, data.savedPct);
}

// Stage helpers
function setStage(id, pct, msg, pillClass) {
  const bar = $(`bar-${id}`);
  const msgEl = $(`msg-${id}`);
  const pctEl = $(`pct-${id}`);
  const badge = $(`badge-${id}`);

  pct = Math.min(100, Math.max(0, pct));
  bar.style.width = pct + '%';
  msgEl.textContent = msg;
  pctEl.textContent = pct.toFixed(0) + '%';

  bar.classList.remove('animating', 'done', 'error', 'cancelled');
  if (pillClass === 'run') {
    bar.classList.add('animating');
    badge.className = 'stage-pill pill-run';
    badge.textContent = 'Running';
  } else if (pillClass === 'done') {
    bar.classList.add('done');
    badge.className = 'stage-pill pill-done';
    badge.textContent = 'Done';
  } else if (pillClass === 'error') {
    bar.classList.add('error');
    badge.className = 'stage-pill pill-error';
    badge.textContent = 'Error';
  } else if (pillClass === 'cancelled') {
    bar.classList.add('cancelled');
    badge.className = 'stage-pill pill-cancelled';
    badge.textContent = 'Cancelled';
  } else {
    badge.className = 'stage-pill pill-wait';
    badge.textContent = 'Waiting';
  }
}
function resetStage(id, label = 'Waiting') {
  setStage(id, 0, id === 'compressing' ? 'Waiting for upscaling...' : 'Waiting to start...', 'wait');
}
function setBadge(id, type, label) {
  const el = $(id);
  if (!el) return;
  el.className = 'status-badge ' + type;
  el.textContent = label;
}

// Stats
function updateStats(input, upscaled, compressed, savedPct) {
  $('stat-input').textContent = numFmt(input);
  $('stat-upscaled').textContent = numFmt(upscaled);
  $('stat-compressed').textContent = numFmt(compressed);
  $('stat-saved').textContent = savedPct !== null && savedPct !== undefined ? savedPct + '%' : '—';
}

function updateOutputPathDisplays() {
  if (!appPaths.upscaled) return;
  $('path-upscaled-display').textContent = appPaths.upscaled;
  $('path-compressed-display').textContent = appPaths.compressed;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function populateSettingsForm() {
  // Model + GPU are loaded dynamically by loadModels/loadGpus — don't override here
  $('set-upscayl-scale').value   = settings.upscaylScale   || '4';
  $('set-upscayl-format').value  = settings.upscaylFormat  || 'png';
  $('set-upscayl-tile').value    = settings.upscaylTileSize || '0';
  $('set-upscayl-tta').checked   = settings.upscaylTta     || false;

  $('set-caesium-quality').value = settings.caesiumQuality !== undefined ? settings.caesiumQuality : 82;
  $('set-caesium-quality-val').textContent = $('set-caesium-quality').value;
  $('set-caesium-format').value  = settings.caesiumFormat  || 'same';
  $('set-caesium-lossless').checked = settings.caesiumLossless || false;
  $('set-caesium-meta').checked  = settings.caesiumKeepMeta || false;

  $('set-upscayl-bin-path').value = settings.upscaylBinPath || '';
  $('set-caesium-bin-path').value = settings.caesiumBinPath  || '';
  $('set-models-path').value      = settings.modelsPath      || '';
  $('set-upscaled-path').value    = settings.upscaledPath    || '';
  $('set-compressed-path').value  = settings.compressedPath  || '';

  const accent = settings.accentColor || '#6366f1';
  $('set-accent-color').value          = accent;
  $('set-accent-preview').textContent  = accent;
}

async function onSaveSettings() {
  const s = {
    upscaylModel:    $('set-upscayl-model').value,
    upscaylScale:    $('set-upscayl-scale').value,
    upscaylFormat:   $('set-upscayl-format').value,
    upscaylGpu:      $('set-upscayl-gpu').value,
    upscaylTileSize: $('set-upscayl-tile').value,
    upscaylTta:      $('set-upscayl-tta').checked,
    caesiumQuality:  parseInt($('set-caesium-quality').value),
    caesiumFormat:   $('set-caesium-format').value,
    caesiumLossless: $('set-caesium-lossless').checked,
    caesiumKeepMeta: $('set-caesium-meta').checked,
    upscaylBinPath:  $('set-upscayl-bin-path').value,
    caesiumBinPath:  $('set-caesium-bin-path').value,
    modelsPath:      $('set-models-path').value,
    upscaledPath:    $('set-upscaled-path').value,
    compressedPath:  $('set-compressed-path').value,
    accentColor:     $('set-accent-color').value,
  };
  await window.pixelforge.saveSettings(s);
  settings = { ...settings, ...s };
  appPaths = await window.pixelforge.getAppPaths();
  updateOutputPathDisplays();

  const btn = $('btn-save-settings');
  const orig = btn.innerHTML;
  btn.innerHTML = '<svg width="13" height="13"><use href="#ic-check"/></svg> Saved';
  btn.disabled = true;
  setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1800);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
