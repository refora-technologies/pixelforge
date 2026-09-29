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
let lastLoggedProgress = '';
let runPaused = false;
let lastProgress = null;

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
  box.appendChild(line); // .log-line is block-level — a <br> here double-spaced every entry
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
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = sel.closest('.set-row')?.querySelector('.set-label')?.textContent.trim();
  if (label) trigger.setAttribute('aria-label', label);
  trigger.innerHTML = '<span class="sel-value"></span><svg class="sel-chev" width="14" height="14" aria-hidden="true"><use href="#ic-chevron"/></svg>';
  wrap.appendChild(trigger);

  sel._pfSync = () => {
    const opt = sel.options[sel.selectedIndex];
    trigger.querySelector('.sel-value').textContent = opt ? opt.textContent : '';
  };
  sel._pfSync();

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openSelect && openSelect.sel === sel) closeSelectMenu(true);
    else openSelectMenu(sel, trigger);
  });
  // Same keys a native <select> answers to.
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openSelectMenu(sel, trigger);
    }
  });
}

function syncSelects() {
  document.querySelectorAll('select.ctrl-select').forEach(s => s._pfSync && s._pfSync());
}

function openSelectMenu(sel, trigger) {
  closeSelectMenu(false);
  const menu = document.createElement('div');
  menu.className = 'sel-menu';
  menu.setAttribute('role', 'listbox');
  if (trigger.getAttribute('aria-label')) menu.setAttribute('aria-label', trigger.getAttribute('aria-label'));

  const choose = (i) => {
    sel.selectedIndex = i;
    sel._pfSync();
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    closeSelectMenu(true);
  };

  const options = Array.from(sel.options).map((opt, i) => {
    const el = document.createElement('div');
    const selected = i === sel.selectedIndex;
    el.className = 'sel-opt' + (selected ? ' selected' : '');
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(selected));
    el.tabIndex = -1;
    el.innerHTML = '<span class="sel-opt-label"></span><svg class="sel-check" width="13" height="13" aria-hidden="true"><use href="#ic-check"/></svg>';
    el.querySelector('.sel-opt-label').textContent = opt.textContent;
    el.addEventListener('click', (e) => { e.stopPropagation(); choose(i); });
    // Pointer and keyboard share one highlight: hovering moves focus.
    el.addEventListener('mousemove', () => { if (document.activeElement !== el) el.focus({ preventScroll: true }); });
    menu.appendChild(el);
    return el;
  });

  const focusAt = (i) => {
    const target = options[Math.max(0, Math.min(options.length - 1, i))];
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  };

  menu.addEventListener('keydown', (e) => {
    const current = options.indexOf(document.activeElement);
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(current + 1); break;
      case 'ArrowUp':   e.preventDefault(); focusAt(current - 1); break;
      case 'Home':      e.preventDefault(); focusAt(0); break;
      case 'End':       e.preventDefault(); focusAt(options.length - 1); break;
      case 'PageDown':  e.preventDefault(); focusAt(current + 5); break;
      case 'PageUp':    e.preventDefault(); focusAt(current - 5); break;
      case 'Enter':
      case ' ':         e.preventDefault(); if (current >= 0) choose(current); break;
      case 'Escape':    e.preventDefault(); e.stopPropagation(); closeSelectMenu(true); break;
      // Hand focus back first so Tab continues from the trigger, not the menu.
      case 'Tab':       closeSelectMenu(true); break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const key = e.key.toLowerCase();
          const order = [...options.slice(current + 1), ...options.slice(0, current + 1)];
          const hit = order.find(o => o.textContent.trim().toLowerCase().startsWith(key));
          if (hit) focusAt(options.indexOf(hit));
        }
    }
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
  trigger.setAttribute('aria-expanded', 'true');
  focusAt(Math.max(0, sel.selectedIndex));

  const onDoc = (e) => { if (!menu.contains(e.target) && !trigger.contains(e.target)) closeSelectMenu(false); };
  document.addEventListener('mousedown', onDoc);
  window.addEventListener('resize', place);
  $('content').addEventListener('scroll', place, true);

  openSelect = { sel, trigger, menu, onDoc, place };
}

function closeSelectMenu(restoreFocus = false) {
  if (!openSelect) return;
  const { trigger, menu, onDoc, place } = openSelect;
  openSelect = null;
  document.removeEventListener('mousedown', onDoc);
  window.removeEventListener('resize', place);
  $('content').removeEventListener('scroll', place, true);
  trigger.classList.remove('open');
  trigger.setAttribute('aria-expanded', 'false');
  menu.remove();
  if (restoreFocus) trigger.focus();
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
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) setCmpPos(cmpPos + dir * 5); else stepCompare(dir);
        return;
      }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCompareBy(1.5); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomCompareBy(1 / 1.5); return; }
      if (e.key === '0') { e.preventDefault(); compareFit(); return; }
      if (e.key === '1') { e.preventDefault(); compareActual(); return; }
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
let currentAccent = '#6366f1';

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', value);
  document.querySelectorAll('#theme-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === value));
  syncSegmented($('theme-seg'));
  applyAccentColor(currentAccent); // accent text shades depend on the theme
  try { localStorage.setItem('pf.theme', value); } catch {}
}

const hexChannels = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = (channels) => '#' + channels.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
function mixHex(a, b, t) {
  const x = hexChannels(a), y = hexChannels(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}
function luminance(hex) {
  const [r, g, b] = hexChannels(hex).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Derives every accent token from the one colour the user picks, for the active
// theme, so any accent keeps text readable (WCAG AA) on and around it.
function applyAccentColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) hex = '#6366f1';
  currentAccent = hex;
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';

  // Solid accent surfaces: keep white text by deepening the fill slightly; a
  // very light accent (yellow, mint) switches to dark text instead.
  let fill = hex;
  let onAccent = '#ffffff';
  for (let amt = 0; contrastRatio('#ffffff', fill) < 4.5 && amt <= 60; amt += 4) fill = shadeHex(hex, -amt);
  if (contrastRatio('#ffffff', fill) < 4.5) { fill = hex; onAccent = '#0b0b12'; }

  // Accent-coloured text on panels: lighten (dark theme) or deepen (light theme)
  // until it reads against the busiest panel shade.
  const panel = dark ? '#16161f' : '#f7f8fc';
  const toward = dark ? '#ffffff' : '#000000';
  let soft = mixHex(hex, toward, dark ? 0.35 : 0.1);
  for (let t = dark ? 0.35 : 0.1; contrastRatio(soft, panel) < 4.5 && t < 0.95; t += 0.05) soft = mixHex(hex, toward, t);

  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-rgb', hexChannels(hex).join(', '));
  root.setProperty('--accent-fill', fill);
  root.setProperty('--on-accent', onAccent);
  root.setProperty('--accent-hover', shadeHex(fill, -16));
  root.setProperty('--accent-soft', soft);
  try { localStorage.setItem('pf.accent', hex); } catch {}
}
function shadeHex(hex, amt) {
  return toHex(hexChannels(hex).map(v => v + amt));
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
    refreshIdleDock(); // the summary names the model
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
  // Reset every bar — this also runs again from "Try Again".
  for (const id of ['caesium', 'upscayl']) {
    $(`dl-${id}-bar`).style.width = '0%';
    $(`dl-${id}-bar`).classList.remove('done');
    $(`dl-${id}-pct`).textContent = '0%';
    $(`dl-${id}-status`).textContent = 'Waiting…';
    $(`dl-${id}-status`).className = 'dl-status';
  }
  $('dl-caesium-wrap').classList.toggle('hidden', !down.downloadCaesium);
  $('dl-upscayl-wrap').classList.toggle('hidden', !down.downloadUpscayl);

  // A failed download used to leave no button at all — the only way out was to
  // quit the app. Retry re-checks first, so finished parts aren't fetched twice.
  $('btn-dl-retry').onclick = async () => startDownload(await window.pixelforge.checkSetup());
  $('btn-dl-back').onclick = () => showSetupOverlay(true);

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
  const openRun = () => {
    const target = lastRunDir || appPaths.compressed || appPaths.upscaled;
    if (target) window.pixelforge.openFolder(target);
  };
  $('btn-open-run').addEventListener('click', openRun);
  $('btn-dock-open').addEventListener('click', openRun);

  document.querySelectorAll('#mode-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
    if (pipelineRunning) return;
    setMode(b.dataset.mode);
    window.pixelforge.saveSettings({ pipelineMode: pipelineMode });
    refreshIdleDock(true);
  }));

  wireWindowDrop();
}

// Files can be dropped anywhere on the window, not just the drop zone. Without a
// document-level handler, a drop elsewhere makes Chromium open the file in
// place of the app.
function wireWindowDrop() {
  const dz = $('dropzone');
  let depth = 0;
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const clear = () => { depth = 0; document.body.classList.remove('drag-active'); dz.classList.remove('dragover'); };

  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (depth++ === 0 && !pipelineRunning) { document.body.classList.add('drag-active'); dz.classList.add('dragover'); }
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = pipelineRunning || !isFileDrag(e) ? 'none' : 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    if (--depth <= 0) clear();
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    clear();
    if (pipelineRunning) { toast('Wait for the current run to finish before adding more.', 'info'); return; }
    if (isFileDrag(e)) onDrop(e);
  });
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
  refreshIdleDock();
}

async function onBrowse() {
  if (pipelineRunning) { toast('Wait for the current run to finish before adding more.', 'info'); return; }
  const folders = await window.pixelforge.selectFolders();
  if (folders && folders.length) addPaths(folders, true);
}
async function onAddImages() {
  if (pipelineRunning) { toast('Wait for the current run to finish before adding more.', 'info'); return; }
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
// The input card is a large drop target until something is queued, then
// collapses to a compact row so the queue gets the room.
function updateInputDisplay() {
  const el = $('input-path-display');
  $('dropzone').dataset.empty = String(!queue.length);
  if (!queue.length) { el.textContent = 'No images or folder selected'; el.classList.remove('filled'); $('btn-scan').disabled = true; return; }
  el.classList.add('filled');
  el.textContent = queue.length === 1 ? queue[0] : `${queue.length} items selected`;
  $('btn-scan').disabled = pipelineRunning;
}

// The queue chip carries what a separate "scan results" card used to: image
// count and size, with the per-format breakdown on hover.
function updateQueueChip() {
  const chip = $('queue-count');
  if (!scannedImages.length) {
    chip.textContent = `${queue.length} item${queue.length !== 1 ? 's' : ''}`;
    chip.removeAttribute('title');
    return;
  }
  const n = scannedImages.length;
  const size = scannedImages.reduce((a, img) => a + img.size, 0);
  const types = {};
  for (const img of scannedImages) { const ext = (img.ext || '.?').replace('.', '').toUpperCase(); types[ext] = (types[ext] || 0) + 1; }
  chip.textContent = `${numFmt(n)} image${n !== 1 ? 's' : ''} · ${byteFmt(size)}`;
  chip.title = Object.entries(types).map(([ext, count]) => `${ext} ${count}`).join(' · ');
}

function renderQueue() {
  const card = $('queue-card'), list = $('queue-list');
  if (!queue.length) { card.classList.add('hidden'); list.innerHTML = ''; return; }
  card.classList.remove('hidden');
  updateQueueChip();
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
    const remove = item.querySelector('.queue-item-remove');
    remove.disabled = pipelineRunning;
    remove.setAttribute('aria-label', `Remove ${name} from the queue`);
    remove.addEventListener('click', () => { if (!pipelineRunning) removePath(p); });
    list.appendChild(item);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function scanAll() {
  if (!queue.length) {
    scannedImages = [];
    $('btn-start').disabled = true;
    $('stats-row').classList.add('hidden');
    refreshIdleDock(true);
    return;
  }
  const btn = $('btn-scan');
  const token = ++scanToken;
  btn.disabled = true;
  btn.classList.add('is-busy');
  $('queue-count').textContent = 'Scanning…';
  const r = await window.pixelforge.scanInputs(queue, settings.recursive);
  if (token !== scanToken) return;
  pathCounts = r.perPath || {};
  const all = r.images || [];
  scannedImages = all;
  btn.disabled = pipelineRunning;
  btn.classList.remove('is-busy');
  renderQueue();

  if (!all.length) {
    $('btn-start').disabled = true;
    $('stats-row').classList.add('hidden');
    toast('No supported images found in the selection', 'error');
    refreshIdleDock(true);
    return;
  }

  $('btn-start').disabled = pipelineRunning;
  // Stats describe a run; a row of zeros before anything has run is just noise.
  if (!pipelineRunning) $('stats-row').classList.add('hidden');
  refreshIdleDock(true);
}

// ─── Run dock ───────────────────────────────────────────────────────────────
// One always-visible bar that says what will happen, what is happening, and
// what just happened. It owns the Start / Pause / Resume / Cancel buttons.
const MODE_LABELS = { both: 'Upscale + Compress', upscale: 'Upscale only', compress: 'Compress only' };
// Matches the taskbar weighting in main.js: upscaling is most of the run time.
const STAGE_WEIGHTS = {
  both: { upscaling: [0, 0.85], compressing: [0.85, 0.15] },
  upscale: { upscaling: [0, 1] },
  compress: { compressing: [0, 1] },
};

function runFraction(data) {
  if (data.stage === 'complete') return 1;
  const span = (STAGE_WEIGHTS[pipelineMode] || STAGE_WEIGHTS.both)[data.stage];
  return span ? span[0] + span[1] * Math.min(1, (data.percent || 0) / 100) : null;
}

function modelLabel() {
  const opt = $('set-upscayl-model')?.selectedOptions?.[0];
  return (opt?.textContent || settings.upscaylModel || '').replace(/\s*\([^)]*\)\s*$/, '');
}

function runSummary() {
  const parts = [MODE_LABELS[pipelineMode] || MODE_LABELS.both];
  if (pipelineMode !== 'compress') parts.push(`${modelLabel()} · ${settings.upscaylScale || 4}× ${String(settings.upscaylFormat || 'png').toUpperCase()}`);
  if (pipelineMode !== 'upscale') parts.push(settings.caesiumLossless ? 'Lossless' : `Quality ${settings.caesiumQuality ?? 82}`);
  parts.push(outputMode === 'keep' ? 'Keeps previous results' : 'Replaces previous results');
  return parts.join(' · ');
}

function setDock(state, { title, meta = '', sub = '', subHtml = null, progress = null } = {}) {
  $('run-dock').dataset.state = state;
  $('dock-title').textContent = title;
  $('dock-meta').textContent = meta;
  if (subHtml !== null) $('dock-sub').innerHTML = subHtml;
  else $('dock-sub').textContent = sub;
  if (progress !== null) $('dock-bar').style.width = `${Math.round(progress * 1000) / 10}%`;

  const active = state === 'running' || state === 'paused';
  $('btn-start').classList.toggle('hidden', active);
  $('btn-pause').classList.toggle('hidden', state !== 'running');
  $('btn-resume').classList.toggle('hidden', state !== 'paused');
  $('btn-cancel').classList.toggle('hidden', !active);
  $('btn-dock-open').classList.toggle('hidden', state !== 'done' || !lastRunDir);
  $('btn-start-label').textContent = state === 'done' ? 'Run again' : 'Start';
}

// The resting state, derived from the queue. Doesn't overwrite a run's outcome
// until the queue or the run settings change.
function refreshIdleDock(force = false) {
  if (pipelineRunning) return;
  const state = $('run-dock').dataset.state;
  if (!force && ['done', 'cancelled', 'error'].includes(state)) return;
  if (!queue.length) {
    setDock('empty', { title: 'Add images to get started', sub: 'Drop folders or images anywhere in this window, or use Folder and Images above.', progress: 0 });
    return;
  }
  if (!scannedImages.length) {
    setDock('empty', { title: 'No supported images found', sub: 'PixelForge works with JPG, PNG, WebP, BMP and TIFF images.', progress: 0 });
    return;
  }
  const n = scannedImages.length;
  const size = scannedImages.reduce((a, img) => a + img.size, 0);
  setDock('ready', {
    title: `${numFmt(n)} image${n !== 1 ? 's' : ''} ready`,
    meta: byteFmt(size),
    subHtml: `${escapeHtml(runSummary())} · <button class="dock-link" id="dock-change">Change</button>`,
    progress: 0,
  });
  $('dock-change').onclick = () => navigateTo('settings');
}

function updateRunDock(data) {
  if (!pipelineRunning || !data) return;
  const fraction = runFraction(data);
  const count = data.total ? `${numFmt(Math.min(data.current || 0, data.total))} of ${numFmt(data.total)}` : '';
  if (runPaused) {
    setDock('paused', { title: 'Paused', meta: count, sub: 'Picks up from the next batch when you resume.', progress: fraction });
    return;
  }
  const upscaling = data.stage !== 'compressing';
  const steps = pipelineMode === 'both' ? `Step ${upscaling ? 1 : 2} of 2 · ` : '';
  const detail = upscaling
    ? `${modelLabel()} · ${settings.upscaylScale || 4}×`
    : (settings.caesiumLossless ? 'Lossless' : `Quality ${settings.caesiumQuality ?? 82}`);
  const eta = data.etaMs > 0 ? ` · ${fmtDuration(data.etaMs)} left` : '';
  setDock('running', {
    title: upscaling ? 'Upscaling' : 'Compressing',
    meta: count + eta,
    sub: steps + detail,
    progress: fraction,
  });
}

function renderIssues(result) {
  const box = $('results-issues');
  const failures = result.failures || [];
  if (!failures.length) { box.classList.add('hidden'); return; }
  const n = failures.length;
  $('issues-title').textContent = `${n} image${n !== 1 ? 's' : ''} couldn't be processed`;
  const list = $('issues-list');
  list.innerHTML = '';
  for (const f of failures.slice(0, 100)) {
    const li = document.createElement('li');
    li.title = `${f.path}\n${f.reason}`;
    const name = document.createElement('span');
    name.className = 'issue-name';
    name.textContent = f.path.split(/[\\/]/).pop();
    const reason = document.createElement('span');
    reason.className = 'issue-reason';
    reason.textContent = f.reason;
    li.append(name, reason);
    list.appendChild(li);
  }
  if (n > 100) {
    const li = document.createElement('li');
    li.textContent = `…and ${numFmt(n - 100)} more. The log has the full list.`;
    list.appendChild(li);
  }
  $('btn-issues-log').onclick = () => (result.logPath ? window.pixelforge.openFile(result.logPath) : window.pixelforge.openLogs());
  box.classList.remove('hidden');
  $('results-card').classList.remove('hidden');
}

// ─── Pipeline run ───────────────────────────────────────────────────────────
async function onStartPipeline() {
  if (!queue.length || !scannedImages.length || pipelineRunning) return;
  setRunningUI(true, false);
  lastLoggedProgress = '';
  lastProgress = null;
  $('progress-card').classList.remove('hidden');
  $('results-card').classList.add('hidden');
  $('results-issues').classList.add('hidden');
  $('pipeline-log').innerHTML = '';

  resetStage('upscaling');
  resetStage('compressing');
  if (pipelineMode === 'upscale') setStageSkipped('compressing');
  if (pipelineMode === 'compress') setStageSkipped('upscaling');
  updateStats(scannedImages.length, 0, 0, null);
  $('stat-saved').textContent = '—';
  $('stats-row').classList.remove('hidden');

  setBadge('pipeline-status-badge', 'running', 'Processing…');
  setDock('running', { title: 'Starting…', meta: '', sub: runSummary(), progress: 0 });
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
      finishRun('error', result.error);
    }
  } catch (err) {
    log('Error: ' + err.message, 'log-err');
    toast(err.message, 'error', 6000);
    finishRun('error', err.message);
  }
}
async function onPause() {
  await window.pixelforge.pausePipeline();
  setRunningUI(true, true);
  setBadge('pipeline-status-badge', 'paused', 'Paused');
  log('Pausing after the current batch…', 'log-warn');
  updateRunDock(lastProgress || { stage: 'upscaling', percent: 0 });
}
async function onResume() {
  await window.pixelforge.resumePipeline();
  setRunningUI(true, false);
  setBadge('pipeline-status-badge', 'running', 'Processing…');
  log('Resumed.', 'log-hl');
  updateRunDock(lastProgress || { stage: 'upscaling', percent: 0 });
}
async function onCancel() {
  await window.pixelforge.cancelPipeline();
  log('Cancelling…', 'log-warn');
  $('dock-title').textContent = 'Cancelling…';
}

// While a run is going its inputs are fixed — the running job has its own copy,
// so edits here would silently do nothing.
function setRunningUI(running, paused) {
  pipelineRunning = running;
  runPaused = !!paused;
  document.body.classList.toggle('is-running', running);
  $('btn-start').disabled = running || !scannedImages.length;
  for (const id of ['btn-browse', 'btn-browse-files', 'btn-clear-queue']) $(id).disabled = running;
  document.querySelectorAll('#mode-seg .seg-btn, .queue-item-remove').forEach(b => { b.disabled = running; });
  $('btn-scan').disabled = running || !queue.length;
}

function onPipelineProgress(data) {
  const { stage, percent = 0, message = '', status, current } = data;
  // The final "complete" event carries no throughput; keep the last real figure.
  if (data.elapsedMs !== undefined && stage !== 'complete') updateTiming(data.elapsedMs, data.etaMs, data.throughput);
  if (stage === 'upscaling' || stage === 'compressing') { lastProgress = data; updateRunDock(data); }

  // `produced` counts files actually written; `current` also counts failures.
  const made = data.produced ?? current;
  if (stage === 'upscaling') {
    setStage('upscaling', percent, message, status === 'done' ? 'done' : 'run');
    if (made !== undefined) updateStats(scannedImages.length, made, undefined, null);
    if (status === 'done') log(message, 'log-ok');
    else if (current > 0 && message !== lastLoggedProgress) { log(message); lastLoggedProgress = message; }
  } else if (stage === 'compressing') {
    setStage('compressing', percent, message, status === 'done' ? 'done' : 'run');
    if (made !== undefined) updateStats(scannedImages.length, undefined, made, null);
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
    finishRun('error', message);
  }
}

function onPipelineDone(result) {
  lastResults = result.results || [];
  lastRunDir = result.compressedDir || result.upscaledDir || '';
  finishRun('done', result);
  updateStats(scannedImages.length, result.upscaledCount || 0, result.compressedCount || 0, null);
  // Compression can't shrink every file; "−3%" reads like a bug, "None" doesn't.
  $('stat-saved').textContent = result.savedPct == null ? '—' : result.savedPct > 0 ? `${result.savedPct}%` : 'None';
  // During a run the rate is per stage; once finished, the whole run's rate is
  // the honest number — compression alone is far faster than upscaling.
  const processed = Math.max(result.upscaledCount || 0, result.compressedCount || 0);
  if (processed && result.durationMs > 0) $('timing-rate').textContent = (processed / (result.durationMs / 60000)).toFixed(1);
  $('timing-eta').textContent = '—';
  renderGallery(lastResults);
  renderIssues(result);
  if (!$('results-card').classList.contains('hidden')) {
    $('results-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // The dock already says this on the dashboard; toast only when it's out of view.
  if (!$('page-dashboard').classList.contains('active')) {
    const done = result.compressedCount || result.upscaledCount || 0;
    const saved = result.savedPct > 0 ? ` · saved ${result.savedPct}%` : '';
    toast(`Finished ${done} image${done !== 1 ? 's' : ''} in ${fmtDuration(result.durationMs)}${saved}`, 'success', 5200);
  }
  if (result.failedCount) {
    for (const f of result.failures || []) log(`Failed: ${f.path.split(/[\\/]/).pop()} — ${f.reason}`, 'log-err');
  }
  if (settings.soundOnComplete) playChime();
}

function finishRun(kind, detail) {
  setRunningUI(false, false);
  stopElapsed();
  if (kind === 'error') setBadge('pipeline-status-badge', 'error', 'Error');

  if (kind === 'done') {
    const result = detail || {};
    const n = result.compressedCount || result.upscaledCount || 0;
    const failed = result.failedCount || 0;
    const folder = lastRunDir ? lastRunDir.split(/[\\/]/).filter(Boolean).slice(-2).join('\\') : 'the output folder';
    setDock('done', {
      title: `Finished ${numFmt(n)} image${n !== 1 ? 's' : ''} in ${fmtDuration(result.durationMs)}`,
      meta: result.savedPct > 0 ? `Saved ${result.savedPct}%` : '',
      sub: failed ? `${failed} couldn't be processed — details below.` : `Saved to ${folder}`,
      progress: 1,
    });
  } else if (kind === 'cancelled') {
    setDock('cancelled', { title: 'Run cancelled', sub: 'Anything finished before you cancelled is already in the output folder.', progress: 0 });
  } else if (kind === 'error') {
    setDock('error', { title: 'Run failed', sub: detail || 'Something went wrong. The log has details.', progress: 0 });
  }
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

  // The viewer steps through every comparable result, not just the tiles shown.
  cmpView.list = items
    .map(r => ({
      original: r.original,
      processed: r.upscaled || r.compressed,
      kind: r.upscaled ? 'Upscaled' : 'Compressed',
      name: String(r.compressed || r.upscaled).split(/[\\/]/).pop(),
    }))
    .filter(c => c.original && c.processed && c.original !== c.processed);

  for (const r of items.slice(0, GALLERY_LIMIT)) {
    // Compare against whatever this run made: the upscale when there is one,
    // otherwise the compressed file (a Compress-only quality check).
    const processed = r.upscaled || r.compressed;
    const kind = r.upscaled ? 'Upscaled' : 'Compressed';
    const thumb = r.compressed || r.upscaled;
    const openTarget = thumb;
    const name = String(thumb).split(/[\\/]/).pop();
    const canCompare = !!(r.original && processed && r.original !== processed);

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
    if (cmpBtn) cmpBtn.addEventListener('click', (e) => { e.stopPropagation(); openCompare(r.original, processed, name, kind); });
    tile.addEventListener('click', () => canCompare ? openCompare(r.original, processed, name, kind) : window.pixelforge.openFile(openTarget));
    grid.appendChild(tile);
  }

  if (items.length > GALLERY_LIMIT) {
    more.textContent = `Showing the first ${GALLERY_LIMIT} of ${numFmt(items.length)} results — open the output folder to see them all.`;
    more.classList.remove('hidden');
  } else {
    more.classList.add('hidden');
  }
}

// ─── Compare viewer ─────────────────────────────────────────────────────────
// Both images share one transform, so they stay pixel-aligned at any zoom. The
// divider and labels live in frame space, so the split still works zoomed in.
// Zoom is relative to "fit": 1 = whole image visible, 1/fit = actual pixels.
const cmpView = { list: [], index: 0, zoom: 1, tx: 0, ty: 0, natW: 0, natH: 0 };
const MAX_PIXEL_SCALE = 8; // 800% of the result's real pixels

function cmpFit() {
  const frame = $('cmp');
  if (!cmpView.natW || !frame.clientWidth) return 1;
  return Math.min(frame.clientWidth / cmpView.natW, frame.clientHeight / cmpView.natH);
}
function cmpZoomBounds() {
  const fit = cmpFit();
  return { min: Math.min(1, 1 / fit), max: Math.max(1, MAX_PIXEL_SCALE / fit) };
}

function layoutCompare() {
  const frame = $('cmp');
  const fw = frame.clientWidth, fh = frame.clientHeight;
  if (!cmpView.natW || !fw) return;
  const scale = cmpFit() * cmpView.zoom;
  const w = cmpView.natW * scale, h = cmpView.natH * scale;
  // Smaller than the frame: centre it. Larger: pan, but never past an edge.
  cmpView.tx = w <= fw ? (fw - w) / 2 : Math.min(0, Math.max(fw - w, cmpView.tx));
  cmpView.ty = h <= fh ? (fh - h) / 2 : Math.min(0, Math.max(fh - h, cmpView.ty));
  for (const img of [$('cmp-img-base'), $('cmp-img-overlay')]) {
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.transform = `translate(${cmpView.tx}px, ${cmpView.ty}px)`;
  }
  const zoomed = cmpView.zoom > 1.001;
  frame.classList.toggle('is-zoomed', zoomed);
  $('cmp-zoom-label').textContent = zoomed ? `${Math.round(scale * 100)}%` : 'Fit';
  const { min, max } = cmpZoomBounds();
  $('cmp-zoom-out').disabled = cmpView.zoom <= min + 0.001;
  $('cmp-zoom-in').disabled = cmpView.zoom >= max - 0.001;
}

// Zooms keeping the image point under (px, py) — frame coordinates — still.
function zoomCompareTo(zoom, px, py) {
  const frame = $('cmp');
  const { min, max } = cmpZoomBounds();
  const next = Math.min(max, Math.max(min, zoom));
  const cx = px ?? frame.clientWidth / 2, cy = py ?? frame.clientHeight / 2;
  const ratio = next / cmpView.zoom;
  cmpView.tx = cx - (cx - cmpView.tx) * ratio;
  cmpView.ty = cy - (cy - cmpView.ty) * ratio;
  cmpView.zoom = next;
  layoutCompare();
}
const zoomCompareBy = (factor) => zoomCompareTo(cmpView.zoom * factor);
const compareFit = () => zoomCompareTo(1);
const compareActual = () => zoomCompareTo(1 / cmpFit());

function wireCompareModal() {
  const frame = $('cmp');
  $('compare-close').addEventListener('click', closeCompare);
  $('compare-expand').addEventListener('click', () => toggleCompareFullscreen());
  $('compare-modal').addEventListener('click', (e) => { if (e.target.id === 'compare-modal') closeCompare(); });
  $('cmp-zoom-in').addEventListener('click', () => zoomCompareBy(1.5));
  $('cmp-zoom-out').addEventListener('click', () => zoomCompareBy(1 / 1.5));
  $('cmp-zoom-label').addEventListener('click', compareFit);
  $('cmp-actual').addEventListener('click', compareActual);
  $('cmp-prev').addEventListener('click', (e) => { e.stopPropagation(); stepCompare(-1); });
  $('cmp-next').addEventListener('click', (e) => { e.stopPropagation(); stepCompare(1); });
  frame.addEventListener('dblclick', (e) => { if (!e.target.closest('.cmp-nav')) toggleCompareFullscreen(); });

  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = frame.getBoundingClientRect();
    zoomCompareTo(cmpView.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // Near the divider: move it. Elsewhere: pan when zoomed, or jump the divider
  // to the pointer when not.
  let drag = null;
  const nearDivider = (x) => Math.abs(x - frame.clientWidth * cmpPos / 100) <= 18;
  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.cmp-nav')) return;
    const x = e.clientX - frame.getBoundingClientRect().left;
    if (cmpView.zoom > 1.001 && !nearDivider(x)) {
      drag = { mode: 'pan', x0: e.clientX, y0: e.clientY, tx0: cmpView.tx, ty0: cmpView.ty };
      frame.classList.add('is-panning');
    } else {
      drag = { mode: 'divider' };
      setCmpPos(x / frame.clientWidth * 100);
    }
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener('pointermove', (e) => {
    const x = e.clientX - frame.getBoundingClientRect().left;
    if (!drag) {
      frame.classList.toggle('near-divider', nearDivider(x));
      return;
    }
    if (drag.mode === 'pan') {
      cmpView.tx = drag.tx0 + (e.clientX - drag.x0);
      cmpView.ty = drag.ty0 + (e.clientY - drag.y0);
      layoutCompare();
    } else {
      setCmpPos(x / frame.clientWidth * 100);
    }
  });
  const endDrag = () => { drag = null; frame.classList.remove('is-panning'); };
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);

  // Natural size is only known once the result loads; the window can resize too.
  $('cmp-img-base').addEventListener('load', () => {
    const img = $('cmp-img-base');
    cmpView.natW = img.naturalWidth;
    cmpView.natH = img.naturalHeight;
    cmpView.zoom = 1;
    layoutCompare();
    setCmpPos(cmpPos);
  });
  window.addEventListener('resize', () => {
    if ($('compare-modal').classList.contains('hidden')) return;
    layoutCompare();
    setCmpPos(cmpPos);
  });
}

function showCompareItem() {
  const item = cmpView.list[cmpView.index];
  if (!item) return;
  const n = cmpView.list.length;
  $('compare-title').textContent = item.name ? `Before / After — ${item.name}` : 'Before / After';
  $('cmp-counter').textContent = n > 1 ? `${numFmt(cmpView.index + 1)} of ${numFmt(n)}` : '';
  $('cmp-tag-upscaled').textContent = item.kind;
  $('cmp-prev').disabled = cmpView.index === 0;
  $('cmp-next').disabled = cmpView.index >= n - 1;
  $('cmp').classList.toggle('single', n <= 1);
  cmpView.natW = 0;
  cmpView.natH = 0;
  $('cmp-img-base').src = fileUrl(item.processed);
  $('cmp-img-overlay').src = fileUrl(item.original);
}

function openCompareAt(index) {
  cmpView.index = Math.max(0, Math.min(cmpView.list.length - 1, index));
  $('compare-modal').classList.remove('hidden');
  showCompareItem();
  setCmpPos(50);
  requestAnimationFrame(() => setCmpPos(50));
}

function stepCompare(delta) {
  const next = cmpView.index + delta;
  if (next < 0 || next >= cmpView.list.length) return;
  cmpView.index = next;
  showCompareItem(); // keeps the divider where the user left it
}

// Kept for callers that have a pair rather than a list position.
function openCompare(original, processed, name, kind = 'Upscaled') {
  let index = cmpView.list.findIndex(c => c.original === original && c.processed === processed);
  if (index < 0) { cmpView.list = [{ original, processed, name, kind }]; index = 0; }
  openCompareAt(index);
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
  requestAnimationFrame(() => { layoutCompare(); setCmpPos(cmpPos); });
}

function setCmpPos(p) {
  p = Math.min(100, Math.max(0, p));
  cmpPos = p;
  $('cmp-clip').style.clipPath = `inset(0 ${100 - p}% 0 0)`;
  $('cmp-divider').style.left = p + '%';
  $('cmp-handle').style.left = p + '%';
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
// ─── Settings: autosave ─────────────────────────────────────────────────────
// Every control saves the moment it changes. There's no Save button to forget,
// and what the dashboard shows always matches what the next run will use.
const checkPath = (kind, otherKey) => async (value) =>
  window.pixelforge.validatePath({ kind, value, other: otherKey ? settings[otherKey] : undefined });

const SETTING_FIELDS = [
  { id: 'set-upscayl-model',    key: 'upscaylModel',     type: 'select' },
  { id: 'set-upscayl-scale',    key: 'upscaylScale',     type: 'select' },
  { id: 'set-upscayl-format',   key: 'upscaylFormat',    type: 'select' },
  { id: 'set-upscayl-gpu',      key: 'upscaylGpu',       type: 'select' },
  { id: 'set-upscayl-tile',     key: 'upscaylTileSize',  type: 'text', validate: validateTile },
  { id: 'set-upscayl-tta',      key: 'upscaylTta',       type: 'check' },
  { id: 'set-caesium-quality',  key: 'caesiumQuality',   type: 'range' },
  { id: 'set-caesium-format',   key: 'caesiumFormat',    type: 'select' },
  { id: 'set-caesium-lossless', key: 'caesiumLossless',  type: 'check' },
  { id: 'set-caesium-meta',     key: 'caesiumKeepMeta',  type: 'check' },
  { id: 'set-upscayl-bin-path', key: 'upscaylBinPath',   type: 'path', validate: checkPath('exe') },
  { id: 'set-caesium-bin-path', key: 'caesiumBinPath',   type: 'path', validate: checkPath('exe') },
  { id: 'set-models-path',      key: 'modelsPath',       type: 'path', validate: checkPath('models') },
  { id: 'set-upscaled-path',    key: 'upscaledPath',     type: 'path', validate: checkPath('dir', 'compressedPath') },
  { id: 'set-compressed-path',  key: 'compressedPath',   type: 'path', validate: checkPath('dir', 'upscaledPath') },
  { id: 'set-accent-color',     key: 'accentColor',      type: 'color' },
  { id: 'set-recursive',        key: 'recursive',        type: 'check' },
  { id: 'set-naming',           key: 'namingTemplate',   type: 'text', validate: validateNaming },
  { id: 'set-notify',           key: 'notifyOnComplete', type: 'check' },
  { id: 'set-sound',            key: 'soundOnComplete',  type: 'check' },
  { id: 'set-autoupdate',       key: 'autoCheckUpdates', type: 'check' },
  { id: 'set-restore-session',  key: 'restoreSession',   type: 'check' },
  { id: 'set-confirm-exit',     key: 'confirmOnExit',    type: 'check' },
];

function validateTile(value) {
  if (value === '') return { ok: true, value: '0' };
  return /^\d+$/.test(value) && Number(value) <= 4096
    ? { ok: true, value: String(Number(value)) }
    : { ok: false, message: 'Enter a whole number from 0 to 4096 (0 means automatic).' };
}

function validateNaming(value) {
  if (!value) return { ok: true, value: '{name}' };
  if (!/\{name\}|\{index\}/.test(value)) {
    return { ok: true, message: 'Without {name} or {index}, every image gets the same name plus a number — (2), (3)…' };
  }
  return { ok: true };
}

function setSaveStatus(state) {
  const el = $('save-status');
  el.dataset.state = state;
  const icon = { saved: 'ic-check', saving: 'ic-refresh', error: 'ic-warn' }[state];
  const text = { saved: 'All changes saved', saving: 'Saving…', error: "Not saved — check the highlighted field" }[state];
  el.innerHTML = `<svg width="13" height="13" aria-hidden="true"><use href="#${icon}"/></svg><span></span>`;
  el.querySelector('span').textContent = text;
}

// Shows an inline note under a setting: kind is 'error' or 'warn', or '' to clear.
function fieldNote(input, message, kind) {
  const row = input.closest('.set-row');
  if (!row) return;
  row.classList.toggle('has-error', kind === 'error');
  const host = row.firstElementChild;
  let note = host.querySelector('.field-note');
  if (!message) { note?.remove(); return; }
  if (!note) { note = document.createElement('div'); note.className = 'field-note'; host.appendChild(note); }
  note.className = `field-note ${kind === 'error' ? 'is-error' : 'is-warn'}`;
  note.textContent = message;
}

const pendingSaves = new Map();

function queueCommit(field, delay) {
  clearTimeout(pendingSaves.get(field.id));
  pendingSaves.set(field.id, setTimeout(() => commitField(field), delay));
}

async function commitField(field) {
  clearTimeout(pendingSaves.get(field.id));
  const el = $(field.id);
  let value = field.type === 'check' ? el.checked
    : field.type === 'range' ? parseInt(el.value, 10)
    : el.value.trim();

  if (field.validate) {
    const verdict = await field.validate(value);
    fieldNote(el, verdict.message, verdict.ok ? (verdict.message ? 'warn' : '') : 'error');
    if (!verdict.ok) { setSaveStatus('error'); return; }
    if (verdict.value !== undefined) value = verdict.value;
  }
  if (settings[field.key] === value) { setSaveStatus('saved'); return; }
  await saveSetting(field.key, value);
}

async function saveSetting(key, value) {
  setSaveStatus('saving');
  const res = await window.pixelforge.saveSettings({ [key]: value });
  if (!res || (res.rejected || []).includes(key)) { setSaveStatus('error'); return false; }
  settings = res.settings || { ...settings, [key]: value };
  setSaveStatus('saved');
  await afterSettingChange(key);
  return true;
}

async function afterSettingChange(key) {
  const field = SETTING_FIELDS.find(f => f.key === key);
  // A cleared path snaps back to the default it now resolves to.
  if (field && field.type === 'path') $(field.id).value = settings[key] || '';
  if (key === 'upscaledPath' || key === 'compressedPath') {
    appPaths = await window.pixelforge.getAppPaths();
    updateOutputPathDisplays();
  }
  if (key === 'upscaylBinPath' || key === 'caesiumBinPath' || key === 'modelsPath') {
    const r = await window.pixelforge.checkSetup();
    const ok = r.upscaylOk && r.modelsOk && r.caesiumOk;
    setBadge('pipeline-status-badge', ok ? 'ready' : 'error', ok ? 'Ready' : 'Setup Needed');
    if (key === 'modelsPath') loadModels(settings.upscaylModel);
  }
  if (key === 'recursive' && queue.length && !pipelineRunning) scanAll();
  if (key === 'restoreSession') persistQueue();
  refreshIdleDock();
}

function wireSettings() {
  for (const field of SETTING_FIELDS) {
    const el = $(field.id);
    if (field.type === 'check' || field.type === 'select') {
      el.addEventListener('change', () => commitField(field));
    } else if (field.type === 'range') {
      el.addEventListener('input', () => { $('set-caesium-quality-val').textContent = el.value; });
      el.addEventListener('change', () => commitField(field));
    } else if (field.type === 'color') {
      el.addEventListener('input', () => { $('set-accent-preview').textContent = el.value; applyAccentColor(el.value); queueCommit(field, 500); });
      el.addEventListener('change', () => commitField(field));
    } else {
      el.addEventListener('input', () => queueCommit(field, 700));
      el.addEventListener('change', () => commitField(field));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    }
  }

  document.querySelectorAll('#theme-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
    applyTheme(b.dataset.theme);
    saveSetting('theme', b.dataset.theme);
  }));
  document.querySelectorAll('#output-mode-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
    setOutputMode(b.dataset.outmode);
    saveSetting('outputMode', outputMode);
  }));

  const browse = (btnId, fieldId, isFolder) => $(btnId).addEventListener('click', async () => {
    const picked = isFolder ? await window.pixelforge.selectFolder() : await window.pixelforge.selectFile([{ name: 'Executable', extensions: ['exe'] }]);
    if (!picked) return;
    $(fieldId).value = picked;
    commitField(SETTING_FIELDS.find(f => f.id === fieldId));
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
  refreshIdleDock();
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
  document.querySelectorAll('.field-note').forEach(n => n.remove());
  document.querySelectorAll('.set-row.has-error').forEach(r => r.classList.remove('has-error'));
  syncSelects();
  syncRanges();
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
const ALERT_KINDS = { error: 'error', success: 'success', warning: 'warning', info: 'info' };
function showUpdateStatus(type, text) {
  $('upd-status-wrap').classList.remove('hidden');
  $('upd-status').className = 'alert alert-' + (ALERT_KINDS[type] || 'info');
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
  const res = await window.pixelforge.downloadUpdate({
    assetUrl: lastUpdate.assetUrl,
    assetName: lastUpdate.assetName,
    checksumUrl: lastUpdate.checksumUrl,
  });
  $('btn-download-update').disabled = false;
  if (res.success) {
    lastUpdate.path = res.path;
    $('upd-dl-bar').classList.add('done');
    showUpdateStatus(res.verified ? 'success' : 'warning', res.verified
      ? 'Download verified against its SHA-256 checksum. Run the installer to update.'
      : 'Download complete, but this release published no checksum to verify it against.');
    $('btn-run-installer').classList.remove('hidden');
  } else {
    showUpdateStatus('error', res.error || 'Download failed.');
  }
}
function onUpdateAvailable(result) {
  lastUpdate = result;
  $('update-banner-title').textContent = `PixelForge ${result.latest} is available`;
  $('update-banner-sub').textContent = `You're on v${result.current}. Update from Settings.`;
  $('update-banner').classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', init);
