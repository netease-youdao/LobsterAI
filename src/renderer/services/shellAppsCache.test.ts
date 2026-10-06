import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const installElectronMock = (
  getAppsForFile: (filePath: string) => Promise<{
    success: boolean;
    apps: Array<{ name: string; path: string; isDefault: boolean }>;
    error?: string;
  }>,
): void => {
  vi.stubGlobal('window', {
    electron: {
      shell: {
        getAppsForFile,
        getBrowserApps: vi.fn(),
      },
      log: {
        fromRenderer: vi.fn(),
      },
    },
  });
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeShellFilePath', () => {
  test('normalizes encoded macOS, Windows, and UNC file URLs', async () => {
    installElectronMock(vi.fn());
    const { normalizeShellFilePath } = await import('./shellAppsCache');

    expect(normalizeShellFilePath('file:///Users/test/My%20File.md')).toBe('/Users/test/My File.md');
    expect(normalizeShellFilePath('file:///C:/Users/test/My%20File.md')).toBe('C:/Users/test/My File.md');
    expect(normalizeShellFilePath('file://server/share/My%20File.md')).toBe('//server/share/My File.md');
    expect(normalizeShellFilePath('/Users/test/name with spaces.md')).toBe('/Users/test/name with spaces.md');
  });
});

describe('shell app lookup cache', () => {
  test('deduplicates concurrent lookups and caches an empty successful result', async () => {
    let resolveLookup: ((value: { success: boolean; apps: [] }) => void) | undefined;
    const getAppsForFile = vi.fn(() => new Promise<{ success: boolean; apps: [] }>(resolve => {
      resolveLookup = resolve;
    }));
    installElectronMock(getAppsForFile);
    const { prefetchAppsForFile } = await import('./shellAppsCache');

    const first = prefetchAppsForFile('/tmp/example.unknown');
    const second = prefetchAppsForFile('/tmp/another.unknown');
    expect(getAppsForFile).toHaveBeenCalledTimes(1);

    resolveLookup?.({ success: true, apps: [] });
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    await expect(prefetchAppsForFile('/tmp/third.unknown')).resolves.toEqual([]);
    expect(getAppsForFile).toHaveBeenCalledTimes(1);
  });

  test('bounds project and extension entries retained for renderer lifetime', async () => {
    const getAppsForFile = vi.fn(async (filePath: string) => ({
      success: true,
      apps: [{ name: filePath, path: filePath, isDefault: false }],
    }));
    installElectronMock(getAppsForFile);
    const {
      getCachedAppsForFile,
      prefetchAppsForFile,
    } = await import('./shellAppsCache');

    for (let index = 0; index < 65; index += 1) {
      await prefetchAppsForFile(`/tmp/cache-entry-${index}`);
    }

    expect(getCachedAppsForFile('/tmp/cache-entry-0')).toBeNull();
    expect(getCachedAppsForFile('/tmp/cache-entry-64')).toEqual([
      {
        name: '/tmp/cache-entry-64',
        path: '/tmp/cache-entry-64',
        isDefault: false,
      },
    ]);
  });
});
