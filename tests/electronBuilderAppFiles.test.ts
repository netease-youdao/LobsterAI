import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { getFileMatchers, getMainFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher');
const { computeFileSets } = require('app-builder-lib/out/util/appFileCopier');
const builderConfig = require('../electron-builder.json');
const packageJson = require('../package.json');

// electron-builder copies every production dependency into app.asar, while
// Vite bundles the main and renderer code. Only modules loaded or resolved
// from outside those bundles belong in dependencies.
const RUNTIME_DEPENDENCIES: Record<string, string> = {
  'better-sqlite3': 'native addon, external in vite.config.ts',
  'playwright-core': 'external CDP client, external in vite.config.ts',
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
  cheerio: 'legacy/marketplace content-planner scripts',
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

test('dsh-runtime maps into app.asar/dsh-runtime without .bin symlinks, maps, or test files, and unpacks native/pnpm payloads', async () => {
  const root = tempDir();
  const kept = [
    'vendor/dsh-runtime/current/package.json',
    'vendor/dsh-runtime/current/lib/bin.js',
    'vendor/dsh-runtime/current/package-manager/pnpm/package.json',
    'vendor/dsh-runtime/current/package-manager/pnpm/bin/pnpm.cjs',
    'vendor/dsh-runtime/current/node_modules/koffi/build/koffi/win32_x64/koffi.node',
    'vendor/dsh-runtime/current/node_modules/node-pty/lib/index.js',
    'vendor/dsh-runtime/current/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/acl.ps1',
  ];
  const dropped = [
    'vendor/dsh-runtime/current/node_modules/.bin/tsc',
    'vendor/dsh-runtime/current/lib/bin.js.map',
    'vendor/dsh-runtime/current/node_modules/pkg/index.d.ts',
    'vendor/dsh-runtime/current/node_modules/pkg/test/spec.js',
  ];
  for (const relative of [...kept, ...dropped]) write(root, relative);

  const out = path.join(root, 'out');
  const matchers = getFileMatchers(builderConfig, 'files', out, {
    defaultSrc: root,
    globalOutDir: out,
    customBuildOptions: {},
    macroExpander: (value: string) => value,
  });
  const dshMatcher = matchers.filter((matcher: { to: string }) =>
    path.relative(out, matcher.to) === 'dsh-runtime');
  expect(dshMatcher).toHaveLength(1);
  await copyFiles(dshMatcher);

  for (const relative of kept) {
    const destRel = relative.replace('vendor/dsh-runtime/current/', 'dsh-runtime/');
    expect(fs.existsSync(path.join(out, destRel)), destRel).toBe(true);
  }
  for (const relative of dropped) {
    const destRel = relative.replace('vendor/dsh-runtime/current/', 'dsh-runtime/');
    expect(fs.existsSync(path.join(out, destRel)), destRel).toBe(false);
  }

  // Verify electron-builder's asarUnpack filter matches source paths under vendor/dsh-runtime/current.
  const unpackMatchers = getFileMatchers(builderConfig, 'asarUnpack', out, {
    defaultSrc: root,
    globalOutDir: out,
    customBuildOptions: {},
    macroExpander: (value: string) => value,
  });
  const unpackFilter = unpackMatchers[0].createFilter();
  const dummyStat = { isDirectory: () => false };
  expect(unpackFilter(path.join(root, 'vendor/dsh-runtime/current/package-manager/pnpm/bin/pnpm.cjs'), dummyStat)).toBe(true);
  expect(unpackFilter(path.join(root, 'vendor/dsh-runtime/current/node_modules/koffi/build/koffi/win32_x64/koffi.node'), dummyStat)).toBe(true);
  expect(unpackFilter(path.join(root, 'vendor/dsh-runtime/current/node_modules/node-pty/lib/index.js'), dummyStat)).toBe(true);
  expect(unpackFilter(path.join(root, 'vendor/dsh-runtime/current/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/acl.ps1'), dummyStat)).toBe(true);
  // Pure JS runtime files stay packed inside app.asar.
  expect(unpackFilter(path.join(root, 'vendor/dsh-runtime/current/lib/bin.js'), dummyStat)).toBe(false);
  expect(unpackFilter(path.join(root, 'vendor/dsh-runtime/current/package.json'), dummyStat)).toBe(false);

  // AppFileWalker drops sub-node_modules inside `files` entries unless
  // includeSubNodeModules is enabled, while root node_modules must still be
  // excluded from the root matcher (production deps come from computeNodeModuleFileSets).
  expect(builderConfig.includeSubNodeModules).toBe(true);
  write(root, 'package.json');
  write(root, 'node_modules/dev-only-pkg/index.js');
  write(root, 'vendor/dsh-runtime/current/node_modules/@deepseek-ai/dsh-app-boot/package.json');
  const packager = {
    info: {
      appDir: root,
      projectDir: root,
      buildResourcesDir: 'build',
      config: builderConfig,
      isPrepackedAppAsar: false,
      areNodeModulesHandledExternally: false,
      debugLogger: { isEnabled: false },
    },
  };
  const mainMatchers = getMainFileMatchers(
    root,
    path.join(out, 'app'),
    (value: string) => value,
    {},
    packager,
    out,
    false,
  );
  const computedSets: Array<{ src: string; destination: string; files: string[] }> = await computeFileSets(
    mainMatchers,
    null,
    packager,
    false,
  );
  const collectedDestPaths = computedSets.flatMap((set) =>
    set.files.map((file) => path.relative(path.join(out, 'app'), path.join(set.destination, path.relative(set.src, file))).replace(/\\/g, '/')),
  );
  expect(collectedDestPaths).toContain('dsh-runtime/node_modules/@deepseek-ai/dsh-app-boot/package.json');
  expect(collectedDestPaths).toContain('dsh-runtime/package-manager/pnpm/bin/pnpm.cjs');
  expect(collectedDestPaths).not.toContain('node_modules/dev-only-pkg/index.js');
});

test('production dependencies are only the modules loaded outside the Vite bundles', () => {
  expect(
    Object.keys(packageJson.dependencies).sort(),
    'Bundled libraries go in devDependencies; a production dependency is copied into app.asar a second time.',
  ).toEqual(Object.keys(RUNTIME_DEPENDENCIES).sort());
});

test('production dependencies contain zero OpenClaw packages', () => {
  const openclawDeps = Object.keys(packageJson.dependencies).filter((dep) =>
    dep.toLowerCase().includes('openclaw'),
  );
  expect(openclawDeps).toEqual([]);
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
