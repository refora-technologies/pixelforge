'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let store;

try {
  const Store = require('electron-store');
  store = new Store();
} catch {
  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  const loadCfg = () => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return {}; }
  };
  store = {
    get: (key, def) => {
      const data = loadCfg();
      return data[key] !== undefined ? data[key] : def;
    },
    set: (key, value) => {
      const data = loadCfg();
      data[key] = value;
      fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
    },
  };
}

module.exports = store;
