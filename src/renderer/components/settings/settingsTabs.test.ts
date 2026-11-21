import { describe, expect, test } from 'vitest';

import {
  normalizeSettingsTab,
  RETIRED_SETTINGS_TABS,
  type SettingsTab,
} from './settingsTabs';

describe('settings tab normalization', () => {
  test('keeps the email skill settings tab active while retiring OpenClaw-only tabs', () => {
    expect(RETIRED_SETTINGS_TABS.has('email')).toBe(false);
    expect(RETIRED_SETTINGS_TABS.has('coworkAgentEngine')).toBe(true);
    expect(RETIRED_SETTINGS_TABS.has('coworkDreaming')).toBe(true);
  });

  test('normalizeSettingsTab keeps email and other active tabs unchanged', () => {
    const activeTabs: SettingsTab[] = [
      'general',
      'appearance',
      'desktopCompanion',
      'model',
      'im',
      'browserWebAccess',
      'email',
      'coworkMemory',
      'plugins',
      'experimental',
      'shortcuts',
      'help',
      'about',
    ];
    for (const tab of activeTabs) {
      expect(normalizeSettingsTab(tab)).toBe(tab);
    }
  });

  test('normalizeSettingsTab redirects undefined and retired tabs to general', () => {
    expect(normalizeSettingsTab(undefined)).toBe('general');
    expect(normalizeSettingsTab('coworkAgentEngine')).toBe('general');
    expect(normalizeSettingsTab('coworkDreaming')).toBe('general');
  });
});
