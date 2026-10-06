import { describe, expect, test } from 'vitest';

import { resolveEnterpriseMenuFlyoutPosition } from './enterpriseMenuPosition';

describe('resolveEnterpriseMenuFlyoutPosition', () => {
  test('places the flyout to the right of the account menu when space is available', () => {
    expect(resolveEnterpriseMenuFlyoutPosition(
      { left: 16, right: 264, top: 480 },
      { width: 240, height: 260 },
      { width: 1440, height: 900 },
    )).toEqual({ left: 270, top: 480 });
  });

  test('places the flyout to the left when the right edge has no room', () => {
    expect(resolveEnterpriseMenuFlyoutPosition(
      { left: 900, right: 1148, top: 320 },
      { width: 240, height: 260 },
      { width: 1200, height: 900 },
    )).toEqual({ left: 654, top: 320 });
  });

  test('clamps the flyout to the viewport on narrow windows', () => {
    expect(resolveEnterpriseMenuFlyoutPosition(
      { left: 8, right: 256, top: 280 },
      { width: 384, height: 260 },
      { width: 400, height: 600 },
    )).toEqual({ left: 8, top: 280 });
  });

  test('moves a tall flyout upward to keep its bottom edge visible', () => {
    expect(resolveEnterpriseMenuFlyoutPosition(
      { left: 16, right: 264, top: 700 },
      { width: 240, height: 260 },
      { width: 1440, height: 900 },
    )).toEqual({ left: 270, top: 632 });
  });

  test('keeps viewport padding when the flyout nearly fills the window', () => {
    expect(resolveEnterpriseMenuFlyoutPosition(
      { left: 8, right: 256, top: 200 },
      { width: 284, height: 280 },
      { width: 300, height: 300 },
    )).toEqual({ left: 8, top: 12 });
  });
});
