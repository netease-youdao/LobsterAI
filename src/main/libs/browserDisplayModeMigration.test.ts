import { describe, expect, test, vi } from 'vitest';

import {
  BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
  BrowserDisplayMode,
  BrowserProfileMode,
} from '../../shared/browserWebAccess/constants';
import { migrateBrowserDisplayMode, migrateBrowserDisplayModeConfig } from './browserDisplayModeMigration';

describe('browser display migration', () => {
  test('preserves the external mode and connection configuration on DSH upgrade', () => {
    const config = {
      browserWebAccess: {
        displayMode: BrowserDisplayMode.External,
        profileMode: BrowserProfileMode.Custom,
        cdpUrl: 'http://127.0.0.1:9222',
        executablePath: 'browser-executable',
        remoteCdpHandshakeTimeoutMs: 4000,
        attachOnly: true,
        blockedHostnames: ['example.net'],
      },
      browserDisplayModeMigrationVersion: 1,
      other: 'retained',
    };
    expect(migrateBrowserDisplayModeConfig(config)).toEqual({
      ...config,
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    });
  });

  test('restores an implicit external choice from legacy non-headless config', () => {
    expect(migrateBrowserDisplayModeConfig({ browserWebAccess: { headless: false } }).browserWebAccess)
      .toEqual({ headless: false, displayMode: BrowserDisplayMode.External });
  });

  test('keeps explicit in-app choices and preserves their dormant external settings', () => {
    const browserWebAccess = { displayMode: BrowserDisplayMode.InApp, cdpUrl: 'http://127.0.0.1:9222' };
    const migrated = migrateBrowserDisplayModeConfig({ browserWebAccess, browserDisplayModeMigrationVersion: 2 });
    expect(migrated.browserWebAccess).toEqual(browserWebAccess);
    expect(migrateBrowserDisplayModeConfig(migrated)).toBe(migrated);
  });

  test('defaults existing installs without a choice and does not create a fresh configuration', () => {
    expect(migrateBrowserDisplayModeConfig({}).browserWebAccess?.displayMode).toBe(BrowserDisplayMode.InApp);
    const store = { get: () => undefined, set: vi.fn() };
    expect(migrateBrowserDisplayMode(store)).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
  });
});
