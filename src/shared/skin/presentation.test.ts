import { describe, expect, test } from 'vitest';

import {
  SkinParticleDensity,
  SkinPreferredAppearance,
  SkinPresentationMode,
} from './constants';
import {
  getSkinColorContrast,
  inferSkinPreferredAppearance,
  parseSkinPresentation,
} from './presentation';

const validPresentation = {
  mode: SkinPresentationMode.ImmersiveShell,
  palette: {
    canvas: '#12090B',
    panel: '#1D0D10',
    panelRaised: '#2A1216',
    accent: '#E5B941',
    accentForeground: '#160B0D',
    accentAlt: '#D85A45',
    foreground: '#F7EEE8',
    muted: '#C7AAA5',
    border: '#745126',
  },
  art: { focusX: 0.72, focusY: 0.42 },
  effects: { particleDensity: SkinParticleDensity.Sparse },
};

describe('skin presentation schema', () => {
  test('normalizes one accessible immersive shell presentation', () => {
    expect(parseSkinPresentation(validPresentation)).toEqual({
      ...validPresentation,
      preferredAppearance: SkinPreferredAppearance.Dark,
      palette: Object.fromEntries(
        Object.entries(validPresentation.palette).map(([key, value]) => [key, value.toLowerCase()]),
      ),
    });
    expect(getSkinColorContrast('#f7eee8', '#1d0d10')).toBeGreaterThan(4.5);
  });

  test('infers dark and light appearances from the accessible palette surfaces', () => {
    expect(inferSkinPreferredAppearance(validPresentation.palette))
      .toBe(SkinPreferredAppearance.Dark);
    expect(inferSkinPreferredAppearance({
      canvas: '#fffaf2',
      panel: '#ffffff',
      panelRaised: '#f5eee4',
      accent: '#8a3d16',
      accentForeground: '#ffffff',
      accentAlt: '#b45f37',
      foreground: '#24160f',
      muted: '#6f5145',
      border: '#bda99b',
    })).toBe(SkinPreferredAppearance.Light);
  });

  test('rejects a caller-provided appearance that contradicts the palette', () => {
    expect(parseSkinPresentation({
      ...validPresentation,
      preferredAppearance: SkinPreferredAppearance.Light,
    })).toBeNull();
  });

  test('rejects arbitrary presentation fields and out-of-range focus values', () => {
    expect(parseSkinPresentation({ ...validPresentation, css: 'body { display: none; }' })).toBeNull();
    expect(parseSkinPresentation({
      ...validPresentation,
      art: { focusX: 2, focusY: 0.5 },
    })).toBeNull();
  });

  test('rejects palettes that cannot keep foreground and accents readable', () => {
    expect(parseSkinPresentation({
      ...validPresentation,
      palette: {
        ...validPresentation.palette,
        foreground: '#241416',
        muted: '#2A171A',
      },
    })).toBeNull();
  });
});
