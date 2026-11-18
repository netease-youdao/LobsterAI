// Persistent, local-only Playwright test driver; JSON lines on stdin execute acceptance steps.
// Requires Playwright on NODE_PATH. Never sends OS keyboard or mouse input.
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const evidence = path.resolve(process.env.IMAGE_EDITING_EVIDENCE_DIR || 'D:/project/lobsterai-server/build/image-editing-acceptance');
const rendererUrl = process.env.IMAGE_EDITING_RENDERER_URL || 'http://localhost:5191';
if (process.env.IMAGE_EDITING_DATABASE_TEST !== 'true') throw new Error('Explicit test opt-in required');
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
let runningApp;
(async () => {
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'electron-launcher.cjs')],
    cwd: root, timeout: 60000, env: { ...process.env, NODE_ENV: 'development', ELECTRON_START_URL: rendererUrl,
      LOBSTERAI_DEV_USER_DATA_DIR: process.env.IMAGE_EDITING_DESKTOP_PROFILE || path.join(evidence, 'desktop-profile'), LOBSTER_SERVER_BASE_URL: 'http://127.0.0.1:18919' } });
  runningApp = app;
  let page;
  for (let i = 0; i < 300; i++) {
    page = app.windows().find(p => p.url() === new URL('/', rendererUrl).href);
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(page, 'Main renderer must be available');
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const shot = async name => {
    const window = await app.browserWindow(page);
    const png = await window.evaluate(async w => (await w.webContents.capturePage()).toPNG().toString('base64'));
    await fs.writeFile(path.join(evidence, `${name}.png`), Buffer.from(png, 'base64'));
  };
  const record = async (name, details) => {
    await fs.appendFile(path.join(evidence, 'ui-steps.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), name, details })}\n`);
  };
  console.log(JSON.stringify({ ready: true, pid: app.process().pid }));
  const input = readline.createInterface({ input: process.stdin });
  for await (const line of input) {
    try {
      const { code } = JSON.parse(line);
      const fn = new (Object.getPrototypeOf(async function(){}).constructor)('page', 'app', 'fs', 'path', 'evidence', 'shot', 'record', 'errors', 'assert', code);
      const result = await fn(page, app, fs, path, evidence, shot, record, errors, assert);
      console.log(JSON.stringify({ success: true, result: result ?? null }));
    } catch (error) { console.log(JSON.stringify({ success: false, error: error.stack })); }
  }
  await app.close();
})().catch(async error => { console.error(error); await runningApp?.close(); process.exitCode = 1; });
