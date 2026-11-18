import { describe, expect, test } from 'vitest';

import {
  BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
  BrowserDisplayMode,
  BrowserNetworkMode,
} from '../../shared/browserWebAccess/constants';
import { migrateBrowserDisplayModeToInApp } from './browserDisplayModeMigration';

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
  test('switches an existing external browser config once and keeps other settings', () => {
    const store = createStore({
      app_config: {
        theme: 'dark',
        browserWebAccess: {
          displayMode: BrowserDisplayMode.External,
          networkMode: BrowserNetworkMode.Strict,
        },
      },
    });

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(true);
    expect(store.values.get('app_config')).toEqual({
      theme: 'dark',
      browserWebAccess: {
        displayMode: BrowserDisplayMode.InApp,
        networkMode: BrowserNetworkMode.Strict,
      },
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    });
  });

  test('keeps an explicit choice made after the migration was applied', () => {
    const appConfig = {
      browserWebAccess: { displayMode: BrowserDisplayMode.External },
      browserDisplayModeMigrationVersion: BROWSER_DISPLAY_MODE_MIGRATION_VERSION,
    };
    const store = createStore({ app_config: appConfig });

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(false);
    expect(store.values.get('app_config')).toBe(appConfig);
  });

  test('migrates configs saved before browser settings existed', () => {
    const store = createStore({ app_config: { language: 'zh' } });

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(true);
    expect(store.values.get('app_config')).toMatchObject({
      language: 'zh',
      browserWebAccess: { displayMode: BrowserDisplayMode.InApp },
    });
  });

  test('does not create an app config for a fresh install', () => {
    const store = createStore({});

    expect(migrateBrowserDisplayModeToInApp(store)).toBe(false);
    expect(store.values.has('app_config')).toBe(false);
  });
});
