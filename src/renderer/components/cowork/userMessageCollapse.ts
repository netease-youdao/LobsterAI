// Long user messages are clipped to a fixed height so the reply below stays
// within reach. Heights follow the compact markdown line height (23px): show
// 12 lines when collapsed, and only collapse when at least 4 more are hidden.
export const USER_MESSAGE_COLLAPSED_HEIGHT_PX = 276;
export const USER_MESSAGE_COLLAPSE_MIN_HEIGHT_PX = 368;

export const USER_MESSAGE_EXPAND_EVENT = 'cowork:user-message-expand';
export const USER_MESSAGE_COLLAPSED_ATTRIBUTE = 'data-cowork-user-message-collapsed';
export const USER_MESSAGE_TEXT_ATTRIBUTE = 'data-cowork-user-message-text';

export const shouldCollapseUserMessage = (contentHeight: number): boolean => (
  Number.isFinite(contentHeight) && contentHeight > USER_MESSAGE_COLLAPSE_MIN_HEIGHT_PX
);

// UserMessageContent renders each text block with a uniform line height. Use
// its layout height so wrapped lines and blank lines count, but images do not.
export const countUserMessageLines = (height: number, lineHeight: number): number => (
  Number.isFinite(height) && Number.isFinite(lineHeight) && height > 0 && lineHeight > 0
    ? Math.round(height / lineHeight)
    : 0
);

/**
 * Expands the collapsed user message containing `element`, if any. Returns
 * true when an expansion was requested so callers can re-measure next frame.
 */
export const expandCollapsedUserMessage = (element: Element): boolean => {
  const collapsed = element.closest(`[${USER_MESSAGE_COLLAPSED_ATTRIBUTE}="true"]`);
  if (!collapsed) return false;
  collapsed.dispatchEvent(new CustomEvent(USER_MESSAGE_EXPAND_EVENT));
  return true;
};
