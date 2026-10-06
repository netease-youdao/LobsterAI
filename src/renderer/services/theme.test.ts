import { afterEach, describe, expect, test } from 'vitest';

import { SkinPreferredAppearance } from '../../shared/skin/constants';
import { themeService } from './theme';

afterEach(() => {
  themeService.setTheme('classic-light');
});

describe('AI skin theme binding resolution', () => {
  test('startup repair refreshes the default without replacing an active skin', async () => {
    await themeService.applySkinTheme('ocean');

    themeService.applyPersistedSelection({ mode: 'light', themeId: 'sakura' });

    expect(themeService.getEffectiveTheme()).toBe('dark');
    expect(themeService.getDefaultSelection()).toEqual({ mode: 'light', themeId: 'sakura' });
  });

  test('keeps a valid exact binding instead of following later default changes', () => {
    themeService.setTheme('sakura');

    expect(themeService.resolveSkinThemeId(
      'ocean',
      SkinPreferredAppearance.Dark,
    )).toBe('ocean');
  });

  test('uses the current default theme when it matches an upgraded skin', () => {
    themeService.setTheme('sakura');

    expect(themeService.resolveSkinThemeId(
      undefined,
      SkinPreferredAppearance.Light,
    )).toBe('sakura');
  });

  test('uses a deterministic compatible theme when the default appearance differs', () => {
    themeService.setTheme('sakura');

    expect(themeService.resolveSkinThemeId(
      undefined,
      SkinPreferredAppearance.Dark,
    )).toBe('classic-dark');
  });

  test('falls back safely when a previously bound theme no longer exists', () => {
    themeService.setTheme('midnight');

    expect(themeService.resolveSkinThemeId(
      'removed-theme',
      SkinPreferredAppearance.Dark,
    )).toBe('midnight');
  });
});
