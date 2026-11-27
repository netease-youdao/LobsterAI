import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, test } from 'vitest';

import { generateAllThemesCSS } from './engine/css-generator';
import { allThemes, themeMap } from './themes';
import { TOKEN_NAMES } from './tokens/contract';

const require = createRequire(import.meta.url);
const themeTailwindPlugin = require('./tailwind/plugin.cjs');

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

  test('tailwind plugin emits bare var() for opaque theme colors and color-mix() only for fractional opacity modifiers', async () => {
    const rawClasses = [
      'bg-background',
      'bg-background/100',
      'text-foreground',
      'bg-surface-raised',
      'border-border',
      'bg-surface-raised/30',
      'text-foreground/90',
      'bg-foreground/[0.05]',
    ].join(' ');

    const { css } = await postcss([
      tailwindcss({
        content: [{ raw: rawClasses, extension: 'html' }],
        plugins: [themeTailwindPlugin],
      }),
    ]).process('@tailwind utilities;', { from: undefined });

    expect(css).toMatch(/\.bg-background\s*\{[^}]*background-color:\s*var\(--lobster-background\)/);
    expect(css).toMatch(/\.bg-background\\\/100\s*\{[^}]*background-color:\s*var\(--lobster-background\)/);
    expect(css).toMatch(/\.text-foreground\s*\{[^}]*color:\s*var\(--lobster-foreground\)/);
    expect(css).toMatch(/\.bg-surface-raised\s*\{[^}]*background-color:\s*var\(--lobster-surface-raised\)/);
    expect(css).toMatch(/\.border-border\s*\{[^}]*border-color:\s*var\(--lobster-border\)/);

    expect(css).toMatch(/\.bg-surface-raised\\\/30\s*\{[^}]*color-mix\(in srgb, var\(--lobster-surface-raised\) calc\(0\.3 \* 100%\), transparent\)/);
    expect(css).toMatch(/\.text-foreground\\\/90\s*\{[^}]*color-mix\(in srgb, var\(--lobster-foreground\) calc\(0\.9 \* 100%\), transparent\)/);
    expect(css).toMatch(/\.bg-foreground\\\/\\\[0\\\.05\\\]\s*\{[^}]*color-mix\(in srgb, var\(--lobster-foreground\) calc\(0\.05 \* 100%\), transparent\)/);
  });
});
