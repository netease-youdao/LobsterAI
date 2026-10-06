import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { SkinAssetSlot } from '../../shared/skin/constants';
import {
  type ActiveSkin,
  buildSkinAssetUrl,
  skinService,
} from '../services/skin';
import { synchronizeSkinTheme } from '../services/skinThemeAppearance';
import {
  type ThemeMode,
  type ThemeSelection,
  themeService,
} from '../services/theme';

interface SkinContextValue {
  activeSkin: ActiveSkin | null;
  savedSkins: ActiveSkin[];
  isLoading: boolean;
  isAppearanceChanging: boolean;
  refreshVersion: number;
  refresh: () => Promise<void>;
  apply: (skinId: string) => Promise<void>;
  deactivate: () => Promise<void>;
  deleteSkin: (skinId: string) => Promise<void>;
  selectThemeMode: (mode: ThemeMode) => Promise<ThemeSelection>;
  selectThemeById: (themeId: string) => Promise<ThemeSelection>;
}

const SkinContext = createContext<SkinContextValue | null>(null);

export const SkinProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [activeSkin, setActiveSkin] = useState<ActiveSkin | null>(null);
  const [savedSkins, setSavedSkins] = useState<ActiveSkin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAppearanceChanging, setIsAppearanceChanging] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const activeSkinRef = useRef<ActiveSkin | null>(null);
  const savedSkinsRef = useRef<ActiveSkin[]>([]);
  const loadSequenceRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingMutationCountRef = useRef(0);

  const refresh = useCallback(async () => {
    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;
    setIsLoading(true);

    try {
      const [nextSkin, nextSavedSkins] = await Promise.all([
        skinService.getActive(),
        skinService.list(),
      ]);
      if (loadSequence !== loadSequenceRef.current) return;

      activeSkinRef.current = nextSkin;
      savedSkinsRef.current = nextSavedSkins;
      setActiveSkin(nextSkin);
      setSavedSkins(nextSavedSkins);
      setRefreshVersion(version => version + 1);
    } catch (error) {
      if (loadSequence !== loadSequenceRef.current) return;
      console.error('[Skin] Failed to load the active skin', error);
    } finally {
      if (loadSequence === loadSequenceRef.current) setIsLoading(false);
    }
  }, []);

  const enqueueAppearanceMutation = useCallback(<T,>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    pendingMutationCountRef.current += 1;
    setIsAppearanceChanging(true);

    const result = mutationQueueRef.current.then(operation, operation);
    mutationQueueRef.current = result.then(
      (): void => undefined,
      (): void => undefined,
    );

    return result.finally(() => {
      pendingMutationCountRef.current -= 1;
      if (pendingMutationCountRef.current === 0) {
        setIsAppearanceChanging(false);
      }
    });
  }, []);

  const resolveSkinThemeId = useCallback((skin: ActiveSkin): string => (
    themeService.resolveSkinThemeId(
      skin.boundThemeId,
      skin.presentation?.preferredAppearance,
    )
  ), []);

  const restorePreviousAppearance = useCallback(async (
    previousSkin: ActiveSkin | null,
  ): Promise<void> => {
    if (!previousSkin) {
      await themeService.restoreDefaultTheme();
      return;
    }

    const previousThemeId = resolveSkinThemeId(previousSkin);
    await themeService.applySkinTheme(previousThemeId);
    await skinService.apply(previousSkin.id, previousThemeId);
  }, [resolveSkinThemeId]);

  const apply = useCallback((skinId: string): Promise<void> => (
    enqueueAppearanceMutation(async () => {
      if (skinId === activeSkinRef.current?.id) return;

      const availableSkins = savedSkinsRef.current.length > 0
        ? savedSkinsRef.current
        : await skinService.list();
      const targetSkin = availableSkins.find(skin => skin.id === skinId);
      if (!targetSkin) {
        throw new Error(`Skin "${skinId}" is unavailable`);
      }

      const previousSkin = activeSkinRef.current;
      const targetThemeId = resolveSkinThemeId(targetSkin);
      let activeSkinChanged = false;

      try {
        await themeService.applySkinTheme(targetThemeId);
        const appliedSkin = await skinService.apply(skinId, targetThemeId);
        activeSkinChanged = true;
        const persistedThemeId = appliedSkin
          ? resolveSkinThemeId(appliedSkin)
          : targetThemeId;
        if (persistedThemeId !== targetThemeId) {
          await themeService.applySkinTheme(persistedThemeId);
        }
        await refresh();
      } catch (error) {
        if (activeSkinChanged) {
          if (previousSkin) {
            const previousThemeId = resolveSkinThemeId(previousSkin);
            await skinService.apply(previousSkin.id, previousThemeId).catch(() => undefined);
          } else {
            await skinService.deactivate().catch(() => undefined);
          }
        }
        await restorePreviousAppearance(previousSkin).catch(() => undefined);
        await refresh();
        throw error;
      }
    })
  ), [
    enqueueAppearanceMutation,
    refresh,
    resolveSkinThemeId,
    restorePreviousAppearance,
  ]);

  const deactivate = useCallback((): Promise<void> => (
    enqueueAppearanceMutation(async () => {
      const previousSkin = activeSkinRef.current;
      try {
        await skinService.deactivate();
        await themeService.restoreDefaultTheme();
        await refresh();
      } catch (error) {
        await restorePreviousAppearance(previousSkin).catch(() => undefined);
        await refresh();
        throw error;
      }
    })
  ), [enqueueAppearanceMutation, refresh, restorePreviousAppearance]);

  const selectDefaultTheme = useCallback((
    selection: () => Promise<ThemeSelection>,
  ): Promise<ThemeSelection> => (
    enqueueAppearanceMutation(async () => {
      const previousSkin = activeSkinRef.current;
      try {
        if (previousSkin) {
          await skinService.deactivate();
        }
        const nextSelection = await selection();
        await refresh();
        return nextSelection;
      } catch (error) {
        await restorePreviousAppearance(previousSkin).catch(() => undefined);
        await refresh();
        throw error;
      }
    })
  ), [enqueueAppearanceMutation, refresh, restorePreviousAppearance]);

  const selectThemeMode = useCallback((mode: ThemeMode): Promise<ThemeSelection> => (
    selectDefaultTheme(() => themeService.selectDefaultThemeMode(mode))
  ), [selectDefaultTheme]);

  const selectThemeById = useCallback((themeId: string): Promise<ThemeSelection> => (
    selectDefaultTheme(() => themeService.selectDefaultThemeById(themeId))
  ), [selectDefaultTheme]);

  const deleteSkin = useCallback((skinId: string): Promise<void> => (
    enqueueAppearanceMutation(async () => {
      const wasActive = activeSkinRef.current?.id === skinId;
      await skinService.delete(skinId);
      if (wasActive) {
        await themeService.restoreDefaultTheme().catch((error) => {
          console.error('[Skin] Failed to restore the default theme after deletion', error);
        });
      }
      await refresh();
    })
  ), [enqueueAppearanceMutation, refresh]);

  useEffect(() => {
    void refresh();
    return skinService.subscribe(() => {
      void refresh();
    });
  }, [refresh]);

  useEffect(() => {
    if (isLoading) return;
    void enqueueAppearanceMutation(
      () => synchronizeSkinTheme(activeSkin),
    ).catch((error) => {
      console.error('[Skin] Failed to synchronize the bound color theme', error);
    });
  }, [activeSkin, enqueueAppearanceMutation, isLoading]);

  const value = useMemo<SkinContextValue>(() => ({
    activeSkin,
    savedSkins,
    isLoading,
    isAppearanceChanging,
    refreshVersion,
    refresh,
    apply,
    deactivate,
    deleteSkin,
    selectThemeMode,
    selectThemeById,
  }), [
    activeSkin,
    apply,
    deactivate,
    deleteSkin,
    isAppearanceChanging,
    isLoading,
    refresh,
    refreshVersion,
    savedSkins,
    selectThemeById,
    selectThemeMode,
  ]);

  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
};

export const useSkin = (): SkinContextValue => {
  const context = useContext(SkinContext);
  if (!context) throw new Error('useSkin must be used within SkinProvider');
  return context;
};

export const useSkinAsset = (slot: SkinAssetSlot): string | null => {
  const { activeSkin, refreshVersion } = useSkin();
  return useMemo(
    () => buildSkinAssetUrl(activeSkin?.assets[slot], refreshVersion),
    [activeSkin, refreshVersion, slot],
  );
};
