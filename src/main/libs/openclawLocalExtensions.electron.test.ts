import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { expect, test } from 'vitest';

import { removeTreeNoFollowSync } from './removeTreeNoFollow';

// Plain Node's recursive rm does not reproduce Electron's Windows junction bug.
// Compile the production owner and execute it with the app's actual Electron.
test.runIf(process.platform === 'win32')('Electron cleanup preserves a junction target and handles dangling links', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-junction-electron-')));
  const require = createRequire(import.meta.url);
  const electronPath = require('electron') as string;
  const ownerPath = path.join(root, 'owner.cjs');
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('./openclawLocalExtensions.ts', import.meta.url))],
      outfile: ownerPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      logLevel: 'silent',
    });
    const scriptPath = path.join(root, 'exercise.cjs');
    fs.writeFileSync(scriptPath, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = __dirname;
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'electron') return { app: { isPackaged: false, getAppPath: () => root } };
  return load.call(this, id, ...args);
};
const { cleanupStaleThirdPartyPluginsFromBundledDir } = require('./owner.cjs');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ openclaw: { plugins: [] } }));
const runtime = path.join(root, 'runtime');
const target = path.join(root, 'host-runtime');
const stale = path.join(runtime, 'extensions', 'test-plugin');
const link = path.join(stale, 'node_modules', 'openclaw');
for (const dir of [path.dirname(link), target]) fs.mkdirSync(dir, { recursive: true });
const marker = path.join(target, 'worker.js');
fs.writeFileSync(marker, 'host runtime worker');
fs.symlinkSync(target, link, 'junction');
assert(fs.lstatSync(link).isSymbolicLink());
assert.equal(fs.realpathSync(link), target);
// Both the deletion root and its link target are newly-created fixture children.
for (const dir of [stale, target]) {
  const relative = path.relative(root, path.resolve(dir));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
assert.deepEqual(cleanupStaleThirdPartyPluginsFromBundledDir(runtime, ['test-plugin']), ['test-plugin']);
assert.equal(fs.existsSync(stale), false);
assert.equal(fs.readFileSync(marker, 'utf8'), 'host runtime worker');
fs.symlinkSync(path.join(root, 'absent'), stale, 'junction');
assert.deepEqual(cleanupStaleThirdPartyPluginsFromBundledDir(runtime, ['test-plugin']), ['test-plugin']);
assert.equal(fs.lstatSync(stale, { throwIfNoEntry: false }), undefined);
console.log(JSON.stringify({ electron: process.versions.electron, workerPreserved: true }));
`);
    const result = await promisify(execFile)(electronPath, [scriptPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      timeout: 20_000,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ electron: expect.any(String), workerPreserved: true });
  } finally {
    // Teardown must also stop at any link left by a failed regression.
    removeTreeNoFollowSync(root);
  }
}, 30_000);
