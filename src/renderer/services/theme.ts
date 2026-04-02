import { configService } from './config';
import { ThemeManager, allThemes } from '../theme';
import type { ThemeDefinition } from '../theme';

type ThemeType = 'light' | 'dark' | 'system';

class ThemeService {
  private mediaQuery: MediaQueryList | null = null;
  private currentTheme: ThemeType = 'system';
  private initialized = false;
  private mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
  private manager: ThemeManager;

  constructor() {
    if (typeof window !== 'undefined') {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }
    this.manager = new ThemeManager(allThemes, {
      storageKey: 'lobster-theme-id',
      defaultTheme: 'classic-light',
      followSystem: false,
    });
  }

  // 初始化主题
  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    try {
      const config = configService.getConfig();
      // config.theme is 'light' | 'dark' | 'system' — map to a theme ID
      this.setTheme(config.theme);

      // 监听系统主题变化
      if (this.mediaQuery) {
        this.mediaQueryListener = (e) => {
          if (this.currentTheme === 'system') {
            this.applyByAppearance(e.matches ? 'dark' : 'light');
          }
        };
        this.mediaQuery.addEventListener('change', this.mediaQueryListener);
      }
    } catch (error) {
      console.error('Failed to initialize theme:', error);
      this.setTheme('system');
    }
  }

  // 设置主题 — accepts legacy 'light'|'dark'|'system' OR a theme ID
  setTheme(theme: ThemeType | string): void {
    console.debug(`[ThemeService] setTheme: ${theme}`);
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      this.currentTheme = theme;
      if (theme === 'system') {
        const effective = this.mediaQuery?.matches ? 'dark' : 'light';
        this.applyByAppearance(effective);
      } else {
        this.applyByAppearance(theme);
      }
    } else {
      // Direct theme ID
      this.currentTheme = 'light'; // fallback for getTheme()
      const def = allThemes.find(t => t.meta.id === theme);
      if (def) {
        this.currentTheme = def.meta.appearance as ThemeType;
      }
      void this.manager.setTheme(theme);
    }
  }

  // 设置主题 by ID (for the new 12-theme picker)
  setThemeById(id: string): void {
    void this.manager.setTheme(id);
    const def = allThemes.find(t => t.meta.id === id);
    if (def) {
      this.currentTheme = def.meta.appearance as ThemeType;
    }
  }

  // 还原主题（用于取消操作）：直接 apply 指定 ID 并还原 mode，跳过 applyByAppearance 的 localStorage 读取
  restoreTheme(id: string, mode: ThemeType): void {
    void this.manager.setTheme(id);
    this.currentTheme = mode;
  }

  // 获取当前主题 (legacy API)
  getTheme(): ThemeType {
    return this.currentTheme;
  }

  // 获取当前主题 ID
  getThemeId(): string {
    return this.manager.getThemeId();
  }

  // 获取所有主题
  getAllThemes(): ThemeDefinition[] {
    return this.manager.getAllThemes();
  }

  // 获取当前有效主题（实际应用的明/暗主题）
  getEffectiveTheme(): 'light' | 'dark' {
    const theme = this.manager.getTheme();
    return theme?.meta.appearance ?? 'light';
  }

  // 根据 appearance 选择第一个匹配的主题，或恢复已保存的主题
  private applyByAppearance(appearance: 'light' | 'dark'): void {
    // Check if there's a saved theme ID with the right appearance
    const savedId = localStorage.getItem('lobster-theme-id');
    if (savedId) {
      const saved = allThemes.find(t => t.meta.id === savedId);
      if (saved && saved.meta.appearance === appearance) {
        void this.manager.setTheme(savedId);
        return;
      }
    }
    // Fallback: pick first theme matching the appearance
    const match = allThemes.find(t => t.meta.appearance === appearance);
    if (match) {
      void this.manager.setTheme(match.meta.id);
    }
  }
}

export const themeService = new ThemeService();
