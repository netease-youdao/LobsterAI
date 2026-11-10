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
  test('opens down and right from the pointer, with the submenu level with its item', () => {
    const layout = resolveCompanionContextMenuLayout({ x: 300, y: 200 }, items, workArea);
    const menu = onScreen(layout, ROOT, Size.Width, menuHeight);
    const submenu = onScreen(layout, '4', Size.SubmenuWidth, submenuHeight);
    expect(menu).toMatchObject({ x: 300, y: 200 });
    expect(submenu.x).toBe(menu.x + Size.Width);
    // Its first choice lines up with "Change skin", the fourth item after one divider.
    expect(submenu.y).toBe(menu.y + Size.Item * 3 + Size.Divider);
    expect(layout.bounds).toEqual({
      x: 300 - pad, y: 200 - pad,
      width: Size.Width + Size.SubmenuWidth + pad * 2,
      height: submenu.y + submenuHeight + pad - (200 - pad),
    });
  });

  test('beside an orb in the lower right it opens up and left, and the submenu stays on screen', () => {
    const pointer = { x: 1400, y: 820 };
    const layout = resolveCompanionContextMenuLayout(pointer, items, workArea);
    const menu = onScreen(layout, ROOT, Size.Width, menuHeight);
    const submenu = onScreen(layout, '4', Size.SubmenuWidth, submenuHeight);
    expect(menu).toMatchObject({ x: pointer.x - Size.Width, y: pointer.y - menuHeight });
    expect(submenu.x).toBe(menu.x - Size.SubmenuWidth);
    // Too tall to line up with its item, so it rises to fit above the bottom margin.
    expect(submenu.y + submenuHeight).toBe(workArea.y + workArea.height - pad);
    expect(layout.bounds.x + layout.bounds.width).toBe(menu.x + Size.Width + pad);
  });

  test('a menu without submenus only covers its own card and keeps its shadow margin on screen', () => {
    const plain = items.filter(item => !item.submenu);
    const layout = resolveCompanionContextMenuLayout({ x: 10, y: 30 }, plain, workArea);
    const menu = onScreen(layout, ROOT, Size.Width, Size.Chrome * 2 + Size.Item * 5 + Size.Divider * 2);
    expect(layout.cards).toEqual({ [ROOT]: { x: pad, y: pad } });
    expect(menu).toMatchObject({ x: workArea.x + pad, y: workArea.y + pad });
    expect(layout.bounds).toMatchObject({ width: Size.Width + pad * 2 });
  });
});
