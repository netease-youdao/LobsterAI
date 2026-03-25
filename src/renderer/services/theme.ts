import { configService } from './config';

export type ThemeType = 'light' | 'dark' | 'system' | 'custom';

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function generatePalette(accentHex: string): Record<string, string> {
  const [h, s] = hexToHsl(accentHex);
  const pastelS = Math.min(s, 40);
  return {
    '--claude-bg': hslToHex(h, pastelS * 0.15, 97),
    '--claude-surface': '#FFFFFF',
    '--claude-surfaceHover': hslToHex(h, pastelS * 0.2, 94),
    '--claude-surfaceMuted': hslToHex(h, pastelS * 0.18, 95.5),
    '--claude-surfaceInset': hslToHex(h, pastelS * 0.2, 92),
    '--claude-border': hslToHex(h, pastelS * 0.25, 88),
    '--claude-borderLight': hslToHex(h, pastelS * 0.2, 92),
    '--claude-text': hslToHex(h, pastelS * 0.3, 12),
    '--claude-textSecondary': hslToHex(h, pastelS * 0.15, 45),
    '--claude-accent': accentHex,
    '--claude-accentHover': hslToHex(h, Math.min(s * 1.1, 100), Math.max(s > 0 ? 40 : 45, 35)),
    '--claude-accentLight': hslToHex(h, Math.min(s * 0.8, 90), 65),
    '--claude-accentMuted': `hsla(${h}, ${Math.round(s)}%, 50%, 0.10)`,
  };
}

const DEFAULT_LIGHT_VARS: Record<string, string> = {
  '--claude-bg': '#F8F9FB',
  '--claude-surface': '#FFFFFF',
  '--claude-surfaceHover': '#F0F1F4',
  '--claude-surfaceMuted': '#F3F4F6',
  '--claude-surfaceInset': '#EBEDF0',
  '--claude-border': '#E0E2E7',
  '--claude-borderLight': '#EBEDF0',
  '--claude-text': '#1A1D23',
  '--claude-textSecondary': '#6B7280',
  '--claude-accent': '#3B82F6',
  '--claude-accentHover': '#2563EB',
  '--claude-accentLight': '#60A5FA',
  '--claude-accentMuted': 'rgba(59,130,246,0.10)',
};

class ThemeService {
  private mediaQuery: MediaQueryList | null = null;
  private currentTheme: ThemeType = 'system';
  private appliedTheme: 'light' | 'dark' | null = null;
  private customAccent: string | null = null;
  private initialized = false;
  private mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const config = configService.getConfig();
      if (config.theme === 'custom' && config.themeAccentColor) {
        this.customAccent = config.themeAccentColor;
      }
      this.setTheme(config.theme);

      if (this.mediaQuery) {
        this.mediaQueryListener = (e) => {
          if (this.currentTheme === 'system') {
            this.applyTheme(e.matches ? 'dark' : 'light');
          }
        };
        this.mediaQuery.addEventListener('change', this.mediaQueryListener);
      }
    } catch (error) {
      console.error('Failed to initialize theme:', error);
      this.setTheme('system');
    }
  }

  setTheme(theme: ThemeType): void {
    if (theme === 'custom') {
      this.currentTheme = 'custom';
      this.appliedTheme = null;
      this.applyCustomTheme(this.customAccent || '#F472B6');
      return;
    }

    const effectiveTheme = theme === 'system'
      ? (this.mediaQuery?.matches ? 'dark' : 'light')
      : theme as 'light' | 'dark';

    if (this.currentTheme === theme && this.appliedTheme === effectiveTheme) return;

    this.currentTheme = theme;
    this.applyTheme(effectiveTheme);
  }

  setAccentColor(hex: string): void {
    this.customAccent = hex;
    if (this.currentTheme === 'custom') {
      this.applyCustomTheme(hex);
    }
  }

  getAccentColor(): string {
    return this.customAccent || '#F472B6';
  }

  getTheme(): ThemeType {
    return this.currentTheme;
  }

  getEffectiveTheme(): 'light' | 'dark' {
    if (this.currentTheme === 'custom') return 'light';
    if (this.currentTheme === 'system') {
      return this.mediaQuery?.matches ? 'dark' : 'light';
    }
    return this.currentTheme as 'light' | 'dark';
  }

  private applyCustomTheme(accentHex: string): void {
    const root = document.documentElement;
    root.classList.remove('dark');
    root.classList.add('light');
    document.body.classList.remove('dark');
    document.body.classList.add('light');

    const palette = generatePalette(accentHex);
    for (const [key, value] of Object.entries(palette)) {
      root.style.setProperty(key, value);
    }

    const bg = palette['--claude-bg'];
    const text = palette['--claude-text'];
    root.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
    document.body.style.color = text;

    root.style.setProperty('--theme-transition', 'background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease');
    document.body.style.transition = 'var(--theme-transition)';

    const rootEl = document.getElementById('root');
    if (rootEl) {
      rootEl.classList.remove('dark');
      rootEl.classList.add('light');
      rootEl.style.backgroundColor = bg;
    }
    this.appliedTheme = 'light';
  }

  private applyTheme(theme: 'light' | 'dark'): void {
    if (this.appliedTheme === theme && this.currentTheme !== 'custom') return;

    this.appliedTheme = theme;
    const root = document.documentElement;

    for (const [key, value] of Object.entries(DEFAULT_LIGHT_VARS)) {
      root.style.setProperty(key, value);
    }

    const isDark = theme === 'dark';
    root.classList.toggle('dark', isDark);
    root.classList.toggle('light', !isDark);
    document.body.classList.toggle('dark', isDark);
    document.body.classList.toggle('light', !isDark);

    const bg = isDark ? '#0F1117' : DEFAULT_LIGHT_VARS['--claude-bg'];
    const text = isDark ? '#E4E5E9' : DEFAULT_LIGHT_VARS['--claude-text'];
    root.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
    document.body.style.color = text;

    root.style.setProperty('--theme-transition', 'background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease');
    document.body.style.transition = 'var(--theme-transition)';

    const rootEl = document.getElementById('root');
    if (rootEl) {
      rootEl.classList.toggle('dark', isDark);
      rootEl.classList.toggle('light', !isDark);
      rootEl.style.backgroundColor = bg;
    }
  }
}

export const themeService = new ThemeService();
