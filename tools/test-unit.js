'use strict';

// Pure-logic checks that need neither Electron nor a network — fast enough to
// run before every commit.
//   node tools/test-unit.js

const guard = require('../src/main/guard');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

section('guard.isAllowedExternalUrl');
for (const url of [
  'https://pixelforge.reforatech.com',
  'https://pixelforge.reforatech.com/docs?x=1#top',
  'https://github.com/refora-technologies/pixelforge',
  'https://github.com/refora-technologies/pixelforge/issues',
  'https://github.com/refora-technologies/pixelforge/releases/tag/v1.2.0',
]) check(`allows ${url}`, guard.isAllowedExternalUrl(url));
for (const [why, url] of [
  ['plain http', 'http://pixelforge.reforatech.com'],
  ['another repo', 'https://github.com/someone/else'],
  ['a look-alike repo', 'https://github.com/refora-technologies/pixelforge-evil'],
  ['a look-alike host', 'https://pixelforge.reforatech.com.evil.io/'],
  ['a subdomain', 'https://evil.pixelforge.reforatech.com/'],
  ['credentials', 'https://user:pw@github.com/refora-technologies/pixelforge'],
  ['a port', 'https://github.com:8443/refora-technologies/pixelforge'],
  ['file:', 'file:///C:/Windows/System32/calc.exe'],
  ['javascript:', 'javascript:alert(1)'],
  ['a UNC-ish path', '\\\\server\\share\\x.exe'],
  ['garbage', 'not a url'],
  ['nothing', undefined],
  ['an object', { href: 'https://github.com/refora-technologies/pixelforge' }],
]) check(`refuses ${why}`, !guard.isAllowedExternalUrl(url), String(url));

section('guard.isOpenableFile');
for (const p of ['C:\\out\\photo.png', 'C:\\out\\photo.JPEG', 'D:/x/y.webp', 'C:\\logs\\run.log', 'C:\\a\\b.tif'])
  check(`opens ${p}`, guard.isOpenableFile(p));
for (const [why, p] of [
  ['an executable', 'C:\\out\\photo.png.exe'],
  ['a script', 'C:\\out\\run.bat'],
  ['a shortcut', 'C:\\out\\photo.lnk'],
  ['a relative path', 'photo.png'],
  ['no extension', 'C:\\out\\photo'],
  ['a non-string', 42],
]) check(`refuses ${why}`, !guard.isOpenableFile(p), String(p));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
