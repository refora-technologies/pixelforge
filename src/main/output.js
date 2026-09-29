'use strict';

// Owns everything PixelForge writes into an output folder.
//
// Output folders can be any folder the user picks, so nothing here may touch a
// file PixelForge didn't create. Each Replace-mode run records what it placed in
// a manifest; the next run removes exactly those files and nothing else. New
// results never overwrite an existing file — a clash gets a " (2)" suffix.

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const paths = require('./paths');

const MANIFEST_FILE = '.pixelforge-output.json';
const STAGING_DIR = '.pixelforge-staging';

function hideOnWindows(target) {
  if (process.platform !== 'win32') return;
  execFile('attrib', ['+h', target], { windowsHide: true }, () => {});
}

function readManifest(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8'));
    return Array.isArray(data.files) ? data.files.filter(f => typeof f === 'string') : null;
  } catch { return null; }
}

async function writeManifest(root, files) {
  const file = path.join(root, MANIFEST_FILE);
  try {
    await fsp.rm(file, { force: true });
    await fsp.writeFile(file, JSON.stringify({ version: 1, files }, null, 2));
    hideOnWindows(file);
  } catch {}
}

// Deepest first, so a folder emptied by removing its children goes too.
async function pruneEmptyDirs(root, dirs) {
  const sorted = [...new Set(dirs)].sort((a, b) => b.length - a.length);
  for (const dir of sorted) {
    let current = dir;
    while (paths.isStrictlyInside(current, root)) {
      try { await fsp.rmdir(current); } catch { break; }
      current = path.dirname(current);
    }
  }
}

async function listImagesRecursive(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== STAGING_DIR) await listImagesRecursive(full, out); }
    else if (e.isFile() && paths.IMAGE_RE.test(e.name)) out.push(full);
  }
  return out;
}

async function removePreviousOutputs(root, legacyOwned) {
  const files = readManifest(root);
  const touchedDirs = [];

  if (files) {
    for (const rel of files) {
      const abs = path.resolve(root, rel);
      // A hand-edited manifest must not be able to reach outside the folder.
      if (!paths.isStrictlyInside(abs, root)) continue;
      try { await fsp.rm(abs, { force: true }); touchedDirs.push(path.dirname(abs)); } catch {}
    }
    await fsp.rm(path.join(root, MANIFEST_FILE), { force: true }).catch(() => {});
  } else if (legacyOwned) {
    // Versions before 1.2 wrote no manifest and wiped the default output folder
    // wholesale. That folder is PixelForge's own, so its images are treated as the
    // previous results — once. Other files and every custom folder are left alone.
    for (const abs of await listImagesRecursive(root)) {
      try { await fsp.rm(abs, { force: true }); touchedDirs.push(path.dirname(abs)); } catch {}
    }
  }

  await pruneEmptyDirs(root, touchedDirs);
}

async function moveFile(src, dest) {
  try { await fsp.rename(src, dest); }
  catch {
    // Crossing volumes — rename can't do that.
    await fsp.copyFile(src, dest);
    await fsp.rm(src, { force: true });
  }
}

function createWriter(root, { replace, legacyOwned }) {
  const stagingRoot = path.join(root, STAGING_DIR);
  const placed = [];
  const reserved = new Set();
  let stagingHidden = false;

  function uniqueTarget(dir, fileName) {
    const { name, ext } = path.parse(fileName);
    let candidate = path.join(dir, fileName);
    for (let n = 2; reserved.has(candidate.toLowerCase()) || fs.existsSync(candidate); n++) {
      candidate = path.join(dir, `${name} (${n})${ext}`);
    }
    reserved.add(candidate.toLowerCase());
    return candidate;
  }

  return {
    root,

    async begin() {
      await fsp.mkdir(root, { recursive: true });
      // Leftovers from a run that crashed or was killed.
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      if (replace) await removePreviousOutputs(root, legacyOwned);
    },

    async stagingDir(name) {
      const dir = path.join(stagingRoot, name);
      await fsp.mkdir(dir, { recursive: true });
      if (!stagingHidden) { hideOnWindows(stagingRoot); stagingHidden = true; }
      return dir;
    },

    // Moves a finished file into place without overwriting anything, and
    // returns where it actually landed.
    async place(src, relDir, fileName) {
      const dir = path.join(root, relDir || '');
      await fsp.mkdir(dir, { recursive: true });
      const target = uniqueTarget(dir, fileName);
      await moveFile(src, target);
      placed.push(path.relative(root, target));
      return target;
    },

    async finish() {
      await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      if (replace) await writeManifest(root, placed);
    },
  };
}

module.exports = { createWriter, MANIFEST_FILE, STAGING_DIR };
