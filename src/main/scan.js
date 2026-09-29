'use strict';

// One walker for both the dashboard scan and the pipeline, so the count the user
// sees is the count that gets processed. Async throughout: a synchronous walk
// over a large tree blocks the main process and freezes the window.

const path = require('path');
const fsp = require('fs').promises;
const paths = require('./paths');
const { STAGING_DIR } = require('./output');

async function walk(dir, rel, out, opts) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (!opts.recursive || e.name === STAGING_DIR) continue;
      if (opts.skip.some(s => paths.samePath(s, abs))) continue;
      await walk(abs, childRel, out, opts);
    } else if (e.isFile() && paths.IMAGE_RE.test(e.name)) {
      let size = 0;
      if (opts.withSize) {
        try { size = (await fsp.stat(abs)).size; } catch { continue; }
      }
      out.push({ abs, rel: childRel, size });
    }
  }
}

// excludeDirs are skipped only when an input is a strict parent of them: adding
// Documents recursively shouldn't sweep up PixelForge's own output folders, but
// adding an output folder directly is a deliberate choice and is honoured.
async function collectInputs(inputs, { recursive = false, excludeDirs = [], withSize = false } = {}) {
  const entries = [];
  for (const input of inputs || []) {
    let stat;
    try { stat = await fsp.stat(input); }
    catch { entries.push({ input, isDir: false, missing: true, files: [] }); continue; }

    if (stat.isDirectory()) {
      const skip = excludeDirs.filter(d => d && paths.isStrictlyInside(d, input));
      const files = [];
      await walk(input, '', files, { recursive, skip, withSize });
      entries.push({ input, isDir: true, files });
    } else if (stat.isFile() && paths.IMAGE_RE.test(input)) {
      entries.push({ input, isDir: false, files: [{ abs: input, rel: path.basename(input), size: stat.size }] });
    } else {
      entries.push({ input, isDir: false, files: [] });
    }
  }
  return entries;
}

module.exports = { collectInputs };
