// Isolated acceptance entry: never show/focus native windows or use the OS keyboard/mouse.
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow } = electron;
if (process.env.IMAGE_EDITING_DATABASE_TEST !== 'true') throw new Error('Explicit test opt-in required');
const root = path.resolve(__dirname, '../..');
app.setAppPath(root);
// A custom Electron entry otherwise reports Electron's version to the server.
const packageVersion = require(path.join(root, 'package.json')).version;
app.getVersion = () => packageVersion;
app.focus = function () {};
const showMessageBox = electron.dialog.showMessageBox.bind(electron.dialog);
electron.dialog.showMessageBox = (...args) => {
  const options = args.at(-1);
  if (options?.message === '退出 LobsterAI？' || options?.message === 'Quit LobsterAI?') {
    return Promise.resolve({ response: 0, checkboxChecked: false });
  }
  return showMessageBox(...args);
};
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
BrowserWindow.prototype.focus = function () {};
// Native maximize transitions can stall hidden Windows windows. Keep a deterministic test viewport.
BrowserWindow.prototype.maximize = function () {};
BrowserWindow.prototype.unmaximize = function () {};
// Offscreen rendering keeps frames and hit testing current while every native window stays hidden.
class TestWindow extends BrowserWindow {
  constructor(options) {
    super({ ...options, width: 1280, height: 900, show: false, webPreferences: { ...options?.webPreferences, offscreen: true, backgroundThrottling: false } });
  }
  // Electron's BrowserWindow list excludes subclass constructors. Preserve broadcasts.
  static getAllWindows() {
    return electron.BaseWindow.getAllWindows().filter(window => Boolean(window.webContents));
  }
}
const Module = require('node:module');
const load = Module._load;
const testElectron = new Proxy({}, { get: (_target, key) => key === 'BrowserWindow' ? TestWindow : electron[key] });
Module._load = function (request, ...args) {
  return request === 'electron' ? testElectron : load.call(this, request, ...args);
};
require(path.join(root, 'dist-electron/main.js'));
