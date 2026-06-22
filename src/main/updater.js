'use strict';

const { app } = require('electron');
const path = require('path');
const { getGithubLatestRelease, downloadFile } = require('./download');

const REPO_OWNER = 'refora-technologies';
const REPO_NAME = 'pixelforge';

function parseVersion(v) {
  return String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function checkForUpdates() {
  const current = app.getVersion();
  try {
    const rel = await getGithubLatestRelease(REPO_OWNER, REPO_NAME);
    const latest = (rel.tag_name || rel.name || '').replace(/^v/i, '');
    const asset = rel.assets?.find(a => /\.exe$/i.test(a.name) && /setup/i.test(a.name))
               || rel.assets?.find(a => /\.exe$/i.test(a.name));
    return {
      ok: true,
      current,
      latest,
      hasUpdate: latest ? isNewer(latest, current) : false,
      assetUrl: asset?.browser_download_url || '',
      assetName: asset?.name || '',
      htmlUrl: rel.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`,
      notes: rel.body || '',
    };
  } catch (err) {
    return { ok: false, current, error: err.message };
  }
}

async function downloadUpdate(assetUrl, assetName, onProgress) {
  if (!assetUrl) throw new Error('No download URL available.');
  const downloadsDir = app.getPath('downloads');
  const dest = path.join(downloadsDir, assetName || 'PixelForge-Setup.exe');
  await downloadFile(assetUrl, dest, onProgress);
  return dest;
}

module.exports = { checkForUpdates, downloadUpdate, isNewer };
