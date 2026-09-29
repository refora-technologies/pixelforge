'use strict';

// Drives the real Settings page and checks what actually lands in the store:
// autosave, inline validation, and keyboard control of the custom dropdowns.
//
//   npx electron tools/test-settings-ui.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-settings-ui-'));
app.setPath('userData', PROFILE);
app.setPath('documents', path.join(PROFILE, 'documents'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
fs.writeFileSync(path.join(PROFILE, 'config.json'), JSON.stringify({ app: { setupDone: true, autoCheckUpdates: false } }));

require('../main.js');
const store = require('../src/main/store');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (code) => win().webContents.executeJavaScript(code, true);
const key = (keyCode) => win().webContents.sendInputEvent({ type: 'keyDown', keyCode });

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
};

async function waitFor(expr, timeout = 15000) {
  const t0 = Date.now();
  while (!(await js(`(()=>{try{return !!(${expr})}catch(e){return false}})()`))) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${expr}`);
    await sleep(100);
  }
}

// Sets a text field the way a user does: type, then leave the field.
const setField = (id, value) => js(`(()=>{const el=document.getElementById('${id}');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change'));})()`);
const noteFor = (id) => js(`(()=>{const n=document.getElementById('${id}').closest('.set-row').querySelector('.field-note');return n?{cls:n.className,text:n.textContent}:null})()`);
const saveState = () => js(`document.getElementById('save-status').dataset.state`);

app.whenReady().then(async () => {
  try {
    await sleep(1200);
    await waitFor(`document.getElementById('sidebar-version').textContent.indexOf('v')>=0`);
    await js(`document.getElementById('setup-overlay').style.display='none'; navigateTo('settings'); null`);
    await sleep(400);

    console.log('\nautosave');
    check('no Save button remains', await js(`!document.getElementById('btn-save-settings')`));
    await js(`document.getElementById('set-recursive').click(); null`);
    await sleep(600);
    check('toggle saves immediately', store.get('app.recursive') === true, store.get('app.recursive'));
    check('status reads saved', (await saveState()) === 'saved');

    await js(`document.querySelector('#theme-seg .seg-btn[data-theme="light"]').click(); null`);
    await sleep(600);
    check('theme saves on click', store.get('app.theme') === 'light', store.get('app.theme'));

    console.log('\nvalidation');
    await setField('set-upscayl-tile', '99999');
    await sleep(600);
    const tileNote = await noteFor('set-upscayl-tile');
    check('bad tile size is flagged inline', tileNote && /is-error/.test(tileNote.cls), JSON.stringify(tileNote));
    check('bad tile size is not saved', store.get('upscayl.tileSize') === undefined, store.get('upscayl.tileSize'));
    check('status shows the problem', (await saveState()) === 'error');
    await setField('set-upscayl-tile', '256');
    await sleep(600);
    check('fixing it clears the note and saves', !(await noteFor('set-upscayl-tile')) && store.get('upscayl.tileSize') === '256');

    await setField('set-upscaled-path', 'Q:/nowhere/at/all');
    await sleep(800);
    const pathNote = await noteFor('set-upscaled-path');
    check('unreachable output folder is flagged', pathNote && /is-error/.test(pathNote.cls), JSON.stringify(pathNote));
    check('and not saved', store.get('paths.upscaled') === undefined, store.get('paths.upscaled'));

    const custom = path.join(PROFILE, 'my-output');
    fs.mkdirSync(custom);
    await setField('set-upscaled-path', custom);
    await sleep(800);
    check('valid folder saves', store.get('paths.upscaled') === custom, store.get('paths.upscaled'));
    await setField('set-compressed-path', path.join(custom, 'inside'));
    await sleep(800);
    const overlap = await noteFor('set-compressed-path');
    check('overlapping output folders are refused', overlap && /separate/.test(overlap.text), JSON.stringify(overlap));

    await setField('set-upscaled-path', '');
    await sleep(800);
    const shown = await js(`document.getElementById('set-upscaled-path').value`);
    check('clearing a path returns to the default', store.get('paths.upscaled') === undefined && /PixelForge[\\/]upscaled$/.test(shown), shown);

    await setField('set-naming', '{model}');
    await sleep(700);
    const naming = await noteFor('set-naming');
    check('risky naming template warns but still saves', naming && /is-warn/.test(naming.cls) && store.get('app.namingTemplate') === '{model}');

    console.log('\nkeyboard dropdown');
    const before = store.get('upscayl.scale') || '4';
    await js(`document.getElementById('set-upscayl-scale').parentNode.querySelector('.sel-trigger').focus(); null`);
    key('Down'); await sleep(250);
    check('arrow key opens the menu', await js(`!!document.querySelector('.sel-menu')`));
    check('focus moves into the menu', await js(`document.activeElement && document.activeElement.getAttribute('role') === 'option'`));
    check('menu is an ARIA listbox', await js(`document.querySelector('.sel-menu').getAttribute('role') === 'listbox'`));
    key('Home'); await sleep(120);
    key('Return'); await sleep(700);
    check('Enter chooses and saves', store.get('upscayl.scale') === '2' && before !== '2', `${before} → ${store.get('upscayl.scale')}`);
    check('menu closes and focus returns to the trigger', await js(`!document.querySelector('.sel-menu') && document.activeElement.classList.contains('sel-trigger')`));
    key('Down'); await sleep(250);
    key('Escape'); await sleep(250);
    check('Escape closes without changing anything', await js(`!document.querySelector('.sel-menu')`) && store.get('upscayl.scale') === '2');
  } catch (err) {
    failed++;
    console.log('  FAIL  unexpected —', err.message);
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
