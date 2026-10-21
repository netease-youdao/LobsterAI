import { describe, expect, test } from 'vitest';

import { PromptSubmenuSide, resolvePromptSubmenuSide } from './promptSubmenu';

describe('resolvePromptSubmenuSide', () => {
  test('opens to the right when the widest submenu fits there', () => {
    expect(resolvePromptSubmenuSide({ left: 300, right: 492 }, 1280)).toBe(PromptSubmenuSide.Right);
  });

  test('opens to the left of a menu near the right edge, where the room is', () => {
    // The desktop companion's card opens left of the orb; its window has room on the left.
    expect(resolvePromptSubmenuSide({ left: 438, right: 630 }, 846)).toBe(PromptSubmenuSide.Left);
  });

  test('stays on the right when neither side fits but the right has more room', () => {
    expect(resolvePromptSubmenuSide({ left: 38, right: 230 }, 520)).toBe(PromptSubmenuSide.Right);
  });
});
