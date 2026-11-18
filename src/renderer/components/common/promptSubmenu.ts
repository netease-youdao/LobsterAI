/** Which side of the prompt's add menu its submenus open on. */
export const PromptSubmenuSide = { Left: 'left', Right: 'right' } as const;
export type PromptSubmenuSide = typeof PromptSubmenuSide[keyof typeof PromptSubmenuSide];

/** The add-menu pickers that share one open state, alongside the skills submenu. */
export const PromptFoldedTool = { Experts: 'experts', Kits: 'kits', Media: 'media' } as const;
export type PromptFoldedTool = typeof PromptFoldedTool[keyof typeof PromptFoldedTool];

/** A picker shown as a row of the add menu: the menu decides which submenu is open, and on which side. */
export interface PromptMenuItemControl {
  open: boolean;
  side: PromptSubmenuSide;
  onOpenChange: (open: boolean) => void;
}

/** The widest submenu, the media model list. */
export const PROMPT_SUBMENU_MAX_WIDTH = 400;

/** Submenus open to the right, unless that side cannot fit them and the left has more room. */
export function resolvePromptSubmenuSide(
  menu: { left: number; right: number },
  viewportWidth: number,
  submenuWidth = PROMPT_SUBMENU_MAX_WIDTH,
): PromptSubmenuSide {
  const roomRight = viewportWidth - menu.right;
  return roomRight >= submenuWidth || roomRight >= menu.left ? PromptSubmenuSide.Right : PromptSubmenuSide.Left;
}

/** Submenus hang off the add menu, bottom-aligned with it and overlapping its border. */
export const PROMPT_SUBMENU_POSITION_CLASS: Record<PromptSubmenuSide, string> = {
  [PromptSubmenuSide.Left]: 'absolute bottom-0 right-[calc(100%-1px)]',
  [PromptSubmenuSide.Right]: 'absolute bottom-0 left-[calc(100%-1px)]',
};

export const PROMPT_MENU_ROW_CLASS = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50';
