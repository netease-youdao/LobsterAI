'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const electron = require('electron');
const { root, qaDir, fixturePort } = require('./config.cjs');
for (const name of ['appdata', 'home', 'documents']) fs.mkdirSync(path.join(qaDir, name), { recursive: true });
electron.app.setPath('appData', path.join(qaDir, 'appdata'));
electron.app.setPath('userData', path.join(qaDir, 'appdata', 'LobsterAI'));
electron.app.setPath('home', path.join(qaDir, 'home'));
electron.app.setPath('documents', path.join(qaDir, 'documents'));
electron.app.setAppPath(root);
electron.app.getVersion = () => require(path.join(root, 'package.json')).version;
electron.BrowserWindow.prototype.show = electron.BrowserWindow.prototype.showInactive;
electron.BrowserWindow.prototype.focus = function () {};
const originalFetch = electron.net.fetch.bind(electron.net);
electron.net.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (['lobsterai-server.youdao.com', 'lobsterai-server.inner.youdao.com'].includes(url.hostname)) {
    return originalFetch(`http://127.0.0.1:${fixturePort}` + url.pathname + url.search, init);
  }
  return originalFetch(input, init);
};
process.env.NODE_ENV = 'production';
process.chdir(root);
// Debugger-only observation/fault injection. Production source has no QA hooks.
const suffix = fs.readFileSync(path.join(__dirname, 'debug-hooks.cjs'), 'utf8');
const filename = path.join(root, 'dist-electron/main.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename, 'utf8') + '\n' + suffix, filename);
