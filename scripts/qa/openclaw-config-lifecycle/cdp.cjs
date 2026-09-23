'use strict';
const fs = require('node:fs');
const { inspectorPort } = require('./config.cjs');
const [surface, command, arg] = process.argv.slice(2);
(async () => {
  const port = inspectorPort;
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const tab = tabs[0];
  if (!tab) throw new Error('Debug target unavailable');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const waiting = new Map();
  ws.onclose = () => { for (const task of waiting.values()) task.reject(new Error('Debugger connection closed')); waiting.clear(); };
  ws.onmessage = e => {
    const data = JSON.parse(e.data), task = waiting.get(data.id);
    if (task) { waiting.delete(data.id); data.error ? task.reject(data.error) : task.resolve(data.result); }
  };
  const rawSend = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const send = async (method, params) => {
    if (surface === 'main') return rawSend(method, params);
    const result = await rawSend('Runtime.evaluate', {
      expression: `(async () => { const wc = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:')).webContents; if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); return wc.debugger.sendCommand(${JSON.stringify(method)}, ${JSON.stringify(params)}); })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  try {
    if (command === 'type') {
      const focused = await send('Runtime.evaluate', { expression: `(() => { const e = [...document.querySelectorAll('textarea')].find(e => e.offsetWidth && e.offsetHeight && !e.disabled); if (!e) throw new Error('No enabled visible prompt textarea'); e.focus(); return e.placeholder; })()`, returnByValue: true });
      if (focused.exceptionDetails) throw new Error(JSON.stringify(focused.exceptionDetails));
      await send('Input.insertText', { text: arg });
      console.log(JSON.stringify({ typed: arg, placeholder: focused.result.value }));
    } else if (command === 'key') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: arg, code: arg, windowsVirtualKeyCode: arg === 'Enter' ? 13 : 0 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: arg, code: arg, windowsVirtualKeyCode: arg === 'Enter' ? 13 : 0 });
      console.log(JSON.stringify({ key: arg }));
    } else if (command === 'screenshot') {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(arg, Buffer.from(result.data, 'base64'));
      console.log(JSON.stringify({ screenshot: arg }));
    } else {
      const expression = command === 'file' ? fs.readFileSync(arg, 'utf8') : arg;
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      console.log(JSON.stringify(result.result.value));
    }
  } finally { ws.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
