'use strict';

// What the window may ask the operating system to open.
//
// The renderer can only reach the OS through these checks. Opening a file with
// its default program will happily run an .exe, and opening a URL can go
// anywhere — so both are narrowed to exactly what PixelForge needs. Pure
// functions, so they can be tested without Electron.

const path = require('path');

// Host → the path everything must sit under ('/' means the whole site).
const EXTERNAL = {
  'pixelforge.reforatech.com': '/',
  'github.com': '/refora-technologies/pixelforge',
};

function isAllowedExternalUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const prefix = EXTERNAL[url.hostname];
  if (prefix === undefined) return false;
  // "/refora-technologies/pixelforge-evil" must not pass for the repo.
  return prefix === '/' || url.pathname === prefix || url.pathname.startsWith(prefix + '/');
}

// Results and run logs — never anything that executes.
const OPENABLE = /\.(jpe?g|png|webp|bmp|tiff?|gif|log|txt)$/i;

function isOpenableFile(p) {
  return typeof p === 'string' && path.isAbsolute(p) && OPENABLE.test(p);
}

module.exports = { isAllowedExternalUrl, isOpenableFile };
