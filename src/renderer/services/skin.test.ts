import { describe, expect, test } from 'vitest';

import {
  SkinAssetSlot,
  SkinParticleDensity,
  SkinPreferredAppearance,
  SkinPresentationMode,
} from '../../shared/skin/constants';
import {
  buildSkinAssetUrl,
  normalizeActiveSkin,
  normalizeSkinList,
} from './skin';

describe('normalizeActiveSkin', () => {
  test('keeps only the supported image slots and theme binding metadata', () => {
    const skin = normalizeActiveSkin({
      skin: {
        id: 'sunset-glass',
        name: 'Sunset Glass',
        baseThemeId: 'sakura',
        boundThemeId: 'midnight',
        presentation: {
          mode: SkinPresentationMode.ImmersiveShell,
          palette: {
            canvas: '#12090b',
            panel: '#1d0d10',
            panelRaised: '#2a1216',
            accent: '#e5b941',
            accentForeground: '#160b0d',
            accentAlt: '#d85a45',
            foreground: '#f7eee8',
            muted: '#c7aaa5',
            border: '#745126',
          },
          art: { focusX: 0.72, focusY: 0.42 },
          effects: { particleDensity: SkinParticleDensity.Sparse },
        },
        css: 'body { display: none; }',
        assets: {
          [SkinAssetSlot.WorkspaceBackdrop]: {
            url: 'lobster-skin://asset/sunset-glass/workspace.backdrop',
            hash: 'backdrop-hash',
          },
          [SkinAssetSlot.HomeEmblem]: 'lobster-skin://asset/sunset-glass/home.emblem',
          'sidebar.icon': 'lobster-skin://asset/sunset-glass/sidebar.icon',
        },
      },
    });

    expect(skin).toEqual({
      id: 'sunset-glass',
      name: 'Sunset Glass',
      baseThemeId: 'sakura',
      boundThemeId: 'midnight',
      presentation: {
        mode: SkinPresentationMode.ImmersiveShell,
        preferredAppearance: SkinPreferredAppearance.Dark,
        palette: {
          canvas: '#12090b',
          panel: '#1d0d10',
          panelRaised: '#2a1216',
          accent: '#e5b941',
          accentForeground: '#160b0d',
          accentAlt: '#d85a45',
          foreground: '#f7eee8',
          muted: '#c7aaa5',
          border: '#745126',
        },
        art: { focusX: 0.72, focusY: 0.42 },
        effects: { particleDensity: SkinParticleDensity.Sparse },
      },
      assets: {
        [SkinAssetSlot.WorkspaceBackdrop]: {
          url: 'lobster-skin://asset/sunset-glass/workspace.backdrop',
          cacheKey: 'backdrop-hash',
        },
        [SkinAssetSlot.HomeEmblem]: {
          url: 'lobster-skin://asset/sunset-glass/home.emblem',
        },
      },
    });
  });

  test('accepts manifest metadata with separately resolved asset URLs', () => {
    const skin = normalizeActiveSkin({
      manifest: {
        id: 'paper-cut',
        baseThemeId: 'paper',
        boundThemeId: 'dawn',
      },
      assetUrls: {
        [SkinAssetSlot.WorkspaceBackdrop]: 'lobster-skin://asset/paper-cut/workspace.backdrop',
        [SkinAssetSlot.HomeEmblem]: 'lobster-skin://asset/paper-cut/home.emblem',
      },
    });

    expect(skin?.id).toBe('paper-cut');
    expect(skin?.baseThemeId).toBe('paper');
    expect(skin?.boundThemeId).toBe('dawn');
    expect(skin?.assets[SkinAssetSlot.HomeEmblem]?.url).toContain('home.emblem');
  });

  test('returns null when no supported image asset is available', () => {
    expect(normalizeActiveSkin({
      id: 'unsafe',
      assets: { 'sidebar.icon': 'lobster-skin://asset/unsafe/sidebar.icon' },
    })).toBeNull();
    expect(normalizeActiveSkin({
      id: 'remote',
      assets: {
        [SkinAssetSlot.WorkspaceBackdrop]: 'https://example.test/background.png',
      },
    })).toBeNull();
    expect(normalizeActiveSkin({ success: true, skin: null })).toBeNull();
  });
});

describe('normalizeSkinList', () => {
  test('keeps reusable managed skins and ignores invalid list entries', () => {
    const skins = normalizeSkinList({
      success: true,
      skins: [
        {
          id: 'three-kingdoms',
          name: '三国蜀汉 Q 版',
          assets: {
            [SkinAssetSlot.WorkspaceBackdrop]: 'lobster-skin://asset/three-kingdoms/workspace.backdrop',
            [SkinAssetSlot.HomeEmblem]: 'lobster-skin://asset/three-kingdoms/home.emblem',
          },
        },
        {
          id: 'remote-only',
          assets: {
            [SkinAssetSlot.WorkspaceBackdrop]: 'https://example.test/background.png',
          },
        },
      ],
    });

    expect(skins).toHaveLength(1);
    expect(skins[0]).toMatchObject({
      id: 'three-kingdoms',
      name: '三国蜀汉 Q 版',
    });
  });
});

describe('buildSkinAssetUrl', () => {
  test('keeps managed skin protocol URLs because they already contain a content hash', () => {
    expect(buildSkinAssetUrl({
      url: 'lobster-skin://asset/demo/workspace.backdrop?v=backdrop-hash',
      cacheKey: 'sha 256',
    }, 3)).toBe('lobster-skin://asset/demo/workspace.backdrop?v=backdrop-hash');
  });

  test('falls back to the refresh version for generic URLs without mutating inline URLs', () => {
    expect(buildSkinAssetUrl({ url: 'https://example.test/home.emblem?size=small#preview' }, 7))
      .toBe('https://example.test/home.emblem?size=small&skin_v=7#preview');
    expect(buildSkinAssetUrl({ url: 'data:image/png;base64,AAAA' }, 7))
      .toBe('data:image/png;base64,AAAA');
  });
});
