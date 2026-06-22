'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function requestWithRedirects(url, onResponse, onError, depth = 0) {
  if (depth > 8) { onError(new Error('Too many redirects')); return; }
  const protocol = url.startsWith('https') ? https : http;
  protocol.get(url, { headers: { 'User-Agent': 'PixelForge' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      requestWithRedirects(res.headers.location, onResponse, onError, depth + 1);
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      onError(new Error(`HTTP ${res.statusCode}`));
      return;
    }
    onResponse(res);
  }).on('error', onError);
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      file.destroy();
      fs.unlink(destPath, () => reject(err));
    };

    file.on('error', fail);

    requestWithRedirects(url, (res) => {
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0 && onProgress) onProgress(Math.round(downloaded / total * 100), downloaded, total);
      });
      res.on('error', fail);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve({ bytes: downloaded });
      });
      res.pipe(file);
    }, fail);
  });
}

function getGithubLatestRelease(owner, repo) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases/latest`,
      method: 'GET',
      headers: { 'User-Agent': 'PixelForge', 'Accept': 'application/vnd.github+json' },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`GitHub API HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function findFileRecursive(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (item.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function isValidZip(filePath, minBytes = 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < minBytes) return false;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } catch { return false; }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function verifyChecksum(filePath, expectedSha256) {
  if (!expectedSha256) return true;
  const actual = await sha256File(filePath);
  return actual.toLowerCase() === expectedSha256.toLowerCase();
}

module.exports = {
  downloadFile,
  getGithubLatestRelease,
  findFileRecursive,
  isValidZip,
  sha256File,
  verifyChecksum,
};
