import { DesktopCompanionSize } from './constants';
import { clampCompanionBounds, type CompanionPoint, type CompanionRect } from './geometry';

export const CompanionContextMenuIpc = {
  Run: 'desktop-companion:context-menu-run',
  Ready: 'desktop-companion:context-menu-ready',
  Dismiss: 'desktop-companion:context-menu-dismiss',
} as const;

/** The card a context menu opens with; submenus are keyed by the id of the item that opens them. */
export const COMPANION_CONTEXT_MENU_ROOT = 'root';

/**
 * Fixed card metrics, shared with the renderer's styles so the window can be placed before it paints.
 * Rows match the quick panel's menus (15px text with 8px above and below).
 */
export const CompanionContextMenuSize = {
  Width: 224,
  SubmenuWidth: 184,
  Item: 36,
  /** A group break: a 1px rule with 4px above and below. */
  Divider: 9,
  /** The card's padding plus its border, on each side. */
  Chrome: 5,
} as const;

export interface CompanionContextMenuItem {
  id: string;
  label: string;
  /** Starts a new group below a divider; never set on the first item. */
  divided?: boolean;
  /** A radio choice; true marks the current one. */
  checked?: boolean;
  submenu?: CompanionContextMenuItem[];
}

export interface CompanionContextMenuState {
  /** Identifies one opening, so the renderer resets its highlight and acknowledges the right frame. */
  id: string;
  items: CompanionContextMenuItem[];
  /** Each card's top-left corner inside the window. */
  cards: Record<string, CompanionPoint>;
}

export interface CompanionContextMenuBridge {
  runContextMenuItem(id: string): Promise<void>;
  /** The menu has painted this opening; resolves true once its window is shown. */
  contextMenuReady(id: string): Promise<boolean>;
  dismissContextMenu(): Promise<void>;
}

export interface CompanionContextMenuLayout {
  bounds: CompanionRect;
  cards: Record<string, CompanionPoint>;
}

/** Each item's top inside its card, and the card's height. */
function measureCard(items: CompanionContextMenuItem[]): { tops: number[]; height: number } {
  let y = CompanionContextMenuSize.Chrome;
  const tops = items.map(item => {
    if (item.divided) y += CompanionContextMenuSize.Divider;
    const top = y;
    y += CompanionContextMenuSize.Item;
    return top;
  });
  return { tops, height: y + CompanionContextMenuSize.Chrome };
}

/**
 * Opens like a native context menu: from the pointer, flipped toward the room
 * left on screen. Submenus open on the right unless only the left has room,
 * level with the item that opens them. The window covers every card plus the
 * transparent shadow margin, so a submenu opens without moving the window.
 */
export function resolveCompanionContextMenuLayout(
  pointer: CompanionPoint,
  items: CompanionContextMenuItem[],
  workArea: CompanionRect,
): CompanionContextMenuLayout {
  const pad = DesktopCompanionSize.SurfacePad;
  const area = { x: workArea.x + pad, y: workArea.y + pad, width: workArea.width - pad * 2, height: workArea.height - pad * 2 };
  const right = area.x + area.width;
  const root = measureCard(items);
  const width = CompanionContextMenuSize.Width;
  const subWidth = CompanionContextMenuSize.SubmenuWidth;
  const menu = clampCompanionBounds({
    width,
    height: root.height,
    x: pointer.x + width <= right ? pointer.x : pointer.x - width,
    y: pointer.y + root.height <= area.y + area.height ? pointer.y : pointer.y - root.height,
  }, area);
  const opensRight = menu.x + menu.width + subWidth <= right || menu.x - subWidth < area.x;
  const cards: Array<[string, CompanionRect]> = [[COMPANION_CONTEXT_MENU_ROOT, menu]];
  items.forEach((item, index) => {
    if (!item.submenu?.length) return;
    cards.push([item.id, clampCompanionBounds({
      width: subWidth,
      height: measureCard(item.submenu).height,
      x: opensRight ? menu.x + menu.width : menu.x - subWidth,
      y: menu.y + root.tops[index] - CompanionContextMenuSize.Chrome,
    }, area)]);
  });
  const left = Math.min(...cards.map(([, card]) => card.x)) - pad;
  const top = Math.min(...cards.map(([, card]) => card.y)) - pad;
  return {
    bounds: {
      x: left,
      y: top,
      width: Math.max(...cards.map(([, card]) => card.x + card.width)) + pad - left,
      height: Math.max(...cards.map(([, card]) => card.y + card.height)) + pad - top,
    },
    cards: Object.fromEntries(cards.map(([id, card]) => [id, { x: card.x - left, y: card.y - top }])),
  };
}
