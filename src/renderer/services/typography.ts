import {
  type AppConfig,
  FontPreferences,
  normalizeFontPreference,
} from '../config';

type TypographyConfig = Pick<AppConfig, 'uiFontSize' | 'codeFontSize'>;

const TEXT_SIZE_BASE = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  markdown: 15,
  markdownH2: 17,
  markdownH4: 15,
  promptLarge: 15,
  sidebarCompact: 13,
} as const;

const LINE_HEIGHT_BASE = {
  xs: 16,
  sm: 20,
  base: 24,
  lg: 28,
  xl: 28,
  '2xl': 32,
  '3xl': 36,
  '4xl': 40,
  markdown: 26,
  markdownCompact: 23,
  prompt: 22,
  promptLarge: 23,
} as const;

const setPxVariable = (
  root: HTMLElement,
  name: string,
  value: number,
): void => {
  root.style.setProperty(name, `${Math.round(value)}px`);
};

export const resolveTypographyPreferences = (config: TypographyConfig) => ({
  uiFontSize: normalizeFontPreference(
    config.uiFontSize,
    FontPreferences.UiFontSizeDefault,
    FontPreferences.UiFontSizeMin,
    FontPreferences.UiFontSizeMax,
  ),
  codeFontSize: normalizeFontPreference(
    config.codeFontSize,
    FontPreferences.CodeFontSizeDefault,
    FontPreferences.CodeFontSizeMin,
    FontPreferences.CodeFontSizeMax,
  ),
});

export const applyTypographyPreferences = (config: TypographyConfig): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const { uiFontSize, codeFontSize } = resolveTypographyPreferences(config);
  const root = document.documentElement;
  const scale = uiFontSize / FontPreferences.UiFontSizeDefault;

  root.style.setProperty('--lobster-ui-font-size', `${uiFontSize}px`);
  root.style.setProperty('--lobster-code-font-size', `${codeFontSize}px`);

  Object.entries(TEXT_SIZE_BASE).forEach(([key, value]) => {
    setPxVariable(root, `--lobster-text-${key}`, value * scale);
  });
  Object.entries(LINE_HEIGHT_BASE).forEach(([key, value]) => {
    setPxVariable(root, `--lobster-leading-${key}`, value * scale);
  });
};
