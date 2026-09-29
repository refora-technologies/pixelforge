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

// Downloads the installer and hands it back only if it matches the checksum
// published beside it. No checksum, or one that can't be read, is a refusal
// rather than a warning: an update that can't be verified isn't installed.
// Every release since 1.1.0 publishes one.
async function downloadUpdate(assetUrl, assetName, checksumUrl, onProgress) {
  if (!assetUrl) throw new Error('No download URL available.');
  if (!checksumUrl) {
    throw new Error("This release doesn't publish a checksum, so it can't be verified. Download it from the GitHub releases page instead.");
  }

  // Read the digest first — no point fetching the whole installer otherwise.
  let expected = null;
  try { expected = parseSha256(await fetchText(checksumUrl)); } catch {}
  if (!expected) throw new Error("The release's checksum couldn't be read, so the update can't be verified. Try again later.");

  const dest = path.join(app.getPath('downloads'), assetName || 'PixelForge-Setup.exe');
  await downloadFile(assetUrl, dest, onProgress);

  const actual = await sha256File(dest);
  if (actual !== expected) {
    try { fs.unlinkSync(dest); } catch {}
    throw new Error('Checksum mismatch — the download was discarded. Please try again or download from GitHub.');
  }
  return { path: dest, verified: true, sha256: actual };
}

// How a verified update is installed: silently (/S), as an update over the
// existing copy (--updated keeps shortcuts and skips first-install steps), and
// with PixelForge started again afterwards (--force-run). One click, no wizard.
// The installer stops a still-running copy itself, so a slow exit can't leave
// the old executable in place.
const SILENT_UPDATE_ARGS = Object.freeze(['/S', '--updated', '--force-run']);

// After a one-click update the app should come back as the version it
// installed. If it didn't, say so and offer the full installer — silently
// carrying on as the old version is what "updating does nothing" looks like.
const PENDING_UPDATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function pendingUpdateOutcome(pending, current, now = Date.now(), exists = fs.existsSync) {
  if (!pending || typeof pending !== 'object') return null;
  const to = String(pending.to || '');
  if (!to || to.replace(/^v/i, '') === current || isNewer(current, to)) return { ok: true, version: current };
  // A stale record from long ago isn't worth alarming anyone about.
  if (!(now - (Number(pending.at) || 0) <= PENDING_UPDATE_MAX_AGE_MS)) return null;
  const installer = typeof pending.installer === 'string' && pending.installer && exists(pending.installer) ? pending.installer : '';
  return { ok: false, current, to: to.replace(/^v/i, ''), installer };
}

module.exports = { checkForUpdates, downloadUpdate, isNewer, pendingUpdateOutcome, SILENT_UPDATE_ARGS };
