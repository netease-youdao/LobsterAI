import { describe, expect, test } from 'vitest';

import { DesktopCompanionSize } from './constants';
import {
  COMPANION_CONTEXT_MENU_ROOT as ROOT,
  type CompanionContextMenuItem,
  CompanionContextMenuSize as Size,
  resolveCompanionContextMenuLayout,
} from './contextMenu';

const pad = DesktopCompanionSize.SurfacePad;
const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const skins = Array.from({ length: 9 }, (_, index) => ({ id: `3.${index}`, label: `Skin ${index}`, checked: index === 0 }));
const items: CompanionContextMenuItem[] = [
  { id: '0', label: 'Open app' },
  { id: '1', label: 'Open panel' },
  { id: '3', label: 'Screenshot', divided: true },
  { id: '4', label: 'Change skin', submenu: skins },
  { id: '6', label: 'Quiet for today', divided: true },
  { id: '7', label: 'Settings' },
];
// Six items in three groups.
const menuHeight = Size.Chrome * 2 + Size.Item * 6 + Size.Divider * 2;
const submenuHeight = Size.Chrome * 2 + Size.Item * 9;

function onScreen(layout: ReturnType<typeof resolveCompanionContextMenuLayout>, id: string, width: number, height: number) {
  const card = { x: layout.bounds.x + layout.cards[id].x, y: layout.bounds.y + layout.cards[id].y, width, height };
  expect(card.x).toBeGreaterThanOrEqual(workArea.x + pad);
  expect(card.y).toBeGreaterThanOrEqual(workArea.y + pad);
  expect(card.x + width).toBeLessThanOrEqual(workArea.x + workArea.width - pad);
  expect(card.y + height).toBeLessThanOrEqual(workArea.y + workArea.height - pad);
  return card;
}

describe('companion context menu layout', () => {
  test('beside an orb in the lower right it rises from the orb\'s middle on its left, and the submenu keeps going left', () => {
    const orb = { x: 1356, y: 790, width: 84, height: 84 };
    const layout = resolveCompanionContextMenuLayout(orb, items, workArea);
    const menu = onScreen(layout, ROOT, Size.Width, menuHeight);
    const submenu = onScreen(layout, '4', Size.SubmenuWidth, submenuHeight);
    expect(menu).toMatchObject({ x: orb.x - Size.Width, y: orb.y + orb.height / 2 - menuHeight });
    expect(submenu.x).toBe(menu.x - Size.SubmenuWidth);
    // Too tall to line up with its item, so it rises to fit above the bottom margin.
    expect(submenu.y + submenuHeight).toBe(workArea.y + workArea.height - pad);
    expect(layout.bounds.x + layout.bounds.width).toBe(orb.x + pad);
  });

  test('beside an orb high on the left it hangs from the orb\'s middle on its right, with the submenu level with its item', () => {
    const orb = { x: 0, y: 200, width: 60, height: 60 };
    const layout = resolveCompanionContextMenuLayout(orb, items, workArea);
    const menu = onScreen(layout, ROOT, Size.Width, menuHeight);
    const submenu = onScreen(layout, '4', Size.SubmenuWidth, submenuHeight);
    expect(menu).toMatchObject({ x: orb.width, y: orb.y + orb.height / 2 });
    expect(submenu.x).toBe(menu.x + Size.Width);
    // Its first choice lines up with "Change skin", the fourth item after one divider.
    expect(submenu.y).toBe(menu.y + Size.Item * 3 + Size.Divider);
    expect(layout.bounds).toEqual({
      x: menu.x - pad, y: menu.y - pad,
      width: Size.Width + Size.SubmenuWidth + pad * 2,
      height: submenu.y + submenuHeight + pad - (menu.y - pad),
    });
  });

  test('a submenu turns back over the orb only when the far side has no room', () => {
    const narrow = { x: 0, y: 25, width: 600, height: 875 };
    const orb = { x: 310, y: 300, width: 84, height: 84 };
    const layout = resolveCompanionContextMenuLayout(orb, items, narrow);
    expect(layout.bounds.x + layout.cards[ROOT].x).toBe(orb.x - Size.Width);
    expect(layout.bounds.x + layout.cards['4'].x).toBe(orb.x);
  });

  test('without an orb it opens from the pointer, only covers its own card and keeps its shadow margin on screen', () => {
    const plain = items.filter(item => !item.submenu);
    const layout = resolveCompanionContextMenuLayout({ x: 10, y: 30, width: 0, height: 0 }, plain, workArea);
    const menu = onScreen(layout, ROOT, Size.Width, Size.Chrome * 2 + Size.Item * 5 + Size.Divider * 2);
    expect(layout.cards).toEqual({ [ROOT]: { x: pad, y: pad } });
    expect(menu).toMatchObject({ x: workArea.x + pad, y: workArea.y + pad });
    expect(layout.bounds).toMatchObject({ width: Size.Width + pad * 2 });
  });
});
