import { describe, expect, test } from 'vitest';

import {
  getAdjacentSidebarCarouselKey,
  resolveSidebarCarouselIndex,
  shouldShowSidebarCarouselControls,
} from './sidebarExperienceCarouselState';

describe('sidebar experience carousel state', () => {
  test('hides controls for zero or one effective item', () => {
    expect(shouldShowSidebarCarouselControls(0)).toBe(false);
    expect(shouldShowSidebarCarouselControls(1)).toBe(false);
    expect(shouldShowSidebarCarouselControls(2)).toBe(true);
  });

  test('falls back to the first item when the active item disappears', () => {
    expect(resolveSidebarCarouselIndex(
      ['activity:daily', 'banner:42'],
      'banner:missing',
    )).toBe(0);
  });

  test('wraps previous and next navigation', () => {
    const keys = ['activity:daily', 'banner:42', 'banner:43'];

    expect(getAdjacentSidebarCarouselKey(
      keys,
      'activity:daily',
      -1,
    )).toBe('banner:43');
    expect(getAdjacentSidebarCarouselKey(
      keys,
      'banner:43',
      1,
    )).toBe('activity:daily');
  });
});
