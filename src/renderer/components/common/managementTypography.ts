/**
 * Type scale for the management pages (Kits / Skills / MCP).
 *
 * Sizes derive from `--lobster-ui-font-size` — the single "UI font size" the
 * user sets under Appearance — so one slider moves the whole page instead of
 * leaving titles and badges frozen while the body text shrinks around them.
 *
 * `calc()` rather than a `--lobster-text-*` token: those are written through
 * `Math.round()`, which would bounce a half-pixel step up to the next whole
 * pixel and undo the offsets below.
 *
 * At the default 15px setting: page title 15.5, title 14.5, body 14, meta 12.
 * Compact controls use `text-xs`, which resolves to 13px and already scales.
 */

/** Page header titles in the top bar (Kits / Scheduled Tasks / Skills tabs). */
export const MANAGEMENT_PAGE_TITLE_TEXT =
  'text-[length:calc(var(--lobster-ui-font-size)_+_0.5px)]';

/** Card and tab titles, and detail-dialog prose. */
export const MANAGEMENT_TITLE_TEXT =
  'text-[length:calc(var(--lobster-ui-font-size)_-_0.5px)]';

/** Page descriptions, section headings, detail rows and footer actions. */
export const MANAGEMENT_BODY_TEXT =
  'text-[length:calc(var(--lobster-ui-font-size)_-_1px)]';

/** Badge strips: card meta, counts, pills, stat labels. */
export const MANAGEMENT_META_TEXT =
  'text-[length:calc(var(--lobster-ui-font-size)_-_3px)]';
