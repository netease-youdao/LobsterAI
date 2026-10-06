import type { SkinPreferredAppearance } from '../../shared/skin/constants';
import type { ThemeDefinition } from '../theme';
import { allThemes, ThemeManager } from '../theme';
import { configService } from './config';

export type ThemeMode = 'light' | 'dark' | 'system';
type ThemeAppearance = Exclude<ThemeMode, 'system'>;

export interface ThemeSelection {
  mode: ThemeMode;
  themeId: string;
}

type PersistedThemeSelection = Omit<ThemeSelection, 'themeId'> & { themeId?: string };

export const ThemeServiceEvent = {
  DefaultChanged: 'lobster-default-theme-changed',
} as const;

export type ThemeDefaultChangedDetail = ThemeSelection;

const THEME_ID_STORAGE_KEY = 'lobster-theme-id';
const DEFAULT_THEME_ID = 'classic-light';

const isThemeMode = (value: string): value is ThemeMode => (
  value === 'light' || value === 'dark' || value === 'system'
);

class ThemeService {
  private mediaQuery: MediaQueryList | null = null;
  private currentTheme: ThemeMode = 'system';
  private defaultThemeId = DEFAULT_THEME_ID;
  private activeSkinThemeId: string | null = null;
  private initialized = false;
  private mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
  private manager: ThemeManager;

  constructor() {
    if (typeof window !== 'undefined') {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }
    this.manager = new ThemeManager(allThemes, {
      storageKey: THEME_ID_STORAGE_KEY,
      defaultTheme: DEFAULT_THEME_ID,
      followSystem: false,
    });
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    try {
      const config = configService.getConfig();
      const mode = isThemeMode(config.theme) ? config.theme : 'system';
      const appearance = this.resolveModeAppearance(mode);
      const target = this.resolveThemeForAppearance(
        appearance,
        config.themeId ?? this.readLegacyThemeId(),
      );

      this.currentTheme = mode;
      this.defaultThemeId = target?.meta.id ?? DEFAULT_THEME_ID;
      this.activeSkinThemeId = null;
      if (target) {
        void this.manager.setTheme(target.meta.id);
        if (config.themeId !== target.meta.id) {
          void configService.updateConfig({ themeId: target.meta.id }).catch((error) => {
            console.warn('[ThemeService] Failed to persist the migrated default theme id', error);
          });
        }
      }

      if (this.mediaQuery) {
        this.mediaQueryListener = (event) => {
          if (this.currentTheme !== 'system' || this.activeSkinThemeId) {
            return;
          }
          void this.applySystemAppearance(event.matches ? 'dark' : 'light').catch((error) => {
            console.error('[ThemeService] Failed to follow the system appearance', error);
          });
        };
        this.mediaQuery.addEventListener('change', this.mediaQueryListener);
      }
    } catch (error) {
      console.error('[ThemeService] Failed to initialize theme', error);
      this.setTheme('system');
    }
  }

  setTheme(theme: ThemeMode | string): void {
    if (isThemeMode(theme)) {
      const target = this.resolveThemeForAppearance(
        this.resolveModeAppearance(theme),
        this.defaultThemeId,
      );
      this.currentTheme = theme;
      this.activeSkinThemeId = null;
      if (target) {
        this.defaultThemeId = target.meta.id;
        void this.manager.setTheme(target.meta.id);
      }
      return;
    }

    const target = this.getThemeDefinition(theme);
    if (!target) return;
    this.currentTheme = target.meta.appearance;
    this.defaultThemeId = target.meta.id;
    this.activeSkinThemeId = null;
    void this.manager.setTheme(target.meta.id);
  }

  /** Apply a config loaded by startup repair without persisting it again. */
  applyPersistedSelection(selection: PersistedThemeSelection): void {
    const target = this.resolveThemeForAppearance(
      this.resolveModeAppearance(selection.mode),
      selection.themeId,
    );
    if (!target) return;
    this.currentTheme = selection.mode;
    this.defaultThemeId = target.meta.id;
    // Startup repair may complete after SkinProvider has already restored an
    // active AI skin. Refresh the repaired default for future fallback without
    // replacing the skin that is currently visible.
    if (!this.activeSkinThemeId) {
      void this.manager.setTheme(target.meta.id);
    }
    this.dispatchDefaultChanged();
  }

  getTheme(): ThemeMode {
    return this.currentTheme;
  }

  getThemeId(): string {
    return this.manager.getThemeId();
  }

  getDefaultThemeId(): string {
    return this.defaultThemeId;
  }

  getDefaultSelection(): ThemeSelection {
    return {
      mode: this.currentTheme,
      themeId: this.defaultThemeId,
    };
  }

  getAllThemes(): ThemeDefinition[] {
    return this.manager.getAllThemes();
  }

  getEffectiveTheme(): ThemeAppearance {
    return this.manager.getTheme()?.meta.appearance ?? 'light';
  }

  async selectDefaultThemeMode(mode: ThemeMode): Promise<ThemeSelection> {
    const target = this.resolveThemeForAppearance(
      this.resolveModeAppearance(mode),
      this.defaultThemeId,
    );
    if (!target) {
      throw new Error(`No theme is available for mode "${mode}"`);
    }
    return this.persistAndApplyDefaultSelection({
      mode,
      themeId: target.meta.id,
    });
  }

  async selectDefaultThemeById(themeId: string): Promise<ThemeSelection> {
    const target = this.getThemeDefinition(themeId);
    if (!target) {
      throw new Error(`Unknown theme id "${themeId}"`);
    }
    return this.persistAndApplyDefaultSelection({
      mode: target.meta.appearance,
      themeId: target.meta.id,
    });
  }

  async applySkinTheme(themeId: string): Promise<void> {
    const target = this.getThemeDefinition(themeId);
    if (!target) {
      throw new Error(`Unknown skin theme id "${themeId}"`);
    }
    this.activeSkinThemeId = target.meta.id;
    await this.manager.setTheme(target.meta.id);
  }

  async restoreDefaultTheme(): Promise<ThemeSelection> {
    const target = this.resolveThemeForAppearance(
      this.resolveModeAppearance(this.currentTheme),
      this.defaultThemeId,
    );
    if (!target) {
      throw new Error(`No theme is available for mode "${this.currentTheme}"`);
    }

    this.activeSkinThemeId = null;
    this.defaultThemeId = target.meta.id;
    await this.manager.setTheme(target.meta.id);

    const config = configService.getConfig();
    if (config.theme !== this.currentTheme || config.themeId !== target.meta.id) {
      await configService.updateConfig({
        theme: this.currentTheme,
        themeId: target.meta.id,
      });
    }
    this.dispatchDefaultChanged();
    return this.getDefaultSelection();
  }

  resolveSkinThemeId(
    boundThemeId: string | undefined,
    preferredAppearance: SkinPreferredAppearance | undefined,
  ): string {
    const boundTheme = boundThemeId
      ? this.getThemeDefinition(boundThemeId)
      : undefined;
    if (
      boundTheme
      && (!preferredAppearance || boundTheme.meta.appearance === preferredAppearance)
    ) {
      return boundTheme.meta.id;
    }

    const defaultTheme = this.getThemeDefinition(this.defaultThemeId);
    if (
      defaultTheme
      && (!preferredAppearance || defaultTheme.meta.appearance === preferredAppearance)
    ) {
      return defaultTheme.meta.id;
    }

    if (preferredAppearance) {
      const compatibleTheme = this.resolveThemeForAppearance(preferredAppearance);
      if (compatibleTheme) return compatibleTheme.meta.id;
    }

    return defaultTheme?.meta.id ?? allThemes[0]?.meta.id ?? DEFAULT_THEME_ID;
  }

  private async persistAndApplyDefaultSelection(
    selection: ThemeSelection,
  ): Promise<ThemeSelection> {
    const previousSelection = this.getDefaultSelection();
    const previousEffectiveThemeId = this.manager.getThemeId();
    const previousSkinThemeId = this.activeSkinThemeId;

    try {
      await configService.updateConfig({
        theme: selection.mode,
        themeId: selection.themeId,
      });
      this.currentTheme = selection.mode;
      this.defaultThemeId = selection.themeId;
      this.activeSkinThemeId = null;
      await this.manager.setTheme(selection.themeId);
    } catch (error) {
      this.currentTheme = previousSelection.mode;
      this.defaultThemeId = previousSelection.themeId;
      this.activeSkinThemeId = previousSkinThemeId;
      await this.manager.setTheme(previousEffectiveThemeId).catch(() => undefined);
      throw error;
    }

    this.dispatchDefaultChanged();
    return this.getDefaultSelection();
  }

  private async applySystemAppearance(appearance: ThemeAppearance): Promise<void> {
    const target = this.resolveThemeForAppearance(appearance, this.defaultThemeId);
    if (!target) return;

    this.defaultThemeId = target.meta.id;
    await configService.updateConfig({
      theme: 'system',
      themeId: target.meta.id,
    });
    await this.manager.setTheme(target.meta.id);
    this.dispatchDefaultChanged();
  }

  private resolveModeAppearance(mode: ThemeMode): ThemeAppearance {
    if (mode === 'system') {
      return this.mediaQuery?.matches ? 'dark' : 'light';
    }
    return mode;
  }

  private resolveThemeForAppearance(
    appearance: ThemeAppearance,
    preferredThemeId?: string,
  ): ThemeDefinition | undefined {
    const preferredTheme = preferredThemeId
      ? this.getThemeDefinition(preferredThemeId)
      : undefined;
    if (preferredTheme?.meta.appearance === appearance) {
      return preferredTheme;
    }
    return allThemes.find(theme => theme.meta.appearance === appearance);
  }

  private getThemeDefinition(themeId: string): ThemeDefinition | undefined {
    return allThemes.find(theme => theme.meta.id === themeId);
  }

  private readLegacyThemeId(): string | undefined {
    try {
      return typeof localStorage === 'undefined'
        ? undefined
        : localStorage.getItem(THEME_ID_STORAGE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private dispatchDefaultChanged(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<ThemeDefaultChangedDetail>(
      ThemeServiceEvent.DefaultChanged,
      { detail: this.getDefaultSelection() },
    ));
  }
}

export const themeService = new ThemeService();
