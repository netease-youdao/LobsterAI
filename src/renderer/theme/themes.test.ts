import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

import { generateAllThemesCSS } from './engine/css-generator';
import { allThemes, themeMap } from './themes';
import { TOKEN_NAMES } from './tokens/contract';

describe('theme tokens and generated CSS', () => {
  test('every built-in theme defines every contract token', () => {
    for (const theme of allThemes) {
      for (const tokenName of TOKEN_NAMES) {
        expect(theme.tokens[tokenName], `${theme.meta.id}.${tokenName}`).toBeTruthy();
      }
    }
  });

  test('classic themes separate monochrome action buttons from blue primary accents', () => {
    const light = themeMap.get('classic-light');
    const dark = themeMap.get('classic-dark');

    expect(light?.tokens['primary']).toBe('#3B82F6');
    expect(light?.tokens['action']).toBe('#1A1A1A');
    expect(light?.tokens['action-foreground']).toBe('#FFFFFF');

    expect(dark?.tokens['primary']).toBe('#3B82F6');
    expect(dark?.tokens['action']).toBe('#F4F4F5');
    expect(dark?.tokens['action-foreground']).toBe('#0F1117');
  });

  test('generated themes.css matches generateAllThemesCSS(allThemes)', () => {
    const cssPath = resolve(__dirname, 'css', 'themes.css');
    const diskCSS = readFileSync(cssPath, 'utf-8');
    expect(diskCSS).toBe(generateAllThemesCSS(allThemes));
  });
});
