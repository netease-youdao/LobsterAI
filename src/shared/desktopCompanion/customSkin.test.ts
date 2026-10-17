import { describe, expect, test } from 'vitest';

import { DEFAULT_COMPANION_SKIN } from './constants';
import { companionFitRect, isCompanionSourceSizeAllowed, isCustomCompanionSkin, normalizeCompanionSkinEntries, normalizeCompanionSkinName } from './customSkin';
import { COMPANION_SKINS, CompanionSkinKind, getCompanionSkin, normalizeCompanionSkin } from './skins';

describe('custom companion skins', () => {
  test('preserves upstream skins and accepts only hash IDs for custom images', () => {
    for (const skin of COMPANION_SKINS) expect(normalizeCompanionSkin(skin.id)).toBe(skin.id);
    expect(getCompanionSkin(DEFAULT_COMPANION_SKIN).kind).toBe(CompanionSkinKind.Brand);
    const id = `custom-${'a'.repeat(64)}`;
    expect(normalizeCompanionSkin(id)).toBe(id);
    expect(getCompanionSkin(id).asset).toBeNull();
    for (const invalid of ['custom-../../secret', 'https://example.com/a.png', 'data:image/svg+xml,bad']) {
      expect(isCustomCompanionSkin(invalid)).toBe(false);
      expect(normalizeCompanionSkin(invalid)).toBe(DEFAULT_COMPANION_SKIN);
    }
  });
  test('enforces both dimension bounds', () => {
    expect(isCompanionSourceSizeAllowed(128, 2048)).toBe(true);
    expect(isCompanionSourceSizeAllowed(127, 512)).toBe(false);
    expect(isCompanionSourceSizeAllowed(512, 2049)).toBe(false);
    expect(isCompanionSourceSizeAllowed(NaN, 512)).toBe(false);
  });
  test('fits the whole silhouette at default zoom and preserves transparent padding', () => {
    expect(companionFitRect(256, 1024, 1, 0.5, 0.5)).toEqual({ x: 192, y: 0, width: 128, height: 512 });
    expect(companionFitRect(1024, 256, 1, 0.5, 0.5)).toEqual({ x: 0, y: 192, width: 512, height: 128 });
    expect(companionFitRect(512, 512, 0.5, 0.5, 0.5)).toEqual({ x: 128, y: 128, width: 256, height: 256 });
  });
  test('normalizes user names and deduplicates persisted IDs without trusting paths', () => {
    const id = `custom-${'b'.repeat(64)}`;
    expect(normalizeCompanionSkinEntries([null, { id: '../bad' }, { id, name: 'old' }, { id, name: '  Rabbit\n' }])).toEqual([{ id, name: 'Rabbit' }]);
    expect(normalizeCompanionSkinEntries('bad')).toEqual([]);
    expect(normalizeCompanionSkinName('🦞'.repeat(41))).toBe('🦞'.repeat(40));
  });
});
