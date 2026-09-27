import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  LEGACY_PRIVATE_DIRECTORY_MARKER,
  NATIVE_PRIVATE_DIRECTORY_MARKER,
  assertOpenClawBundleUsesNativePrivateDirectory,
  assertOpenClawSourceUsesNativePrivateDirectory,
} = require('../scripts/openclaw-native-private-directory.cjs');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-native-private-dir-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function sourceTree(options: { helper?: string | null; owner?: string } = {}): string {
  const root = tempDir();
  if (options.helper !== null) {
    write(root, 'src/infra/windows-private-directory.ts',
      options.helper ?? `const sddl = \`O:\${sid}D:P(A;OICI;FA;;;\${sid})${NATIVE_PRIVATE_DIRECTORY_MARKER}\`;`);
  }
  write(root, 'src/infra/sqlite-private-directory.ts',
    options.owner ?? 'import { createPrivateWindowsDirectory } from "./windows-private-directory.js";');
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts a patched source tree', () => {
  expect(() => assertOpenClawSourceUsesNativePrivateDirectory(sourceTree())).not.toThrow();
});

test('rejects a source tree without the native helper', () => {
  expect(() => assertOpenClawSourceUsesNativePrivateDirectory(sourceTree({ helper: null })))
    .toThrow(/openclaw-windows-private-directory-native\.patch/);
  expect(() => assertOpenClawSourceUsesNativePrivateDirectory(sourceTree({ helper: 'export {};' })))
    .toThrow(/run openclaw:patch first/);
});

test('rejects an owner that still spawns PowerShell', () => {
  const legacyOwner = `public static class ${LEGACY_PRIVATE_DIRECTORY_MARKER} {}`;
  expect(() => assertOpenClawSourceUsesNativePrivateDirectory(sourceTree({ owner: legacyOwner })))
    .toThrow(/still spawns PowerShell/);
  expect(() => assertOpenClawSourceUsesNativePrivateDirectory(sourceTree({ owner: 'export {};' })))
    .toThrow(/still spawns PowerShell/);
});

test('accepts bundles that pair private-directory consumers with the native helper', () => {
  const root = tempDir();
  const consumer = write(root, 'gateway-bundle.mjs',
    `const a=["--openclaw-sqlite-readonly-child","sync"];const s="${NATIVE_PRIVATE_DIRECTORY_MARKER}";`);
  expect(assertOpenClawBundleUsesNativePrivateDirectory(consumer)).toBe(true);
  const importer = write(root, 'worker.mjs',
    `const d=x(os.tmpdir(),"openclaw-session-import-");const s="${NATIVE_PRIVATE_DIRECTORY_MARKER}";`);
  expect(assertOpenClawBundleUsesNativePrivateDirectory(importer)).toBe(true);
  const unrelated = write(root, 'openclaw-gateway-repair.mjs', 'export const repair = true;');
  expect(assertOpenClawBundleUsesNativePrivateDirectory(unrelated)).toBe(false);
  // esbuild keeps pid-bearing staging prefixes as side effects after dropping every creator.
  const constantsOnly = write(root, 'openclaw-gateway-repair-constants.mjs',
    'const p=`openclaw-sqlite-readonly-${process.pid}-`,r=`openclaw-sqlite-result-${process.pid}-`;');
  expect(assertOpenClawBundleUsesNativePrivateDirectory(constantsOnly)).toBe(false);
});

test('rejects bundles that embed the PowerShell helper or drop the native helper', () => {
  const root = tempDir();
  const legacy = write(root, 'legacy.mjs',
    `const src="public static class ${LEGACY_PRIVATE_DIRECTORY_MARKER}";const p="openclaw-session-import-";`);
  expect(() => assertOpenClawBundleUsesNativePrivateDirectory(legacy)).toThrow(/still embeds the PowerShell/);
  const stale = write(root, 'stale.mjs', 'const a=["--openclaw-sqlite-readonly-child","async"];');
  expect(() => assertOpenClawBundleUsesNativePrivateDirectory(stale)).toThrow(/without the native Windows helper/);
});
