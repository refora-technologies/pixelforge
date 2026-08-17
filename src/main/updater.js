'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { getGithubLatestRelease, downloadFile, fetchText, parseSha256, sha256File } = require('./download');

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
    const assets = rel.assets || [];
    const asset = assets.find(a => /\.exe$/i.test(a.name) && /setup/i.test(a.name))
               || assets.find(a => /\.exe$/i.test(a.name));
    // Published alongside the installer as "<installer>.sha256".
    const checksum = asset && assets.find(a => a.name.toLowerCase() === `${asset.name.toLowerCase()}.sha256`);
    return {
      ok: true,
      current,
      latest,
      hasUpdate: latest ? isNewer(latest, current) : false,
      assetUrl: asset?.browser_download_url || '',
      assetName: asset?.name || '',
      checksumUrl: checksum?.browser_download_url || '',
      htmlUrl: rel.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`,
      notes: rel.body || '',
    };
  } catch (err) {
    return { ok: false, current, error: err.message };
  }
}

// Downloads the installer and, when the release publishes a .sha256 next to it,
// refuses to hand back anything whose digest doesn't match.
async function downloadUpdate(assetUrl, assetName, checksumUrl, onProgress) {
  if (!assetUrl) throw new Error('No download URL available.');
  const dest = path.join(app.getPath('downloads'), assetName || 'PixelForge-Setup.exe');
  await downloadFile(assetUrl, dest, onProgress);

  if (!checksumUrl) return { path: dest, verified: false };

  let expected;
  try {
    expected = parseSha256(await fetchText(checksumUrl));
  } catch {
    expected = null;
  }
  if (!expected) return { path: dest, verified: false };

  const actual = await sha256File(dest);
  if (actual !== expected) {
    try { fs.unlinkSync(dest); } catch {}
    throw new Error('Checksum mismatch — the download was discarded. Please try again or download from GitHub.');
  }
  return { path: dest, verified: true, sha256: actual };
}

module.exports = { checkForUpdates, downloadUpdate, isNewer };
