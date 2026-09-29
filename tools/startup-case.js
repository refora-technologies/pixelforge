'use strict';

// One start-up scenario for tools/test-startup.js. Seeds an isolated profile
// with PF_STARTUP_CONFIG, boots the real main.js, and reports on the window.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, screen } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-startup-'));
app.setPath('userData', profile);
const config = JSON.parse(process.env.PF_STARTUP_CONFIG || '{}');
config.app = { setupDone: true, autoCheckUpdates: false, ...(config.app || {}) };
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(config));

require('../main.js');

app.whenReady().then(() => setTimeout(() => {
  const windows = BrowserWindow.getAllWindows();
  const win = windows[0];
  let onScreen = false;
  if (win) {
    const b = win.getBounds();
    onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
  }
  console.log('RESULT ' + JSON.stringify({ windows: windows.length, visible: !!win && win.isVisible(), onScreen }));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  app.exit(0);
}, 5000));
