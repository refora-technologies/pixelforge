'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec } = require('child_process');
const paths = require('./paths');
const store = require('./store');

const PROBE_TIMEOUT_MS = 4000;

// The upscayl probe costs seconds, so the list is cached in memory for the
// session and mirrored into the store so the next launch can render instantly
// while a fresh probe runs in the background.
let cached = null;
let inFlight = null;
let refreshed = false;

function isIntegratedName(name) {
  return /intel|microsoft basic|display adapter|parsec/i.test(name);
}

function parseGpuOutput(output) {
  const gpuRegex = /\[(\d+)\s+([^\]]+)\]/g;
  const gpus = [];
  const seen = new Set();
  let m;
  while ((m = gpuRegex.exec(output)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = m[2].trim();
    gpus.push({ id, name, vramMB: 0, vramLabel: '', isIntegrated: isIntegratedName(name) });
  }
  return gpus;
}

function listGpusViaWmi() {
  return new Promise((resolve) => {
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
            return { id: String(i), name, vramMB: vram, vramLabel: vram > 0 ? `${vram} MB` : '', isIntegrated: isIntegratedName(name) };
          });
        resolve(gpus);
      } catch { resolve([]); }
    });
  });
}

function probeUpscayl(binPath) {
  return new Promise((resolve) => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gpu-'));
    let output = '';
    let done = false;

    const finish = (gpus) => {
      if (done) return;
      done = true;
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
      resolve(gpus);
    };

    const proc = spawn(binPath, ['-i', probeDir, '-o', probeDir], {
      cwd: path.dirname(binPath),
      timeout: PROBE_TIMEOUT_MS,
    });
    proc.stderr.on('data', d => output += d.toString());
    proc.stdout.on('data', d => output += d.toString());
    proc.on('close', () => finish(parseGpuOutput(output)));
    proc.on('error', () => finish([]));
    setTimeout(() => { try { proc.kill(); } catch {} }, PROBE_TIMEOUT_MS);
  });
}

async function probeGpus() {
  const binPath = paths.getUpscaylBin();
  if (fs.existsSync(binPath)) {
    const gpus = await probeUpscayl(binPath);
    if (gpus.length) return gpus;
  }
  return listGpusViaWmi();
}

function refreshInBackground() {
  if (refreshed) return;
  refreshed = true;
  probeGpus()
    .then(gpus => { if (gpus.length) { cached = gpus; store.set('app.gpuCache', gpus); } })
    .catch(() => {});
}

async function listGpus(opts) {
  const force = !!(opts && opts.force);
  if (force) { cached = null; refreshed = true; }
  if (cached) return cached;

  if (!force) {
    const saved = store.get('app.gpuCache', null);
    if (Array.isArray(saved) && saved.length) {
      cached = saved;
      refreshInBackground();
      return cached;
    }
  }

  if (inFlight) return inFlight;
  inFlight = probeGpus()
    .then(gpus => {
      inFlight = null;
      refreshed = true;
      if (gpus.length) { cached = gpus; store.set('app.gpuCache', gpus); }
      return gpus;
    })
    .catch(() => { inFlight = null; return []; });
  return inFlight;
}

async function resolveDedicatedGpuId() {
  try {
    const gpus = await listGpus();
    const dedicated = gpus.find(g => !g.isIntegrated);
    if (dedicated) return dedicated.id;
  } catch {}
  return null;
}

module.exports = { listGpus, resolveDedicatedGpuId };
