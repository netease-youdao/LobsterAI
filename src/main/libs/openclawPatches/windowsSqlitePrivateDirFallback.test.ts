import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

const patchFile = 'openclaw-windows-sqlite-private-dir-fallback.patch';

describe(patchFile, () => {
  test('falls back to a plain directory only for disposable staging directories', () => {
    expectPatchContains(patchFile, [
      'diff --git a/src/infra/sqlite-private-directory.ts',
      'async function createStagingDirectoryWithFallback(directoryPath: string)',
      'function createStagingDirectoryWithFallbackSync(directoryPath: string)',
      '+  await createStagingDirectoryWithFallback(directoryPath);',
      '+  createStagingDirectoryWithFallbackSync(directoryPath);',
      '-  await createPrivateSqliteDirectory(directoryPath);',
      '-  createPrivateSqliteDirectorySync(directoryPath);',
    ]);
  });

  test('preserves EEXIST, PowerShell diagnostics and a single warning', () => {
    expectPatchContains(patchFile, [
      'if (isDirectoryExistsError(error)) {',
      'throw isDirectoryExistsError(fallbackError) ? fallbackError : error;',
      'if (privateStagingFallbackWarned) {',
      'falls back to a plain staging directory and warns once',
      'keeps the PowerShell diagnostics when the fallback also fails',
      'does not fall back when the private directory already exists',
      'keeps persistent private directories fail-closed',
    ]);
  });

  test('does not relax persistent private SQLite directories', () => {
    const patch = readCurrentOpenClawPatch(patchFile);
    expect(patch).not.toContain('-export async function createPrivateSqliteDirectory(');
    expect(patch).not.toMatch(/^-.*resolvePrivateDirectoryPowerShell/m);
  });
});
