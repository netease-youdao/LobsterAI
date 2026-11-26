import { describe, expect, test } from 'vitest';

import {
  filterVisibleSettingsTabs,
  normalizeSettingsTab,
  RETIRED_SETTINGS_TABS,
  SETTINGS_TAB_ORDER,
  type SettingsTab,
  SettingsTabId,
} from './settingsTabs';

describe('settings tab normalization', () => {
  test('keeps the email skill settings tab active while retiring OpenClaw-only tabs', () => {
    expect(RETIRED_SETTINGS_TABS.has(SettingsTabId.Email)).toBe(false);
    expect(RETIRED_SETTINGS_TABS.has(SettingsTabId.CoworkAgentEngine)).toBe(true);
    expect(RETIRED_SETTINGS_TABS.has(SettingsTabId.CoworkDreaming)).toBe(true);
  });

  test('normalizeSettingsTab keeps all active tabs unchanged', () => {
    const activeTabs: SettingsTab[] = [
      SettingsTabId.General,
      SettingsTabId.Appearance,
      SettingsTabId.DesktopCompanion,
      SettingsTabId.Shortcuts,
      SettingsTabId.Model,
      SettingsTabId.CoworkMemory,
      SettingsTabId.BrowserWebAccess,
      SettingsTabId.Im,
      SettingsTabId.Email,
      SettingsTabId.Plugins,
      SettingsTabId.DataPrivacy,
      SettingsTabId.Experimental,
      SettingsTabId.Help,
      SettingsTabId.About,
    ];
    for (const tab of activeTabs) {
      expect(normalizeSettingsTab(tab)).toBe(tab);
    }
  });

  test('normalizeSettingsTab redirects undefined and retired tabs to general', () => {
    expect(normalizeSettingsTab(undefined)).toBe(SettingsTabId.General);
    expect(normalizeSettingsTab(SettingsTabId.CoworkAgentEngine)).toBe(SettingsTabId.General);
    expect(normalizeSettingsTab(SettingsTabId.CoworkDreaming)).toBe(SettingsTabId.General);
  });
});

describe('settings sidebar tab order', () => {
  const tabsByKey = new Map(SETTINGS_TAB_ORDER.map((key) => [key, { key, label: key }]));

  test('orders active tabs uniquely without retired tabs', () => {
    expect(new Set(SETTINGS_TAB_ORDER).size).toBe(SETTINGS_TAB_ORDER.length);
    for (const tabId of SETTINGS_TAB_ORDER) {
      expect(RETIRED_SETTINGS_TABS.has(tabId)).toBe(false);
    }
  });

  test('filters out tabs hidden by enterprise ui config while preserving order', () => {
    const visibleTabs = filterVisibleSettingsTabs(tabsByKey, {
      'settings.im': 'hide',
      'settings.dataPrivacy': 'hide',
    });

    expect(visibleTabs.map((tab) => tab.key)).toEqual([
      SettingsTabId.General,
      SettingsTabId.Appearance,
      SettingsTabId.DesktopCompanion,
      SettingsTabId.Model,
      SettingsTabId.BrowserWebAccess,
      SettingsTabId.CoworkMemory,
      SettingsTabId.Email,
      SettingsTabId.Plugins,
      SettingsTabId.Experimental,
      SettingsTabId.Shortcuts,
      SettingsTabId.Help,
      SettingsTabId.About,
    ]);
  });
});
