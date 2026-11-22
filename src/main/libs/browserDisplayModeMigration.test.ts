import { describe, expect, test } from 'vitest';

import {
  BrowserCredentialSaveMode,
  BrowserCredentialUseMode,
} from '../../shared/browserCredentials/constants';
import {
  BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
  BrowserDisplayMode,
  BrowserNetworkMode,
} from '../../shared/browserWebAccess/constants';
import {
  APP_CONFIG_KEY,
  migrateBrowserDisplayModeConfig,
  migrateBrowserDisplayModeToInApp,
} from './browserDisplayModeMigration';

const createStore = (initial: Record<string, unknown>) => {
  const values = new Map(Object.entries(initial));
  return {
    get: <T,>(key: string) => values.get(key) as T | undefined,
    set: <T,>(key: string, value: T) => {
      values.set(key, value);
    },
    values,
  };
};

describe('migrateBrowserDisplayModeToInApp', () => {
  test('migrates external browser config with version 0 / missing, strips dead external fields, and preserves reusable settings', () => {
    const store = createStore({
      [APP_CONFIG_KEY]: {
        theme: 'dark',
        browserDisplayModeMigrationVersion: 0,
        browserWebAccess: {
          displayMode: BrowserDisplayMode.External,
          networkMode: BrowserNetworkMode.Strict,
          credentialUseMode: BrowserCredentialUseMode.OncePerTask,
          credentialSaveMode: BrowserCredentialSaveMode.Never,
          blockedHostnames: ['https://blocked.example.com'],
          executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          cdpUrl: 'http://127.0.0.1:9222',
          headless: false,
          attachOnly: true,
          remoteCdpTimeoutMs: 15000,
          remoteCdpHandshakeTimeoutMs: 5000,
          extraArgs: ['--remote-debugging-port=9222'],
        },
      },
    });

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(true);
    expect(store.values.get(APP_CONFIG_KEY)).toEqual({
      theme: 'dark',
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.Strict,
        credentialUseMode: BrowserCredentialUseMode.OncePerTask,
        credentialSaveMode: BrowserCredentialSaveMode.Never,
        blockedHostnames: ['https://blocked.example.com'],
      },
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    });
  });

  test('rescues external browser lockout when browserDisplayModeMigrationVersion is 1', () => {
    const store = createStore({
      [APP_CONFIG_KEY]: {
        theme: 'light',
        browserDisplayModeMigrationVersion: 1,
        browserWebAccess: {
          displayMode: BrowserDisplayMode.External,
          networkMode: BrowserNetworkMode.Strict,
          credentialUseMode: BrowserCredentialUseMode.Disabled,
          credentialSaveMode: BrowserCredentialSaveMode.Never,
          blockedHostnames: ['https://tracker.example.com', 'https://ads.example.com'],
          cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
          executablePath: '/usr/bin/chromium',
          attachOnly: true,
          remoteCdpTimeoutMs: 10000,
          remoteCdpHandshakeTimeoutMs: 4000,
          extraArgs: ['--disable-gpu'],
        },
      },
    });

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(true);
    expect(store.values.get(APP_CONFIG_KEY)).toEqual({
      theme: 'light',
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.Strict,
        credentialUseMode: BrowserCredentialUseMode.Disabled,
        credentialSaveMode: BrowserCredentialSaveMode.Never,
        blockedHostnames: ['https://tracker.example.com', 'https://ads.example.com'],
      },
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    });

    // Running again is an idempotent no-op.
    const migratedSnapshot = store.values.get(APP_CONFIG_KEY);
    expect(migrateBrowserDisplayModeToInApp(store)).toBe(false);
    expect(store.values.get(APP_CONFIG_KEY)).toBe(migratedSnapshot);
  });

  test('enforces in-app mode even when browserDisplayModeMigrationVersion is already current', () => {
    const store = createStore({
      [APP_CONFIG_KEY]: {
        browserWebAccess: {
          displayMode: BrowserDisplayMode.External,
          networkMode: BrowserNetworkMode.Strict,
          blockedHostnames: ['https://internal.example.com'],
        },
        browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
      },
    });

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(true);
    expect(store.values.get(APP_CONFIG_KEY)).toEqual({
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.Strict,
        blockedHostnames: ['https://internal.example.com'],
      },
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    });
  });

  test('migrates legacy headless=false config without displayMode and reports external config', () => {
    const result = migrateBrowserDisplayModeConfig({
      browserWebAccess: {
        headless: false,
        networkMode: BrowserNetworkMode.ProxyCompatible,
        blockedHostnames: ['https://deny.example.com'],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.migratedExternalConfig).toBe(true);
    expect(result.archivedExternalConfig).toEqual({ headless: false });
    expect(result.nextConfig).toEqual({
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.ProxyCompatible,
        blockedHostnames: ['https://deny.example.com'],
      },
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    });
  });

  test('bumps version for existing in-app config without flagging external migration', () => {
    const result = migrateBrowserDisplayModeConfig({
      browserDisplayModeMigrationVersion: 1,
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.Strict,
        credentialUseMode: BrowserCredentialUseMode.AlwaysAsk,
        credentialSaveMode: BrowserCredentialSaveMode.Ask,
        blockedHostnames: ['https://example.com'],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.migratedExternalConfig).toBe(false);
    expect(result.archivedExternalConfig).toBeUndefined();
    expect(result.nextConfig).toEqual({
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.Strict,
        credentialUseMode: BrowserCredentialUseMode.AlwaysAsk,
        credentialSaveMode: BrowserCredentialSaveMode.Ask,
        blockedHostnames: ['https://example.com'],
      },
    });
  });

  test('is a no-op when already migrated to in-app with no external-only fields', () => {
    const appConfig = {
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.ProxyCompatible,
      },
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    };
    const store = createStore({ [APP_CONFIG_KEY]: appConfig });

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(false);
    expect(store.values.get(APP_CONFIG_KEY)).toBe(appConfig);
  });

  test('migrates configs saved before browser settings existed', () => {
    const store = createStore({ [APP_CONFIG_KEY]: { language: 'zh' } });

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(true);
    expect(store.values.get(APP_CONFIG_KEY)).toMatchObject({
      language: 'zh',
      browserWebAccess: { displayMode: BrowserDisplayMode.InApp },
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    });
  });

  test('does not create an app config for a fresh install', () => {
    const store = createStore({});

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(false);
    expect(store.values.has(APP_CONFIG_KEY)).toBe(false);
  });
});
