/**
 * Type scale for the Settings dialog.
 *
 * Every step derives from `--lobster-ui-font-size`, so the Appearance font
 * slider moves the sidebar and the content pane together. At the default
 * 15px setting: page title 18, nav / section title 15, item title 14,
 * description 13, meta 12.
 *
 * Navigation sits one step above item titles so the sidebar never reads
 * smaller than the rows it opens, and descriptions sit one step below item
 * titles so a row's label and its explanation never share a size.
 */

/** Dialog title in the sidebar and the active tab's title in the content header. */
export const SETTINGS_PAGE_TITLE_TEXT =
  'text-[length:calc(var(--lobster-ui-font-size)_+_3px)] leading-snug';

/** Sidebar tab labels. */
export const SETTINGS_NAV_TEXT =
  'text-[length:var(--lobster-ui-font-size)] leading-snug';

export const SETTINGS_SECTION_TITLE_TEXT =
  'text-[length:var(--lobster-ui-font-size)] leading-snug';

export const SETTINGS_ITEM_TITLE_TEXT =
  'text-[length:calc(var(--lobster-ui-font-size)_-_1px)] leading-snug';

export const SETTINGS_DESCRIPTION_TEXT =
  'text-[length:calc(var(--lobster-ui-font-size)_-_2px)] leading-normal';

export const SETTINGS_META_TEXT =
  'text-[length:calc(var(--lobster-ui-font-size)_-_3px)] leading-normal';
