'use strict';

// Boots the real app with saved settings that used to stop it from opening, and
// checks a usable window appears every time.
//
//   node tools/test-startup.js
//
// Each case runs in its own Electron process with an isolated profile.

const path = require('path');
const { spawnSync } = require('child_process');
const electron = require('electron'); // under plain Node this is the binary path

const CASES = [
  ['empty output path',        { paths: { upscaled: '', compressed: '   ' } }],
  ['output on a missing drive', { paths: { upscaled: 'Q:/PixelForge/upscaled', compressed: 'Q:/PixelForge/compressed' } }],
  ['window saved off-screen',  { app: { windowBounds: { x: -4200, y: 3100, width: 1180, height: 760, maximized: false } } }],
  ['oversized saved window',   { app: { windowBounds: { x: 0, y: 0, width: 9000, height: 7000, maximized: false } } }],
];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let passed = 0, failed = 0;
for (const [name, config] of CASES) {
  const res = spawnSync(electron, [path.join(__dirname, 'startup-case.js')], {
    env: { ...env, PF_STARTUP_CONFIG: JSON.stringify(config) },
    encoding: 'utf8',
    timeout: 60000,
  });
  const line = (res.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULT '));
  let result = null;
  try { result = line && JSON.parse(line.slice(7)); } catch {}
  const ok = result && result.windows === 1 && result.visible && result.onScreen;
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} — ${line || (res.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ')}`); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
