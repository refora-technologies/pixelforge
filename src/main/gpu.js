'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec } = require('child_process');
const paths = require('./paths');

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
    const isIntegrated = /intel|microsoft basic|display adapter|parsec/i.test(name);
    gpus.push({ id, name, vramMB: 0, vramLabel: '', isIntegrated });
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
            const isIntegrated = /intel|microsoft basic|display adapter|parsec/i.test(name);
            return { id: String(i), name, vramMB: vram, vramLabel: vram > 0 ? `${vram} MB` : '', isIntegrated };
          });
        resolve(gpus);
      } catch { resolve([]); }
    });
  });
}

function listGpus() {
  const binPath = paths.getUpscaylBin();
  if (!fs.existsSync(binPath)) return listGpusViaWmi();

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
      timeout: 5000,
    });
    proc.stderr.on('data', d => output += d.toString());
    proc.stdout.on('data', d => output += d.toString());
    proc.on('close', () => finish(parseGpuOutput(output)));
    proc.on('error', () => finish([]));
    setTimeout(() => { try { proc.kill(); } catch {} }, 5000);
  });
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
