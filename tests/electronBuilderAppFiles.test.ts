import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher');
const builderConfig = require('../electron-builder.json');
const packageJson = require('../package.json');

// electron-builder copies every production dependency into app.asar, while
// Vite bundles the main and renderer code. Only modules loaded or resolved
// from outside those bundles belong in dependencies.
const RUNTIME_DEPENDENCIES: Record<string, string> = {
  '@larksuite/openclaw-lark-tools': 'external in vite.config.ts',
  'better-sqlite3': 'native addon, external in vite.config.ts',
  bufferutil: 'optional ws native addon, external in vite.config.ts',
  'utf-8-validate': 'optional ws native addon, external in vite.config.ts',
  koffi: 'native FFI, plain require() in desktopCompanion/windowsNative.ts',
  'selection-hook': 'native addon, plain require() in desktopCompanion/companionSelection.ts',
  // The bundled @larksuiteoapi/node-sdk ESM build keeps a top-level
  // require('protobufjs/minimal'); without it the main process fails to start.
  protobufjs: 'top-level require() in the bundled Lark SDK',
  'pptx-preview': 'htmlPreviewServer serves its UMD build through require.resolve',
  '@modelcontextprotocol/sdk': 'imported by the spawned computer-use MCP server script',
  zod: 'imported by the spawned computer-use MCP server script',
  npm: 'CLI spawned from app.asar.unpacked',
  // coworkUtil puts app.asar/node_modules on NODE_PATH for skill processes.
  cheerio: 'SKILLs/content-planner scripts',
  react: 'SKILLs/pptx html2pptx guide',
  'react-dom': 'SKILLs/pptx html2pptx guide (react-dom/server)',
};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-app-files-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('app files ship the bundles without source maps or the tsc output tree', async () => {
  const root = tempDir();
  const shipped = [
    'dist/index.html',
    'dist/assets/main-abc123.js',
    'dist/pdfjs/pdf.worker.mjs',
    'dist-electron/main.js',
    'dist-electron/preload.js',
  ];
  const dropped = [
    'dist/assets/main-abc123.js.map',
    'dist-electron/main.js.map',
    'dist-electron/common/constants.js',
    'dist-electron/main/main.js',
    'dist-electron/renderer/types/index.js',
    'dist-electron/scheduledTask/cronJobService.js',
    'dist-electron/shared/agent/constants.js',
  ];
  for (const relative of [...shipped, ...dropped]) write(root, relative);

  const out = path.join(root, 'out');
  const matchers = getFileMatchers(builderConfig, 'files', out, {
    defaultSrc: root,
    globalOutDir: out,
    customBuildOptions: {},
    macroExpander: (value: string) => value,
  });
  // Top-level "!**/*.map" only reaches the app-root matcher; each FileSet
  // applies its own filter, so the exclusions must live in those filters.
  const fileSets = matchers.filter((matcher: { to: string }) =>
    ['dist', 'dist-electron'].includes(path.relative(out, matcher.to)));
  expect(fileSets).toHaveLength(2);
  await copyFiles(fileSets);

  for (const relative of shipped) expect(fs.existsSync(path.join(out, relative)), relative).toBe(true);
  for (const relative of dropped) expect(fs.existsSync(path.join(out, relative)), relative).toBe(false);
});

test('production dependencies are only the modules loaded outside the Vite bundles', () => {
  expect(
    Object.keys(packageJson.dependencies).sort(),
    'Bundled libraries go in devDependencies; a production dependency is copied into app.asar a second time.',
  ).toEqual(Object.keys(RUNTIME_DEPENDENCIES).sort());
});

test('protobufjs follows the range the bundled Lark SDK declares', () => {
  const larkSdk = require('@larksuiteoapi/node-sdk/package.json');
  expect(packageJson.dependencies.protobufjs).toBe(larkSdk.dependencies.protobufjs);
});

test('Windows keeps the Chromium locales that app.getLocale() must report', () => {
  // i18n picks Chinese only when app.getLocale() returns zh-CN; without its
  // .pak Chromium falls back to en-US and Chinese users would start in English.
  expect(builderConfig.win.electronLanguages).toEqual(expect.arrayContaining(['en-US', 'zh-CN']));
});
