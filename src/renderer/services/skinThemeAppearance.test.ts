import { describe, expect, test, vi } from 'vitest';

import {
  SkinPreferredAppearance,
  SkinPresentationMode,
} from '../../shared/skin/constants';
import type { ActiveSkin } from './skin';
import { synchronizeSkinTheme } from './skinThemeAppearance';

const darkSkin: Pick<ActiveSkin, 'boundThemeId' | 'id' | 'presentation'> = {
  id: 'dark-red',
  presentation: {
    mode: SkinPresentationMode.ImmersiveShell,
    preferredAppearance: SkinPreferredAppearance.Dark,
    palette: {
      canvas: '#110a0a',
      panel: '#1f0e0e',
      panelRaised: '#2d1515',
      accent: '#e5b941',
      accentForeground: '#160b0d',
      accentAlt: '#d4372b',
      foreground: '#f2e6d9',
      muted: '#b8948a',
      border: '#745126',
    },
  },
};

const createDependencies = () => ({
  resolveThemeId: vi.fn((
    boundThemeId: string | undefined,
    preferredAppearance: SkinPreferredAppearance | undefined,
  ) => boundThemeId ?? (preferredAppearance === SkinPreferredAppearance.Dark
    ? 'classic-dark'
    : 'classic-light')),
  bindTheme: vi.fn(async (skinId: string, themeId: string) => ({
    id: skinId,
    boundThemeId: themeId,
  })),
  applySkinTheme: vi.fn(async () => undefined),
  restoreDefaultTheme: vi.fn(async () => undefined),
});

describe('skin theme synchronization', () => {
  test('binds an upgraded skin on first activation and applies the resolved theme', async () => {
    const dependencies = createDependencies();

    await expect(synchronizeSkinTheme(darkSkin, dependencies))
      .resolves.toBe('classic-dark');

    expect(dependencies.bindTheme).toHaveBeenCalledWith('dark-red', 'classic-dark');
    expect(dependencies.applySkinTheme).toHaveBeenCalledWith('classic-dark');
    expect(dependencies.restoreDefaultTheme).not.toHaveBeenCalled();
  });

  test('reapplies an existing immutable binding on every synchronization', async () => {
    const dependencies = createDependencies();
    const boundSkin = {
      ...darkSkin,
      boundThemeId: 'midnight',
    };

    await synchronizeSkinTheme(boundSkin, dependencies);
    await synchronizeSkinTheme(boundSkin, dependencies);

    expect(dependencies.bindTheme).not.toHaveBeenCalled();
    expect(dependencies.applySkinTheme).toHaveBeenCalledTimes(2);
    expect(dependencies.applySkinTheme).toHaveBeenNthCalledWith(1, 'midnight');
    expect(dependencies.applySkinTheme).toHaveBeenNthCalledWith(2, 'midnight');
  });

  test('uses the default theme when upgrading a legacy skin without presentation metadata', async () => {
    const dependencies = createDependencies();
    const legacySkin = { id: 'legacy-skin' };

    await expect(synchronizeSkinTheme(legacySkin, dependencies))
      .resolves.toBe('classic-light');

    expect(dependencies.resolveThemeId).toHaveBeenCalledWith(undefined, undefined);
    expect(dependencies.bindTheme).toHaveBeenCalledWith('legacy-skin', 'classic-light');
  });

  test('restores the saved default theme when no AI skin is active', async () => {
    const dependencies = createDependencies();

    await expect(synchronizeSkinTheme(null, dependencies)).resolves.toBeNull();

    expect(dependencies.restoreDefaultTheme).toHaveBeenCalledOnce();
    expect(dependencies.applySkinTheme).not.toHaveBeenCalled();
    expect(dependencies.bindTheme).not.toHaveBeenCalled();
  });

  test('honors a binding won by another window during the compatibility write', async () => {
    const dependencies = createDependencies();
    dependencies.bindTheme.mockResolvedValue({
      id: 'dark-red',
      boundThemeId: 'ocean',
    });

    await expect(synchronizeSkinTheme(darkSkin, dependencies)).resolves.toBe('ocean');

    expect(dependencies.applySkinTheme).toHaveBeenNthCalledWith(1, 'classic-dark');
    expect(dependencies.applySkinTheme).toHaveBeenNthCalledWith(2, 'ocean');
  });
});
