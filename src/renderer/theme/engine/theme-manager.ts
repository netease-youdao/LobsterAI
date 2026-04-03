import type { ThemeDefinition } from '../themes/types';

export interface ThemeStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
}

export interface ThemeManagerOptions {
  /** localStorage key for persistence. Default: 'lobster-theme' */
  storageKey?: string;
  /** Default theme ID (first theme if omitted) */
  defaultTheme?: string;
  /** Listen to OS prefers-color-scheme changes */
  followSystem?: boolean;
  /** Storage adapter — defaults to localStorage */
  storage?: ThemeStorage;
  /** Called after every theme switch */
  onChange?: (theme: ThemeDefinition) => void;
}

export class ThemeManager {
  private themes: Map<string, ThemeDefinition>;
  private currentId: string;
  private opts: Required<ThemeManagerOptions>;
  private mq: MediaQueryList | null = null;
  private mqHandler: ((e: MediaQueryListEvent) => void) | null = null;

  constructor(themes: ThemeDefinition[], options: ThemeManagerOptions = {}) {
    this.themes = new Map(themes.map((t) => [t.meta.id, t]));
    const fallback = themes[0]?.meta.id ?? '';
    this.currentId = fallback;
    this.opts = {
      storageKey: options.storageKey ?? 'lobster-theme',
      defaultTheme: options.defaultTheme ?? fallback,
      followSystem: options.followSystem ?? false,
      storage: options.storage ?? {
        get: (k) => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null),
        set: (k, v) => { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); },
      },
      onChange: options.onChange ?? (() => {}),
    };
  }

  /** Initialize: restore persisted theme + start system-preference listener */
  async init(): Promise<void> {
    const saved = await this.opts.storage.get(this.opts.storageKey);
    if (saved && this.themes.has(saved)) {
      this.apply(saved);
    } else if (this.opts.followSystem) {
      this.applySystemPreference();
    } else {
      this.apply(this.opts.defaultTheme);
    }

    if (this.opts.followSystem && typeof window !== 'undefined') {
      this.mq = window.matchMedia('(prefers-color-scheme: dark)');
      this.mqHandler = () => {
        const saved = this.opts.storage.get(this.opts.storageKey);
        if (saved instanceof Promise) return;
        if (!saved) this.applySystemPreference();
      };
      this.mq.addEventListener('change', this.mqHandler);
    }
  }

  /** Switch theme by ID */
  async setTheme(id: string): Promise<void> {
    if (!this.themes.has(id)) return;
    this.apply(id);
    await this.opts.storage.set(this.opts.storageKey, id);
  }

  /** Get current active theme */
  getTheme(): ThemeDefinition | undefined {
    return this.themes.get(this.currentId);
  }

  /** Get current theme ID */
  getThemeId(): string {
    return this.currentId;
  }

  /** Get all registered themes */
  getAllThemes(): ThemeDefinition[] {
    return Array.from(this.themes.values());
  }

  /** Clean up listeners */
  destroy(): void {
    if (this.mq && this.mqHandler) {
      this.mq.removeEventListener('change', this.mqHandler);
    }
  }

  // ── internal ──

  private apply(id: string): void {
    const theme = this.themes.get(id);
    if (!theme) return;
    this.currentId = id;

    if (typeof document !== 'undefined') {
      const root = document.documentElement;

      // Set data-theme attribute — CSS selectors do the rest
      root.dataset.theme = id;

      // Tailwind dark class compat
      if (theme.meta.appearance === 'dark') {
        root.classList.add('dark');
        root.classList.remove('light');
      } else {
        root.classList.remove('dark');
        root.classList.add('light');
      }

      // Electron title-bar sync
      try {
        const electronAPI = (window as any).electronAPI ?? (window as any).electron;
        electronAPI?.theme?.updateTitleBar?.({
          bg: theme.tokens['surface'],
          symbol: theme.tokens['text-secondary'],
          windowBg: theme.tokens['background'],
        });
      } catch { /* not in Electron */ }
    }

    this.opts.onChange(theme);
  }

  private applySystemPreference(): void {
    const isDark = typeof window !== 'undefined'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const target = isDark ? 'dark' : 'light';
    const match = Array.from(this.themes.values())
      .find((t) => t.meta.appearance === target);
    if (match) this.apply(match.meta.id);
  }
}
