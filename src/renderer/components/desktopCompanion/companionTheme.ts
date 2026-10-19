import { configService } from '../../services/config';
import { THEME_ID_STORAGE_KEY } from '../../theme/engine/theme-manager';
import { allThemes, themeMap } from '../../theme/themes';

/**
 * The main window owns the effective theme (which may come from an AI skin).
 * A companion only reads it: initializing ThemeService here would reapply the
 * default and overwrite the appearance shared by the other companion windows.
 */
export function synchronizeCompanionTheme(): void {
  let themeId: string | null = null;
  try { themeId = localStorage.getItem(THEME_ID_STORAGE_KEY); } catch { /* storage unavailable */ }
  const config = configService.getConfig();
  const appearance = config.theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : config.theme;
  const configured = config.themeId ? themeMap.get(config.themeId) : undefined;
  const theme = (themeId ? themeMap.get(themeId) : undefined)
    ?? (configured?.meta.appearance === appearance ? configured : undefined)
    ?? allThemes.find(candidate => candidate.meta.appearance === appearance)
    ?? allThemes[0];
  const root = document.documentElement;
  root.dataset.theme = theme.meta.id;
  root.classList.toggle('dark', theme.meta.appearance === 'dark');
  root.classList.toggle('light', theme.meta.appearance === 'light');
}

/** Synchronize before React's first paint, and while the persistent window is hidden or visible. */
export function observeCompanionTheme(): () => void {
  synchronizeCompanionTheme();
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_ID_STORAGE_KEY || event.key === null) synchronizeCompanionTheme();
  };
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener('storage', onStorage);
  scheme.addEventListener('change', synchronizeCompanionTheme);
  return () => {
    window.removeEventListener('storage', onStorage);
    scheme.removeEventListener('change', synchronizeCompanionTheme);
  };
}
