import { describe, expect, test } from 'vitest';

import {
  canScrollElementInWheelDirection,
  CONVERSATION_AUTO_SCROLL_REATTACH_THRESHOLD,
  CONVERSATION_AUTO_SCROLL_THRESHOLD,
  CONVERSATION_PAGINATION_EDGE_THRESHOLD,
  isAtConversationSessionBottom,
  isWheelScrollingAwayFromBottom,
  shouldAutoScrollForPosition,
  shouldLoadNewerConversationMessages,
} from './conversationScrollPolicy';

describe('conversationScrollPolicy', () => {
  test('keeps the existing near-bottom threshold while attached', () => {
    expect(shouldAutoScrollForPosition(CONVERSATION_AUTO_SCROLL_THRESHOLD, false)).toBe(true);
    expect(shouldAutoScrollForPosition(CONVERSATION_AUTO_SCROLL_THRESHOLD + 1, false)).toBe(false);
  });

  test('does not reattach a user who scrolled upward until reaching the bottom', () => {
    expect(shouldAutoScrollForPosition(CONVERSATION_AUTO_SCROLL_THRESHOLD, true)).toBe(false);
    expect(shouldAutoScrollForPosition(CONVERSATION_AUTO_SCROLL_REATTACH_THRESHOLD + 1, true)).toBe(false);
    expect(shouldAutoScrollForPosition(CONVERSATION_AUTO_SCROLL_REATTACH_THRESHOLD, true)).toBe(true);
  });

  test('keeps auto-scroll disabled while programmatic navigation owns the viewport', () => {
    expect(shouldAutoScrollForPosition(0, true, true)).toBe(false);
    expect(shouldAutoScrollForPosition(0, false, true)).toBe(false);
  });

  test('distinguishes a paged window bottom from the real session bottom', () => {
    expect(isAtConversationSessionBottom(0, 50, 171, 0)).toBe(false);
    expect(isAtConversationSessionBottom(121, 50, 171, 0)).toBe(true);
    expect(isAtConversationSessionBottom(
      121,
      50,
      171,
      CONVERSATION_AUTO_SCROLL_REATTACH_THRESHOLD + 1,
    )).toBe(false);
  });

  test('loads the next page only near the bottom of a non-final message window', () => {
    expect(shouldLoadNewerConversationMessages(0, 50, 171, 0, false)).toBe(true);
    expect(shouldLoadNewerConversationMessages(
      0,
      50,
      171,
      CONVERSATION_PAGINATION_EDGE_THRESHOLD + 1,
      false,
    )).toBe(false);
    expect(shouldLoadNewerConversationMessages(121, 50, 171, 0, false)).toBe(false);
    expect(shouldLoadNewerConversationMessages(0, 50, 171, 0, true)).toBe(false);
  });

  test('treats only upward wheel movement as scrolling away from the bottom', () => {
    expect(isWheelScrollingAwayFromBottom(-1)).toBe(true);
    expect(isWheelScrollingAwayFromBottom(0)).toBe(false);
    expect(isWheelScrollingAwayFromBottom(1)).toBe(false);
  });

  test('allows nested scroll areas to consume wheel movement before the conversation', () => {
    expect(canScrollElementInWheelDirection(20, 200, 100, -1)).toBe(true);
    expect(canScrollElementInWheelDirection(0, 200, 100, -1)).toBe(false);
    expect(canScrollElementInWheelDirection(20, 200, 100, 1)).toBe(true);
    expect(canScrollElementInWheelDirection(100, 200, 100, 1)).toBe(false);
    expect(canScrollElementInWheelDirection(0, 100, 100, -1)).toBe(false);
  });
});
