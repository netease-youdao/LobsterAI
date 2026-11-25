import { describe, expect, test } from 'vitest';

import {
  SkinBackdropVisibility,
  SkinPreferredAppearance,
  SkinPresentationMode,
} from '../../shared/skin/constants';
import type { SkinPresentation } from '../../shared/skin/presentation';
import {
  resolveSkinBackdropLayerStyle,
  SkinBackdropVariant,
} from './skinBackdropPresentation';

const basePresentation = (
  preferredAppearance: SkinPreferredAppearance,
  backdropVisibility?: SkinBackdropVisibility,
): SkinPresentation => ({
  mode: SkinPresentationMode.ImmersiveShell,
  preferredAppearance,
  palette: preferredAppearance === SkinPreferredAppearance.Dark
    ? {
        canvas: '#12090b',
        panel: '#1d0d10',
        panelRaised: '#2a1216',
        accent: '#e5b941',
        accentForeground: '#160b0d',
        accentAlt: '#d85a45',
        foreground: '#f7eee8',
        muted: '#c7aaa5',
        border: '#745126',
      }
    : {
        canvas: '#fffaf2',
        panel: '#ffffff',
        panelRaised: '#f5eee4',
        accent: '#8a3d16',
        accentForeground: '#ffffff',
        accentAlt: '#b45f37',
        foreground: '#24160f',
        muted: '#6f5145',
        border: '#bda99b',
      },
  ...(backdropVisibility ? { backdropVisibility } : {}),
});

describe('resolveSkinBackdropLayerStyle', () => {
  test('defaults presented skins to balanced clarity across variants', () => {
    const dark = basePresentation(SkinPreferredAppearance.Dark);
    const home = resolveSkinBackdropLayerStyle(SkinBackdropVariant.Home, dark);
    const conversation = resolveSkinBackdropLayerStyle(SkinBackdropVariant.Conversation, dark);
    const management = resolveSkinBackdropLayerStyle(SkinBackdropVariant.Management, dark);

    expect(home.visibility).toBe(SkinBackdropVisibility.Balanced);
    expect(home.imageClassName).toContain('opacity-[0.78]');
    expect(conversation.imageClassName).toContain('opacity-[0.26]');
    expect(management.imageClassName).toContain('opacity-[0.30]');
  });

  test('increases home clarity prominently in vivid mode while keeping conversation readability washes', () => {
    const darkVivid = basePresentation(SkinPreferredAppearance.Dark, SkinBackdropVisibility.Vivid);
    const lightVivid = basePresentation(SkinPreferredAppearance.Light, SkinBackdropVisibility.Vivid);

    const home = resolveSkinBackdropLayerStyle(SkinBackdropVariant.Home, darkVivid);
    const darkConversation = resolveSkinBackdropLayerStyle(SkinBackdropVariant.Conversation, darkVivid);
    const lightConversation = resolveSkinBackdropLayerStyle(SkinBackdropVariant.Conversation, lightVivid);

    expect(home.visibility).toBe(SkinBackdropVisibility.Vivid);
    expect(home.imageClassName).toBe('opacity-[0.96]');
    expect(home.overlay).toContain('18%');
    expect(darkConversation.imageClassName).toBe('opacity-[0.42]');
    expect(darkConversation.overlay).toContain('20%');
    expect(lightConversation.imageClassName).toBe('opacity-[0.38]');
    expect(lightConversation.overlay).toContain('30%');
  });

  test('softens backdrop opacity in subtle mode and preserves legacy skins without presentation', () => {
    const lightSubtle = basePresentation(SkinPreferredAppearance.Light, SkinBackdropVisibility.Subtle);
    expect(resolveSkinBackdropLayerStyle(SkinBackdropVariant.Home, lightSubtle).imageClassName)
      .toContain('opacity-[0.58]');
    expect(resolveSkinBackdropLayerStyle(SkinBackdropVariant.Conversation, lightSubtle).imageClassName)
      .toContain('opacity-[0.16]');

    const legacyHome = resolveSkinBackdropLayerStyle(SkinBackdropVariant.Home);
    expect(legacyHome.visibility).toBeUndefined();
    expect(legacyHome.overlay).toContain('--lobster-background');
  });
});
