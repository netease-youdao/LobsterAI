// Preserve the existing near-bottom convenience while attached. After an
// explicit upward gesture, require the viewport to return to the actual bottom
// (allowing for fractional CSS pixels) before following streaming content again.
export const CONVERSATION_AUTO_SCROLL_THRESHOLD = 120;
export const CONVERSATION_AUTO_SCROLL_REATTACH_THRESHOLD = 2;
export const CONVERSATION_PAGINATION_EDGE_THRESHOLD = 80;

export const isWheelScrollingAwayFromBottom = (deltaY: number): boolean => deltaY < 0;

export const canScrollElementInWheelDirection = (
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  deltaY: number,
): boolean => {
  if (scrollHeight <= clientHeight) return false;
  if (deltaY < 0) return scrollTop > 0;
  if (deltaY > 0) return scrollTop + clientHeight < scrollHeight;
  return false;
};

export const shouldAutoScrollForPosition = (
  distanceToBottom: number,
  userDetachedFromBottom: boolean,
  autoScrollLocked = false,
): boolean => {
  if (autoScrollLocked) return false;
  const threshold = userDetachedFromBottom
    ? CONVERSATION_AUTO_SCROLL_REATTACH_THRESHOLD
    : CONVERSATION_AUTO_SCROLL_THRESHOLD;
  return distanceToBottom <= threshold;
};

export const isAtConversationSessionBottom = (
  messagesOffset: number,
  loadedMessageCount: number,
  totalMessageCount: number,
  distanceToLoadedBottom: number,
): boolean => (
  messagesOffset + loadedMessageCount >= totalMessageCount
  && distanceToLoadedBottom <= CONVERSATION_AUTO_SCROLL_REATTACH_THRESHOLD
);

export const shouldLoadNewerConversationMessages = (
  messagesOffset: number,
  loadedMessageCount: number,
  totalMessageCount: number,
  distanceToLoadedBottom: number,
  isLoading: boolean,
): boolean => (
  !isLoading
  && messagesOffset + loadedMessageCount < totalMessageCount
  && distanceToLoadedBottom <= CONVERSATION_PAGINATION_EDGE_THRESHOLD
);
