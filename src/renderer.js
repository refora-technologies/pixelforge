'use strict';

let queue = [];
let pathCounts = {};
let scannedImages = [];
const IMG_EXT_RE = /\.(jpg|jpeg|png|webp|bmp|tiff|tif)$/i;
const isImagePath = (p) => IMG_EXT_RE.test(p);
const GALLERY_LIMIT = 120;
let pipelineRunning = false;
let pipelineMode = 'both';
let outputMode = 'replace';
let settings = {};
let appPaths = {};
let lastResults = [];
let lastRunDir = '';
let lastUpdate = null;
let pipelineStart = 0;
let elapsedTimer = null;
let scanToken = 0;
let cmpPos = 50;
let cmpFullscreen = false;

const $ = (id) => document.getElementById(id);
const numFmt = (n) => Number(n).toLocaleString();

function byteFmt(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function fileUrl(p) {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/'));
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
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

// ─── Sliding indicators ─────────────────────────────────────────────────────
// Segmented controls and the sidebar nav share one moving pill instead of
// re-painting a background on each item, so the highlight travels between them.
function initSegmented() {
  document.querySelectorAll('.segmented').forEach(seg => {
    if (seg.querySelector('.seg-indicator')) return;
    const ind = document.createElement('span');
    ind.className = 'seg-indicator';
    seg.insertBefore(ind, seg.firstChild);
  });
}

function syncSegmented(seg) {
  if (!seg) return;
  const ind = seg.querySelector('.seg-indicator');
  const active = seg.querySelector('.seg-btn.active');
  if (!ind) return;
  if (!active) { ind.classList.remove('ready'); return; }
  const segRect = seg.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  if (!segRect.width) return;
  const borderLeft = parseFloat(getComputedStyle(seg).borderLeftWidth) || 0;
  ind.style.width = btnRect.width + 'px';
  ind.style.transform = `translateX(${btnRect.left - segRect.left - borderLeft}px)`;
  ind.classList.add('ready');
}

function syncAllSegmented() {
  document.querySelectorAll('.segmented').forEach(syncSegmented);
}

function syncNavIndicator() {
  const list = $('nav-list'), ind = $('nav-indicator');
  if (!list || !ind) return;
  const active = list.querySelector('.nav-item.active');
  if (!active) { ind.classList.remove('ready'); return; }
  ind.style.height = active.offsetHeight + 'px';
  ind.style.transform = `translateY(${active.offsetTop}px)`;
  ind.classList.add('ready');
}

// ─── Range inputs ───────────────────────────────────────────────────────────
// --pct drives the filled portion of the track via a gradient.
function initRanges() {
  document.querySelectorAll('input.ctrl-range').forEach(r => {
    const upd = () => {
      const min = parseFloat(r.min) || 0;
      const max = parseFloat(r.max) || 100;
      const pct = max > min ? ((parseFloat(r.value) - min) / (max - min)) * 100 : 0;
      r.style.setProperty('--pct', pct + '%');
    };
    r.addEventListener('input', upd);
    r._pfSync = upd;
    upd();
  });
}
function syncRanges() {
  document.querySelectorAll('input.ctrl-range').forEach(r => r._pfSync && r._pfSync());
}

// ─── Custom select ──────────────────────────────────────────────────────────
// The native <select> stays in the DOM as the source of truth so existing
// .value reads keep working; only its presentation is replaced.
let openSelect = null;

function enhanceSelects() {
  document.querySelectorAll('select.ctrl-select').forEach(enhanceSelect);
}

function enhanceSelect(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'sel';
  if (sel.style.minWidth) wrap.style.minWidth = sel.style.minWidth;
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('sel-native');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sel-trigger';
  trigger.innerHTML = '<span class="sel-value"></span><svg class="sel-chev" width="14" height="14"><use href="#ic-chevron"/></svg>';
  wrap.appendChild(trigger);

  sel._pfSync = () => {
    const opt = sel.options[sel.selectedIndex];
    trigger.querySelector('.sel-value').textContent = opt ? opt.textContent : '';
  };
  sel._pfSync();

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openSelect && openSelect.sel === sel) closeSelectMenu();
    else openSelectMenu(sel, trigger);
  });
}

function syncSelects() {
  document.querySelectorAll('select.ctrl-select').forEach(s => s._pfSync && s._pfSync());
}

function openSelectMenu(sel, trigger) {
  closeSelectMenu();
  const menu = document.createElement('div');
  menu.className = 'sel-menu';
  Array.from(sel.options).forEach((opt, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sel-opt' + (i === sel.selectedIndex ? ' selected' : '');
    b.innerHTML = '<span class="sel-opt-label"></span><svg class="sel-check" width="13" height="13"><use href="#ic-check"/></svg>';
    b.querySelector('.sel-opt-label').textContent = opt.textContent;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      sel.selectedIndex = i;
      sel._pfSync();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      closeSelectMenu();
    });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);

  const place = () => {
    const r = trigger.getBoundingClientRect();
    // Scrolling the trigger out of sight would strand the menu off-screen.
    if (r.bottom < 0 || r.top > window.innerHeight) { closeSelectMenu(); return; }
    const needed = Math.min(288, menu.scrollHeight + 8);
    const below = window.innerHeight - r.bottom;
    const flip = below < needed && r.top > below;
    menu.classList.toggle('flip-up', flip);
    const width = Math.max(r.width, Math.min(400, menu.scrollWidth + 10));
    menu.style.width = width + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + 'px';
    if (flip) { menu.style.top = 'auto'; menu.style.bottom = (window.innerHeight - r.top + 5) + 'px'; }
    else { menu.style.bottom = 'auto'; menu.style.top = (r.bottom + 5) + 'px'; }
  };
  place();
  trigger.classList.add('open');
  menu.querySelector('.sel-opt.selected')?.scrollIntoView({ block: 'nearest' });

  const onDoc = (e) => { if (!menu.contains(e.target) && !trigger.contains(e.target)) closeSelectMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSelectMenu(); } };
  document.addEventListener('mousedown', onDoc);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  $('content').addEventListener('scroll', place, true);

  openSelect = { sel, trigger, menu, onDoc, onKey, place };
}

function closeSelectMenu() {
  if (!openSelect) return;
  const { trigger, menu, onDoc, onKey, place } = openSelect;
  document.removeEventListener('mousedown', onDoc);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  $('content').removeEventListener('scroll', place, true);
  trigger.classList.remove('open');
  menu.remove();
  openSelect = null;
}

// ─── Toasts ─────────────────────────────────────────────────────────────────
function toast(message, type = 'info', ms = 3400) {
  const stack = $('toast-stack');
  if (!stack) return;
  const icon = type === 'success' ? '#ic-check' : type === 'error' ? '#ic-warn' : '#ic-info';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="toast-icon"><svg width="15" height="15"><use href="${icon}"/></svg></span><span class="toast-text"></span>`;
  el.querySelector('.toast-text').textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  }, ms);
}

// ─── Init ───────────────────────────────────────────────────────────────────
// Wiring happens before any data loads so the window is interactive
// immediately — model and GPU lookups can take seconds and must not block it.
async function init() {
  initSegmented();
  enhanceSelects();
  initRanges();

  wireTitlebar();
  wireNav();
  wireDashboard();
  wireSettings();
  wireUpdates();
  wireCompareModal();
  wireShortcuts();
  wireExternalLinks();

  window.addEventListener('resize', () => { syncAllSegmented(); syncNavIndicator(); });

  window.pixelforge.onPipelineProgress(onPipelineProgress);
  window.pixelforge.onPipelineDone(onPipelineDone);
  window.pixelforge.onUpdateAvailable(onUpdateAvailable);
  window.pixelforge.onMaximizedChanged(setMaximizeIcon);

  settings = await window.pixelforge.getSettings();
  applyTheme(settings.theme || 'dark');
  applyAccentColor(settings.accentColor || '#6366f1');
  pipelineMode = settings.pipelineMode || 'both';
  outputMode = settings.outputMode === 'keep' ? 'keep' : 'replace';
  populateSettingsForm();
  setMode(pipelineMode);
  setOutputMode(outputMode);
  syncNavIndicator();

  if (settings.restoreSession && Array.isArray(settings.savedInputQueue) && settings.savedInputQueue.length) {
    addPaths(settings.savedInputQueue, true);
  }

  runSetupCheck(false);

  window.pixelforge.getAppPaths().then(p => { appPaths = p; updateOutputPathDisplays(); });
  window.pixelforge.getAppVersion().then(v => {
    $('sidebar-version').textContent = `PixelForge v${v}`;
    $('about-version').textContent = `v${v}`;
    $('upd-current').textContent = `v${v}`;
  });
  loadModels(settings.upscaylModel);
  loadGpus(settings.upscaylGpu);
}

// ─── Titlebar / nav ─────────────────────────────────────────────────────────
function wireTitlebar() {
  $('btn-minimize').addEventListener('click', () => window.pixelforge.minimize());
  $('btn-maximize').addEventListener('click', () => window.pixelforge.maximize());
  $('btn-close').addEventListener('click', () => window.pixelforge.close());
  window.pixelforge.isMaximized().then(setMaximizeIcon);
}
function setMaximizeIcon(isMax) {
  const use = $('maximize-icon');
  if (use) use.setAttribute('href', isMax ? '#ic-restore' : '#ic-square');
}
function wireNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(item.dataset.page); }
    });
  });
}
function navigateTo(page) {
  closeSelectMenu();
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  $(`page-${page}`)?.classList.add('active');
  $('content').scrollTop = 0;
  syncNavIndicator();
  // The newly shown page was display:none, so its controls had no geometry yet.
  requestAnimationFrame(syncAllSegmented);
}
function wireExternalLinks() {
  document.querySelectorAll('[data-link]').forEach(el => {
    el.addEventListener('click', () => window.pixelforge.openExternal(el.dataset.link));
  });
}
function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    const compareOpen = !$('compare-modal').classList.contains('hidden');
    if (compareOpen && !e.ctrlKey && !e.altKey) {
      // Escape steps out of fullscreen before it closes the viewer.
      if (e.key === 'Escape') { cmpFullscreen ? toggleCompareFullscreen(false) : closeCompare(); return; }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleCompareFullscreen(); return; }
    }
    if (!e.ctrlKey || e.altKey || e.shiftKey) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    const key = e.key.toLowerCase();
    if (key === 'enter') { e.preventDefault(); if (!$('btn-start').disabled) onStartPipeline(); }
    else if (key === 'o' && !typing) { e.preventDefault(); onBrowse(); }
    else if (key === 'i' && !typing) { e.preventDefault(); onAddImages(); }
    else if (key === '1') { e.preventDefault(); navigateTo('dashboard'); }
    else if (key === '2') { e.preventDefault(); navigateTo('settings'); }
    else if (key === '3') { e.preventDefault(); navigateTo('about'); }
  });
}

// ─── Theme / accent ─────────────────────────────────────────────────────────
function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', value);
  document.querySelectorAll('#theme-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === value));
  syncSegmented($('theme-seg'));
  try { localStorage.setItem('pf.theme', value); } catch {}
}
function applyAccentColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-hover', shadeHex(hex, -20));
  root.setProperty('--accent-muted', `rgba(${r},${g},${b},0.12)`);
  root.setProperty('--accent-glow', `rgba(${r},${g},${b},0.18)`);
  root.setProperty('--border-accent', `rgba(${r},${g},${b},0.4)`);
  try { localStorage.setItem('pf.accent', hex); } catch {}
}
function shadeHex(hex, amt) {
  const c = [1, 3, 5].map(i => Math.min(255, Math.max(0, parseInt(hex.slice(i, i + 2), 16) + amt)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

// ─── Models / GPUs ──────────────────────────────────────────────────────────
async function loadModels(currentModel) {
  const sel = $('set-upscayl-model');
  if (!sel) return;
  try {
    const models = await window.pixelforge.listModels();
    sel.innerHTML = '';
    const list = models.length ? models : [{ id: 'upscayl-standard-4x', name: 'Upscayl Standard 4x (Recommended)' }];
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id; opt.textContent = m.name;
      sel.appendChild(opt);
    }
    if (currentModel) sel.value = currentModel;
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
    sel._pfSync?.();
  } catch (e) { console.error('loadModels', e); }
}

// "auto" stays selected rather than being silently rewritten to a device id —
// the main process resolves the dedicated GPU at run time.
async function loadGpus(currentGpu, opts) {
  const sel = $('set-upscayl-gpu');
  if (!sel) return;
  try {
    const gpus = await window.pixelforge.listGpus(opts);
    const dedicated = gpus.find(g => !g.isIntegrated);
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = dedicated ? `Auto-detect — ${dedicated.name}` : 'Auto-detect (Recommended)';
    sel.appendChild(auto);
    for (const g of gpus) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `GPU ${g.id}: ${g.name}${g.vramLabel ? ' (' + g.vramLabel + ')' : ''}${g.isIntegrated ? ' — Integrated' : ' — Dedicated'}`;
      sel.appendChild(opt);
    }
    sel.value = currentGpu && gpus.some(g => g.id === String(currentGpu)) ? String(currentGpu) : 'auto';
    sel._pfSync?.();
    return gpus;
  } catch (e) { console.error('loadGpus', e); return []; }
}

// ─── Setup overlay ──────────────────────────────────────────────────────────
async function runSetupCheck(isManualRecheck = false) {
  if (!settings.setupDone || isManualRecheck) $('setup-overlay').style.display = 'flex';

  const result = await window.pixelforge.checkSetup();
  const upOk = result.upscaylOk && result.modelsOk;
  const csOk = result.caesiumOk;
  setBadge('pipeline-status-badge', (upOk && csOk) ? 'ready' : 'error', (upOk && csOk) ? 'Ready' : 'Setup Needed');

  if (settings.setupDone && !isManualRecheck) { hideSetupOverlay(); return; }
  $('setup-overlay').style.display = 'flex';
  $('setup-step-check').classList.remove('hidden');
  $('setup-step-download').classList.add('hidden');

  updateDepRow('dep-upscayl', 'dep-upscayl-status', upOk);
  updateDepRow('dep-caesium', 'dep-caesium-status', csOk);

  if (upOk && csOk) {
    $('setup-info-text').textContent = result.upscaylDetected
      ? 'Upscayl installation auto-detected. All dependencies ready.'
      : 'All dependencies found. Ready to launch.';
    $('setup-actions').style.display = 'none';
    $('setup-all-ok').classList.remove('hidden');
    $('btn-enter-app').onclick = hideSetupOverlay;
  } else {
    const missing = [];
    if (!upOk) missing.push('Upscayl engine binary');
    if (!csOk) missing.push('Caesium CLT');
    $('setup-info-text').innerHTML =
      `<strong>Missing dependencies:</strong><br/>${missing.map(m => '&bull; ' + m).join('<br/>')}` +
      `<br/><br/>PixelForge will download and install these automatically into its app-data folder.` +
      `<br/><br/><span style="color:var(--text-3);font-size:11px;">Estimated download: ~25 MB (AI models are bundled)</span>`;
    $('setup-actions').style.display = 'flex';
    $('setup-all-ok').classList.add('hidden');
    $('btn-start-download').onclick = () => startDownload(result);
    $('btn-skip-setup').onclick = hideSetupOverlay;
  }
}
function updateDepRow(rowId, statusId, ok) {
  $(rowId).className = 'dep-row ' + (ok ? 'dep-ok' : 'dep-missing');
  $(statusId).innerHTML = `<svg width="16" height="16"><use href="#${ok ? 'ic-check' : 'ic-warn'}"/></svg>`;
}
function showSetupOverlay(recheck) {
  $('setup-overlay').style.display = 'flex';
  $('setup-step-check').classList.remove('hidden');
  $('setup-step-download').classList.add('hidden');
  if (recheck) runSetupCheck(true);
}
function hideSetupOverlay() {
  $('setup-overlay').style.display = 'none';
  window.pixelforge.saveSettings({ setupDone: true });
  window.pixelforge.getSettings().then(async s => {
    settings = s;
    loadModels(s.upscaylModel);
    loadGpus(s.upscaylGpu);
  });
  window.pixelforge.getAppPaths().then(p => { appPaths = p; updateOutputPathDisplays(); });
  window.pixelforge.checkSetup().then(r => {
    const ok = r.upscaylOk && r.modelsOk && r.caesiumOk;
    setBadge('pipeline-status-badge', ok ? 'ready' : 'error', ok ? 'Ready' : 'Setup Needed');
  });
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
    } else if (data.stage === 'upscayl') {
      $('dl-upscayl-bar').style.width = (data.percent || 0) + '%';
      $('dl-upscayl-pct').textContent = (data.percent || 0) + '%';
      $('dl-upscayl-status').textContent = data.message || '';
      if (data.status === 'done') { $('dl-upscayl-status').className = 'dl-status ok'; $('dl-upscayl-bar').classList.add('done'); }
    } else if (data.stage === 'complete') {
      $('dl-done-wrap').classList.remove('hidden');
      $('btn-dl-enter').onclick = hideSetupOverlay;
    } else if (data.stage === 'error') {
      $('dl-error-msg').classList.remove('hidden');
      $('dl-error-text').textContent = 'Download failed: ' + data.message;
    }
  });

  const result = await window.pixelforge.downloadDeps(down);
  if (!result.success) {
    $('dl-error-msg').classList.remove('hidden');
    $('dl-error-text').textContent = 'Download failed: ' + (result.error || 'Unknown error');
  }
}

// ─── Dashboard ──────────────────────────────────────────────────────────────
function wireDashboard() {
  $('btn-browse').addEventListener('click', onBrowse);
  $('btn-browse-files').addEventListener('click', onAddImages);
  $('btn-scan').addEventListener('click', scanAll);
  $('btn-clear-queue').addEventListener('click', clearQueue);
  $('btn-start').addEventListener('click', onStartPipeline);
  $('btn-pause').addEventListener('click', onPause);
  $('btn-resume').addEventListener('click', onResume);
  $('btn-cancel').addEventListener('click', onCancel);
  $('btn-open-upscaled').addEventListener('click', () => window.pixelforge.openFolder(appPaths.upscaled));
  $('btn-open-compressed').addEventListener('click', () => window.pixelforge.openFolder(appPaths.compressed));
  $('btn-open-run').addEventListener('click', () => {
    const target = lastRunDir || appPaths.compressed || appPaths.upscaled;
    if (target) window.pixelforge.openFolder(target);
  });

  document.querySelectorAll('#mode-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
    setMode(b.dataset.mode);
    window.pixelforge.saveSettings({ pipelineMode: pipelineMode });
  }));

  const dz = $('dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', onDrop);
}

function setMode(mode) {
  pipelineMode = mode;
  document.querySelectorAll('#mode-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  syncSegmented($('mode-seg'));
}

function setOutputMode(mode) {
  outputMode = mode === 'keep' ? 'keep' : 'replace';
  document.querySelectorAll('#output-mode-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.outmode === outputMode));
  syncSegmented($('output-mode-seg'));
  $('output-mode-desc').textContent = outputMode === 'keep'
    ? 'Every run lands in its own timestamped folder'
    : 'Each run replaces the last one';
}

async function onBrowse() {
  const folders = await window.pixelforge.selectFolders();
  if (folders && folders.length) addPaths(folders, true);
}
async function onAddImages() {
  const files = await window.pixelforge.selectImages();
  if (files && files.length) addPaths(files, true);
}
function onDrop(e) {
  e.preventDefault();
  $('dropzone').classList.remove('dragover');
  const items = e.dataTransfer.items;
  const dropped = [];
  let rejected = 0;
  for (let i = 0; i < e.dataTransfer.files.length; i++) {
    const p = e.dataTransfer.files[i].path;
    if (!p) continue;
    const entry = items[i] && items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) dropped.push(p);
    else if (isImagePath(p)) dropped.push(p);
    else rejected++;
  }
  if (rejected) toast(`Skipped ${rejected} unsupported file${rejected !== 1 ? 's' : ''}`, 'info');
  if (dropped.length) addPaths(dropped, true);
}

function persistQueue() {
  // Only remembered when the user opted in — otherwise every launch is clean.
  window.pixelforge.saveSettings({ savedInputQueue: settings.restoreSession ? queue.slice() : [] });
}
function addPaths(items, doScan = true) {
  let added = 0;
  for (const p of items) if (p && !queue.includes(p)) { queue.push(p); added++; }
  renderQueue();
  updateInputDisplay();
  persistQueue();
  if (items.length && !added) toast('Already in the queue', 'info');
  if (doScan) scanAll();
}
function removePath(target) {
  queue = queue.filter(p => p !== target);
  renderQueue();
  updateInputDisplay();
  persistQueue();
  scanAll();
}
function clearQueue() {
  if (!queue.length) return;
  const n = queue.length;
  queue = [];
  pathCounts = {};
  scannedImages = [];
  renderQueue();
  updateInputDisplay();
  persistQueue();
  scanAll();
  toast(`Cleared ${n} item${n !== 1 ? 's' : ''}`, 'success');
}
function updateInputDisplay() {
  const el = $('input-path-display');
  if (!queue.length) { el.textContent = 'No images or folder selected'; el.classList.remove('filled'); $('btn-scan').disabled = true; return; }
  el.classList.add('filled');
  el.textContent = queue.length === 1 ? queue[0] : `${queue.length} items selected`;
  $('btn-scan').disabled = false;
}
function renderQueue() {
  const card = $('queue-card'), list = $('queue-list');
  if (!queue.length) { card.classList.add('hidden'); list.innerHTML = ''; return; }
  card.classList.remove('hidden');
  $('queue-count').textContent = `${queue.length} item${queue.length !== 1 ? 's' : ''}`;
  list.innerHTML = '';
  for (const p of queue) {
    const isFile = isImagePath(p);
    const name = p.replace(/[\\/]$/, '').split(/[\\/]/).pop();
    const count = pathCounts[p];
    const meta = isFile ? 'Image' : `Folder${count !== undefined ? ` · ${count} image${count !== 1 ? 's' : ''}` : ''}`;
    const item = document.createElement('div');
    item.className = 'queue-item' + (!isFile && count === 0 ? ' is-empty' : '');
    item.title = p;
    item.innerHTML =
      `<span class="queue-item-icon"><svg width="16" height="16"><use href="#${isFile ? 'ic-image' : 'ic-folder'}"/></svg></span>` +
      `<div class="queue-item-info"><div class="queue-item-name">${escapeHtml(name)}</div>` +
      `<div class="queue-item-meta">${escapeHtml(meta)}</div></div>` +
      `<button class="queue-item-remove" title="Remove from queue"><svg width="14" height="14"><use href="#ic-trash"/></svg></button>`;
    item.querySelector('.queue-item-remove').addEventListener('click', () => removePath(p));
    list.appendChild(item);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function scanAll() {
  if (!queue.length) {
    scannedImages = [];
    $('scan-results-card').classList.add('hidden');
    $('btn-start').disabled = true;
    $('stats-row').classList.add('hidden');
    return;
  }
  const btn = $('btn-scan');
  const token = ++scanToken;
  btn.disabled = true;
  const r = await window.pixelforge.scanInputs(queue, settings.recursive);
  if (token !== scanToken) return;
  pathCounts = r.perPath || {};
  const all = r.images || [];
  scannedImages = all;
  btn.disabled = false;
  renderQueue();

  if (!all.length) {
    $('scan-results-card').classList.add('hidden');
    $('btn-start').disabled = true;
    $('stats-row').classList.add('hidden');
    toast('No supported images found in the selection', 'error');
    return;
  }

  $('scan-count').textContent = numFmt(all.length);
  const totalSize = all.reduce((a, img) => a + img.size, 0);
  $('scan-size-text').textContent = `Total size: ${byteFmt(totalSize)}`;
  const types = {};
  all.forEach(img => { const ext = (img.ext || '.?').replace('.', '').toUpperCase(); types[ext] = (types[ext] || 0) + 1; });
  $('scan-type-pills').innerHTML = Object.entries(types).map(([ext, n]) => `<span class="type-pill">${ext} (${n})</span>`).join('');
  $('scan-results-card').classList.remove('hidden');
  $('btn-start').disabled = pipelineRunning;
  updateStats(all.length, 0, 0, null);
  $('stats-row').classList.remove('hidden');
}

// ─── Pipeline run ───────────────────────────────────────────────────────────
async function onStartPipeline() {
  if (!queue.length || !scannedImages.length || pipelineRunning) return;
  setRunningUI(true, false);
  $('progress-card').classList.remove('hidden');
  $('results-card').classList.add('hidden');
  $('pipeline-log').innerHTML = '';

  resetStage('upscaling');
  resetStage('compressing');
  if (pipelineMode === 'upscale') setStageSkipped('compressing');
  if (pipelineMode === 'compress') setStageSkipped('upscaling');

  setBadge('pipeline-status-badge', 'running', 'Processing…');
  startElapsed();
  log(`Pipeline started — ${scannedImages.length} images, mode: ${pipelineMode}`, 'log-hl');

  try {
    const s = await window.pixelforge.getSettings();
    s.pipelineMode = pipelineMode;
    const result = await window.pixelforge.startPipeline({ queue, settings: s });
    // pipelineRunning is still true only when no progress event reported the
    // failure first — otherwise this would surface the same error twice.
    if (result && !result.success && !result.cancelled && pipelineRunning) {
      log('Error: ' + (result.error || 'Unknown error'), 'log-err');
      toast(result.error || 'Pipeline failed', 'error', 6000);
      finishRun('error');
    }
  } catch (err) {
    log('Error: ' + err.message, 'log-err');
    toast(err.message, 'error', 6000);
    finishRun('error');
  }
}
async function onPause() { await window.pixelforge.pausePipeline(); setRunningUI(true, true); setBadge('pipeline-status-badge', 'paused', 'Paused'); log('Paused — finishing current step…', 'log-warn'); }
async function onResume() { await window.pixelforge.resumePipeline(); setRunningUI(true, false); setBadge('pipeline-status-badge', 'running', 'Processing…'); log('Resumed.', 'log-hl'); }
async function onCancel() { await window.pixelforge.cancelPipeline(); log('Cancelling…', 'log-warn'); }

function setRunningUI(running, paused) {
  pipelineRunning = running;
  $('btn-start').disabled = running || !scannedImages.length;
  $('btn-pause').classList.toggle('hidden', !running || paused);
  $('btn-resume').classList.toggle('hidden', !running || !paused);
  $('btn-cancel').classList.toggle('hidden', !running);
  $('btn-clear-queue').disabled = running;
  $('btn-scan').disabled = running || !queue.length;
}

function onPipelineProgress(data) {
  const { stage, percent = 0, message = '', status, current } = data;
  if (data.elapsedMs !== undefined) updateTiming(data.elapsedMs, data.etaMs, data.throughput);

  if (stage === 'upscaling') {
    setStage('upscaling', percent, message, status === 'done' ? 'done' : 'run');
    if (current !== undefined) { updateStats(scannedImages.length, current, undefined, null); if (current > 0) log(message); }
    if (status === 'done') log(message, 'log-ok');
  } else if (stage === 'compressing') {
    setStage('compressing', percent, message, status === 'done' ? 'done' : 'run');
    if (current !== undefined) updateStats(scannedImages.length, undefined, current, null);
    if (status === 'done') log(message, 'log-ok');
  } else if (stage === 'complete') {
    if (pipelineMode !== 'compress') setStage('upscaling', 100, 'Complete', 'done');
    if (pipelineMode !== 'upscale') setStage('compressing', 100, 'Complete', 'done');
    setBadge('pipeline-status-badge', 'done', 'Complete');
    log('Pipeline complete.', 'log-ok');
  } else if (stage === 'cancelled') {
    const up = parseInt($('pct-upscaling')?.textContent) || 0;
    setStage('upscaling', up, 'Cancelled', 'cancelled');
    setStage('compressing', 0, 'Cancelled', 'cancelled');
    setBadge('pipeline-status-badge', 'cancelled', 'Cancelled');
    log('Pipeline cancelled.', 'log-warn');
    toast('Pipeline cancelled', 'info');
    finishRun('cancelled');
  } else if (stage === 'error') {
    setBadge('pipeline-status-badge', 'error', 'Error');
    log('Error: ' + message, 'log-err');
    toast(message, 'error', 6000);
    finishRun('error');
  }
}

function onPipelineDone(result) {
  finishRun('done');
  lastResults = result.results || [];
  lastRunDir = result.compressedDir || result.upscaledDir || '';
  updateStats(scannedImages.length, result.upscaledCount || 0, result.compressedCount || 0, result.savedPct);
  renderGallery(lastResults);

  const done = result.compressedCount || result.upscaledCount || 0;
  const saved = result.savedPct ? ` · saved ${result.savedPct}%` : '';
  toast(`Finished ${done} image${done !== 1 ? 's' : ''} in ${fmtDuration(result.durationMs)}${saved}`, 'success', 5200);
  if (settings.soundOnComplete) playChime();
}

function finishRun(kind) {
  setRunningUI(false, false);
  stopElapsed();
  if (kind === 'error') setBadge('pipeline-status-badge', 'error', 'Error');
}

// ─── Timing ─────────────────────────────────────────────────────────────────
function startElapsed() {
  pipelineStart = Date.now();
  $('timing-elapsed').textContent = '0:00';
  $('timing-eta').textContent = '—';
  $('timing-rate').textContent = '—';
  stopElapsed();
  elapsedTimer = setInterval(() => { $('timing-elapsed').textContent = fmtDuration(Date.now() - pipelineStart); }, 500);
}
function stopElapsed() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }
function updateTiming(elapsedMs, etaMs, throughput) {
  if (elapsedMs !== undefined && !elapsedTimer) $('timing-elapsed').textContent = fmtDuration(elapsedMs);
  $('timing-eta').textContent = etaMs && etaMs > 0 ? fmtDuration(etaMs) : '—';
  $('timing-rate').textContent = throughput && throughput > 0 ? (throughput * 60).toFixed(1) : '—';
}

// ─── Stage helpers ──────────────────────────────────────────────────────────
function setStage(id, pct, msg, pillClass) {
  const bar = $(`bar-${id}`), msgEl = $(`msg-${id}`), pctEl = $(`pct-${id}`), badge = $(`badge-${id}`);
  pct = Math.min(100, Math.max(0, pct));
  bar.style.width = pct + '%';
  if (msg) msgEl.textContent = msg;
  pctEl.textContent = pct.toFixed(0) + '%';
  bar.classList.remove('animating', 'done', 'error', 'cancelled');
  const map = { run: ['animating', 'pill-run', 'Running'], done: ['done', 'pill-done', 'Done'], error: ['error', 'pill-error', 'Error'], cancelled: ['cancelled', 'pill-cancelled', 'Cancelled'], wait: ['', 'pill-wait', 'Waiting'] };
  const [cls, pill, label] = map[pillClass] || map.wait;
  if (cls) bar.classList.add(cls);
  badge.className = 'stage-pill ' + pill;
  badge.textContent = label;
}
function resetStage(id) { setStage(id, 0, id === 'compressing' ? 'Waiting for upscaling…' : 'Waiting to start…', 'wait'); }
function setStageSkipped(id) {
  const badge = $(`badge-${id}`), msgEl = $(`msg-${id}`);
  badge.className = 'stage-pill pill-wait';
  badge.textContent = 'Skipped';
  msgEl.textContent = 'Not part of this run';
}
function setBadge(id, type, label) { const el = $(id); if (el) { el.className = 'status-badge ' + type; el.textContent = label; } }

function updateStats(input, upscaled, compressed, savedPct) {
  if (input !== undefined) $('stat-input').textContent = numFmt(input);
  if (upscaled !== undefined) $('stat-upscaled').textContent = numFmt(upscaled);
  if (compressed !== undefined) $('stat-compressed').textContent = numFmt(compressed);
  if (savedPct !== null && savedPct !== undefined) $('stat-saved').textContent = savedPct + '%';
}
function updateOutputPathDisplays() {
  if (!appPaths.upscaled) return;
  $('path-upscaled-display').textContent = appPaths.upscaled;
  $('path-compressed-display').textContent = appPaths.compressed;
}

// ─── Gallery + compare ──────────────────────────────────────────────────────
function renderGallery(results) {
  const grid = $('gallery-grid');
  const more = $('gallery-more');
  grid.innerHTML = '';
  const items = (results || []).filter(r => r.upscaled || r.compressed);
  if (!items.length) { $('results-card').classList.add('hidden'); return; }
  $('results-card').classList.remove('hidden');

  for (const r of items.slice(0, GALLERY_LIMIT)) {
    const thumb = r.compressed || r.upscaled || r.original;
    const openTarget = r.compressed || r.upscaled;
    const name = String(thumb).split(/[\\/]/).pop();
    const canCompare = r.original && r.upscaled && r.original !== r.upscaled;

    const tile = document.createElement('div');
    tile.className = 'gallery-tile';
    tile.title = name;
    tile.innerHTML =
      `<img loading="lazy" src="${fileUrl(thumb)}" alt=""/>` +
      `<div class="gallery-tile-overlay"><div class="gallery-tile-name">${escapeHtml(name)}</div>` +
      `<div class="gallery-actions">` +
      (canCompare ? `<button class="gallery-action" data-act="compare" title="Compare"><svg width="14" height="14"><use href="#ic-compare"/></svg></button>` : '') +
      `<button class="gallery-action" data-act="open" title="Open"><svg width="14" height="14"><use href="#ic-external"/></svg></button>` +
      `<button class="gallery-action" data-act="reveal" title="Show in folder"><svg width="14" height="14"><use href="#ic-folder-open"/></svg></button>` +
      `</div></div>`;

    tile.querySelector('[data-act="open"]').addEventListener('click', (e) => { e.stopPropagation(); window.pixelforge.openFile(openTarget); });
    tile.querySelector('[data-act="reveal"]').addEventListener('click', (e) => { e.stopPropagation(); window.pixelforge.showInFolder(openTarget); });
    const cmpBtn = tile.querySelector('[data-act="compare"]');
    if (cmpBtn) cmpBtn.addEventListener('click', (e) => { e.stopPropagation(); openCompare(r.original, r.upscaled, name); });
    tile.addEventListener('click', () => canCompare ? openCompare(r.original, r.upscaled, name) : window.pixelforge.openFile(openTarget));
    grid.appendChild(tile);
  }

  if (items.length > GALLERY_LIMIT) {
    more.textContent = `Showing the first ${GALLERY_LIMIT} of ${numFmt(items.length)} results — open the output folder to see them all.`;
    more.classList.remove('hidden');
  } else {
    more.classList.add('hidden');
  }
}

function wireCompareModal() {
  $('compare-close').addEventListener('click', closeCompare);
  $('compare-expand').addEventListener('click', () => toggleCompareFullscreen());
  $('compare-modal').addEventListener('click', (e) => { if (e.target.id === 'compare-modal') closeCompare(); });
  $('cmp-range').addEventListener('input', (e) => setCmpPos(parseFloat(e.target.value)));
  $('cmp').addEventListener('dblclick', () => toggleCompareFullscreen());
  // Images arrive async and the frame resizes with the window — both change
  // where the labels sit relative to the divider.
  $('cmp-img-base').addEventListener('load', () => setCmpPos(cmpPos));
  window.addEventListener('resize', () => {
    if (!$('compare-modal').classList.contains('hidden')) setCmpPos(cmpPos);
  });
}

// The base image fills the frame and shows through on the right; the clipped
// overlay sits on top and reveals the original on the left-hand side.
function openCompare(original, upscaled, name) {
  $('compare-title').textContent = name ? `Before / After — ${name}` : 'Before / After';
  $('cmp-img-base').src = fileUrl(upscaled);
  $('cmp-img-overlay').src = fileUrl(original);
  $('compare-modal').classList.remove('hidden');
  setCmpPos(50);
  requestAnimationFrame(() => setCmpPos(50));
}

function closeCompare() {
  $('compare-modal').classList.add('hidden');
  toggleCompareFullscreen(false);
  $('cmp-img-base').src = '';
  $('cmp-img-overlay').src = '';
}

function toggleCompareFullscreen(force) {
  cmpFullscreen = force === undefined ? !cmpFullscreen : force;
  $('compare-card').classList.toggle('is-fullscreen', cmpFullscreen);
  $('compare-expand-icon').setAttribute('href', cmpFullscreen ? '#ic-collapse' : '#ic-expand');
  $('compare-expand').title = cmpFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
  requestAnimationFrame(() => setCmpPos(cmpPos));
}

function setCmpPos(p) {
  p = Math.min(100, Math.max(0, p));
  cmpPos = p;
  $('cmp-clip').style.clipPath = `inset(0 ${100 - p}% 0 0)`;
  $('cmp-divider').style.left = p + '%';
  $('cmp-handle').style.left = p + '%';
  $('cmp-range').value = p;
  updateCmpTags(p);
}

// A side's label is only truthful while that side is still on screen, so each
// one hides once the divider sweeps past it.
function updateCmpTags(p) {
  const width = $('cmp').clientWidth;
  if (!width) return;
  const original = $('cmp-tag-original');
  const upscaled = $('cmp-tag-upscaled');
  const inset = 11; // matches .cmp-tag left/right in the stylesheet
  const originalEdge = ((inset + original.offsetWidth) / width) * 100;
  const upscaledEdge = 100 - ((inset + upscaled.offsetWidth) / width) * 100;
  original.classList.toggle('is-hidden', p < originalEdge);
  upscaled.classList.toggle('is-hidden', p > upscaledEdge);
}

// ─── Sound ──────────────────────────────────────────────────────────────────
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [880, 1174.66];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.13;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {}
}

// ─── Settings ───────────────────────────────────────────────────────────────
function wireSettings() {
  $('btn-save-settings').addEventListener('click', onSaveSettings);
  $('set-caesium-quality').addEventListener('input', () => { $('set-caesium-quality-val').textContent = $('set-caesium-quality').value; });
  $('set-accent-color').addEventListener('input', () => { const v = $('set-accent-color').value; $('set-accent-preview').textContent = v; applyAccentColor(v); });
  document.querySelectorAll('#theme-seg .seg-btn').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
  document.querySelectorAll('#output-mode-seg .seg-btn').forEach(b => b.addEventListener('click', () => setOutputMode(b.dataset.outmode)));
  $('set-recursive').addEventListener('change', () => { settings.recursive = $('set-recursive').checked; });

  const browse = (btnId, inputId, isFolder) => $(btnId).addEventListener('click', async () => {
    const f = isFolder ? await window.pixelforge.selectFolder() : await window.pixelforge.selectFile([{ name: 'Executable', extensions: ['exe'] }]);
    if (f) $(inputId).value = f;
  });
  browse('btn-browse-upscayl-bin', 'set-upscayl-bin-path', false);
  browse('btn-browse-caesium-bin', 'set-caesium-bin-path', false);
  browse('btn-browse-models', 'set-models-path', true);
  browse('btn-browse-upscaled', 'set-upscaled-path', true);
  browse('btn-browse-compressed', 'set-compressed-path', true);

  $('btn-rerun-setup').addEventListener('click', () => showSetupOverlay(true));
  $('btn-open-logs').addEventListener('click', () => window.pixelforge.openLogs());
  $('btn-refresh-gpus').addEventListener('click', onRefreshGpus);
  $('btn-reset-settings').addEventListener('click', onResetSettings);
  $('btn-about-updates').addEventListener('click', () => { navigateTo('settings'); doCheckUpdates(true); });
}

async function onRefreshGpus() {
  const btn = $('btn-refresh-gpus');
  btn.disabled = true;
  const gpus = await loadGpus($('set-upscayl-gpu').value, { force: true });
  btn.disabled = false;
  toast(gpus.length ? `Detected ${gpus.length} GPU${gpus.length !== 1 ? 's' : ''}` : 'No GPUs detected', gpus.length ? 'success' : 'error');
}

async function onResetSettings() {
  if (!window.confirm('Reset all settings to their defaults?\n\nYour input queue and installed dependencies are not affected.')) return;
  settings = await window.pixelforge.resetSettings();
  applyTheme(settings.theme);
  applyAccentColor(settings.accentColor);
  setMode(settings.pipelineMode || 'both');
  setOutputMode(settings.outputMode);
  populateSettingsForm();
  await loadModels(settings.upscaylModel);
  await loadGpus(settings.upscaylGpu);
  appPaths = await window.pixelforge.getAppPaths();
  updateOutputPathDisplays();
  toast('Settings reset to defaults', 'success');
}

function populateSettingsForm() {
  $('set-upscayl-scale').value = settings.upscaylScale || '4';
  $('set-upscayl-format').value = settings.upscaylFormat || 'png';
  $('set-upscayl-tile').value = settings.upscaylTileSize || '0';
  $('set-upscayl-tta').checked = !!settings.upscaylTta;
  $('set-caesium-quality').value = settings.caesiumQuality !== undefined ? settings.caesiumQuality : 82;
  $('set-caesium-quality-val').textContent = $('set-caesium-quality').value;
  $('set-caesium-format').value = settings.caesiumFormat || 'same';
  $('set-caesium-lossless').checked = !!settings.caesiumLossless;
  $('set-caesium-meta').checked = !!settings.caesiumKeepMeta;
  $('set-upscayl-bin-path').value = settings.upscaylBinPath || '';
  $('set-caesium-bin-path').value = settings.caesiumBinPath || '';
  $('set-models-path').value = settings.modelsPath || '';
  $('set-upscaled-path').value = settings.upscaledPath || '';
  $('set-compressed-path').value = settings.compressedPath || '';
  $('set-recursive').checked = !!settings.recursive;
  $('set-naming').value = settings.namingTemplate || '{name}';
  $('set-notify').checked = settings.notifyOnComplete !== false;
  $('set-sound').checked = !!settings.soundOnComplete;
  $('set-autoupdate').checked = settings.autoCheckUpdates !== false;
  $('set-restore-session').checked = !!settings.restoreSession;
  $('set-confirm-exit').checked = settings.confirmOnExit !== false;
  const accent = settings.accentColor || '#6366f1';
  $('set-accent-color').value = accent;
  $('set-accent-preview').textContent = accent;
  syncSelects();
  syncRanges();
}

async function onSaveSettings() {
  const theme = document.querySelector('#theme-seg .seg-btn.active')?.dataset.theme || 'dark';
  const recursiveChanged = !!settings.recursive !== $('set-recursive').checked;
  const s = {
    upscaylModel: $('set-upscayl-model').value,
    upscaylScale: $('set-upscayl-scale').value,
    upscaylFormat: $('set-upscayl-format').value,
    upscaylGpu: $('set-upscayl-gpu').value,
    upscaylTileSize: $('set-upscayl-tile').value,
    upscaylTta: $('set-upscayl-tta').checked,
    caesiumQuality: parseInt($('set-caesium-quality').value),
    caesiumFormat: $('set-caesium-format').value,
    caesiumLossless: $('set-caesium-lossless').checked,
    caesiumKeepMeta: $('set-caesium-meta').checked,
    upscaylBinPath: $('set-upscayl-bin-path').value,
    caesiumBinPath: $('set-caesium-bin-path').value,
    modelsPath: $('set-models-path').value,
    upscaledPath: $('set-upscaled-path').value,
    compressedPath: $('set-compressed-path').value,
    accentColor: $('set-accent-color').value,
    theme,
    recursive: $('set-recursive').checked,
    namingTemplate: $('set-naming').value || '{name}',
    notifyOnComplete: $('set-notify').checked,
    soundOnComplete: $('set-sound').checked,
    autoCheckUpdates: $('set-autoupdate').checked,
    outputMode,
    restoreSession: $('set-restore-session').checked,
    confirmOnExit: $('set-confirm-exit').checked,
  };
  await window.pixelforge.saveSettings(s);
  settings = { ...settings, ...s };
  persistQueue();
  appPaths = await window.pixelforge.getAppPaths();
  updateOutputPathDisplays();
  if (recursiveChanged && queue.length) scanAll();

  const btn = $('btn-save-settings');
  const orig = btn.innerHTML;
  btn.innerHTML = '<svg width="13" height="13"><use href="#ic-check"/></svg> Saved';
  btn.disabled = true;
  setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1600);
  toast('Settings saved', 'success');
}

// ─── Updates ────────────────────────────────────────────────────────────────
function wireUpdates() {
  $('btn-check-updates').addEventListener('click', () => doCheckUpdates(true));
  $('btn-download-update').addEventListener('click', doDownloadUpdate);
  $('btn-run-installer').addEventListener('click', () => lastUpdate?.path && window.pixelforge.runInstaller(lastUpdate.path));
  $('update-banner-dismiss').addEventListener('click', () => $('update-banner').classList.add('hidden'));
  $('update-banner-btn').addEventListener('click', () => { $('update-banner').classList.add('hidden'); navigateTo('settings'); if (lastUpdate) presentUpdate(lastUpdate); });
}
async function doCheckUpdates(showStatus) {
  const btn = $('btn-check-updates');
  const icon = btn.querySelector('svg');
  if (icon) icon.classList.add('spin');
  const result = await window.pixelforge.checkUpdates();
  if (icon) icon.classList.remove('spin');

  if (!result.ok) {
    if (showStatus) showUpdateStatus('error', 'Could not check for updates: ' + (result.error || 'network error'));
    return;
  }
  lastUpdate = result;
  if (result.hasUpdate) {
    presentUpdate(result);
  } else {
    if (showStatus) showUpdateStatus('success', `You're on the latest version (v${result.current}).`);
    $('upd-download-wrap').classList.add('hidden');
  }
}
function presentUpdate(result) {
  showUpdateStatus('info', `Version ${result.latest} is available (you have ${result.current}).`);
  $('upd-download-wrap').classList.remove('hidden');
  $('upd-asset-name').textContent = result.assetName || 'PixelForge Setup';
  $('btn-download-update').classList.remove('hidden');
  $('btn-run-installer').classList.add('hidden');
  $('upd-dl-bar').style.width = '0%';
  $('upd-dl-pct').textContent = '0%';
}
function showUpdateStatus(type, text) {
  $('upd-status-wrap').classList.remove('hidden');
  $('upd-status').className = 'alert alert-' + (type === 'error' ? 'error' : type === 'success' ? 'success' : 'info');
  $('upd-status-text').textContent = text;
}
async function doDownloadUpdate() {
  if (!lastUpdate?.assetUrl) { showUpdateStatus('error', 'No installer asset found for this release.'); return; }
  $('btn-download-update').disabled = true;
  window.pixelforge.removeAllListeners('update-progress');
  window.pixelforge.onUpdateProgress((d) => {
    $('upd-dl-bar').style.width = (d.percent || 0) + '%';
    $('upd-dl-pct').textContent = (d.percent || 0) + '%';
  });
  const res = await window.pixelforge.downloadUpdate({ assetUrl: lastUpdate.assetUrl, assetName: lastUpdate.assetName });
  $('btn-download-update').disabled = false;
  if (res.success) {
    lastUpdate.path = res.path;
    $('upd-dl-bar').classList.add('done');
    showUpdateStatus('success', 'Download complete. Run the installer to update.');
    $('btn-run-installer').classList.remove('hidden');
  } else {
    showUpdateStatus('error', 'Download failed: ' + (res.error || 'unknown error'));
  }
}
function onUpdateAvailable(result) {
  lastUpdate = result;
  $('update-banner-title').textContent = `PixelForge ${result.latest} is available`;
  $('update-banner-sub').textContent = `You're on v${result.current}. Update from Settings.`;
  $('update-banner').classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', init);
