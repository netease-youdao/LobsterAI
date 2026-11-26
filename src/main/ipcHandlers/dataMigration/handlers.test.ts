import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { resolvePluginInstallTarget } from './handlers';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('resolvePluginInstallTarget', () => {
  test('combines package name and semver specifier for npm registry packages', () => {
    expect(
      resolvePluginInstallTarget({
        name: 'dsh-plugin-weather',
        specifier: '^1.2.3',
        enabled: true,
      }),
    ).toEqual({
      target: 'dsh-plugin-weather@^1.2.3',
      skippedLocalPath: false,
    });

    expect(
      resolvePluginInstallTarget({
        name: '@org/custom-dsh-plugin',
        specifier: '2.0.0',
        enabled: false,
      }),
    ).toEqual({
      target: '@org/custom-dsh-plugin@2.0.0',
      skippedLocalPath: false,
    });
  });

  test('passes direct git/url specifiers through as-is', () => {
    expect(
      resolvePluginInstallTarget({
        name: 'dsh-plugin-git',
        specifier: 'https://github.com/example/dsh-plugin-git.git',
        enabled: true,
      }),
    ).toEqual({
      target: 'https://github.com/example/dsh-plugin-git.git',
      skippedLocalPath: false,
    });
  });

  test('skips missing local file: plugin paths cleanly', () => {
    const res = resolvePluginInstallTarget({
      name: 'local-plugin',
      specifier: 'file:/nonexistent/source/machine/local-plugin',
      enabled: true,
      isLocalPath: true,
    });
    expect(res.target).toBeNull();
    expect(res.skippedLocalPath).toBe(true);
    expect(res.error).toContain('does not exist');
  });

  test('accepts existing local file: plugin paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-local-plugin-'));
    tempDirs.push(dir);
    const res = resolvePluginInstallTarget({
      name: 'local-plugin',
      specifier: `file:${dir}`,
      enabled: true,
      isLocalPath: true,
    });
    expect(res).toEqual({
      target: `file:${dir}`,
      skippedLocalPath: false,
    });
  });
});
