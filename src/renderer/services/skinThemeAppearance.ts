import type { SkinPreferredAppearance } from '../../shared/skin/constants';
import type { ActiveSkin } from './skin';
import { skinService } from './skin';
import { themeService } from './theme';

type SkinThemeMetadata = Pick<
  ActiveSkin,
  'boundThemeId' | 'id' | 'presentation'
>;

interface SkinThemeDependencies {
  resolveThemeId: (
    boundThemeId: string | undefined,
    preferredAppearance: SkinPreferredAppearance | undefined,
  ) => string;
  bindTheme: (skinId: string, themeId: string) => Promise<SkinThemeMetadata | null>;
  applySkinTheme: (themeId: string) => Promise<void>;
  restoreDefaultTheme: () => Promise<unknown>;
}

const getDefaultDependencies = (): SkinThemeDependencies => ({
  resolveThemeId: (boundThemeId, preferredAppearance) => (
    themeService.resolveSkinThemeId(boundThemeId, preferredAppearance)
  ),
  bindTheme: (skinId, themeId) => skinService.bindTheme(skinId, themeId),
  applySkinTheme: themeId => themeService.applySkinTheme(themeId),
  restoreDefaultTheme: () => themeService.restoreDefaultTheme(),
});

export const synchronizeSkinTheme = async (
  skin: SkinThemeMetadata | null,
  dependencies: SkinThemeDependencies = getDefaultDependencies(),
): Promise<string | null> => {
  if (!skin) {
    await dependencies.restoreDefaultTheme();
    return null;
  }

  const preferredAppearance = skin.presentation?.preferredAppearance;
  let themeId = dependencies.resolveThemeId(
    skin.boundThemeId,
    preferredAppearance,
  );
  await dependencies.applySkinTheme(themeId);

  if (!skin.boundThemeId) {
    const persistedSkin = await dependencies.bindTheme(skin.id, themeId);
    const persistedThemeId = dependencies.resolveThemeId(
      persistedSkin?.boundThemeId ?? themeId,
      preferredAppearance,
    );
    if (persistedThemeId !== themeId) {
      themeId = persistedThemeId;
      await dependencies.applySkinTheme(themeId);
    }
  }

  return themeId;
};
