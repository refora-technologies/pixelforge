'use strict';

// Checks that main, preload, renderer and markup still agree with each other.
// A renamed channel, a preload method nobody exposes or an element id that
// isn't in the page fails silently at run time; here it fails in a second.
//
//   node tools/test-contract.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const all = (text, re) => [...text.matchAll(re)].map(m => m[1]);
const uniq = (xs) => [...new Set(xs)].sort();

const mainSrc = read('main.js');
const preload = read('preload.js');
const renderer = read('src/renderer.js');
const html = read('src/index.html');
const settingsSrc = read('src/main/settings.js');

let passed = 0, failed = 0;
function same(name, missing) {
  if (!missing.length) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} — ${missing.join(', ')}`); }
}
const minus = (a, b) => uniq(a).filter(x => !b.includes(x));

// ── IPC channels ──
const handled = all(mainSrc, /ipcMain\.handle\('([\w-]+)'/g);
const invoked = all(preload, /ipcRenderer\.invoke\('([\w-]+)'/g);
const sentByMain = all(mainSrc, /\bsend\('([\w-]+)'/g);
const listened = all(preload, /ipcRenderer\.on\('([\w-]+)'/g);
const cleared = all(renderer, /removeAllListeners\('([\w-]+)'\)/g);

console.log('\nIPC');
same('every invoke has a handler', minus(invoked, handled));
same('every handler is reachable from preload', minus(handled, invoked));
same('every event main sends is listened for', minus(sentByMain, listened));
same('every listened event is sent by main', minus(listened, sentByMain));
same('channels the renderer clears exist', minus(cleared, listened));

// ── Preload API ──
const apiBlock = preload.slice(preload.indexOf("exposeInMainWorld('pixelforge'"));
const exposed = all(apiBlock, /^\s{2}(\w+):/gm);
const used = all(renderer, /window\.pixelforge\.(\w+)/g);

console.log('\npreload API');
same('everything the renderer calls is exposed', minus(used, exposed));
same('everything exposed is used', minus(exposed, used));

// ── Markup ──
const ids = all(html, /\sid="([\w-]+)"/g);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
// Ids the renderer builds itself at run time, not in index.html.
const created = [...all(renderer, /\.id = '([\w-]+)'/g), ...all(renderer, /\sid="([\w-]+)"/g)];
const referenced = [
  ...all(renderer, /\$\('([\w-]+)'\)/g),
  ...all(renderer, /getElementById\('([\w-]+)'\)/g),
  ...all(renderer, /\{ id: '([\w-]+)',\s*key:/g), // SETTING_FIELDS
];
const symbols = all(html, /<symbol id="([\w-]+)"/g);
const iconUses = [...all(html, /href="#(ic-[\w-]+)"/g), ...all(renderer, /#(ic-[\w-]+)/g)];

console.log('\nmarkup');
same('no duplicate ids', uniq(dupes));
same('every id the renderer uses is in the page', minus(referenced, [...ids, ...created]));
same('every icon used is defined', minus(iconUses, symbols));

// ── Settings ──
const mapped = all(settingsSrc, /\['[\w.]+',\s*'(\w+)'/g);
const fieldKeys = all(renderer, /\{ id: '[\w-]+',\s*key: '(\w+)'/g);
const readKeys = all(renderer, /\bsettings\.(\w+)/g);
const savedKeys = all(renderer, /saveSettings\(\{\s*(\w+)\s*:/g);

console.log('\nsettings');
same('every settings field is stored', minus(fieldKeys, mapped));
same('every setting the renderer reads exists', minus(readKeys, mapped));
same('every setting the renderer saves exists', minus(savedKeys, mapped));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
