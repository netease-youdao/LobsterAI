import { describe, expect, test, vi } from 'vitest';

import {
  countUserMessageLines,
  expandCollapsedUserMessage,
  shouldCollapseUserMessage,
  USER_MESSAGE_COLLAPSE_MIN_HEIGHT_PX,
  USER_MESSAGE_COLLAPSED_HEIGHT_PX,
  USER_MESSAGE_EXPAND_EVENT,
} from './userMessageCollapse';

describe('shouldCollapseUserMessage', () => {
  test('only collapses when enough content would be hidden', () => {
    expect(USER_MESSAGE_COLLAPSE_MIN_HEIGHT_PX).toBeGreaterThan(USER_MESSAGE_COLLAPSED_HEIGHT_PX);
    expect(shouldCollapseUserMessage(USER_MESSAGE_COLLAPSED_HEIGHT_PX + 1)).toBe(false);
    expect(shouldCollapseUserMessage(USER_MESSAGE_COLLAPSE_MIN_HEIGHT_PX)).toBe(false);
    expect(shouldCollapseUserMessage(USER_MESSAGE_COLLAPSE_MIN_HEIGHT_PX + 1)).toBe(true);
    expect(shouldCollapseUserMessage(Number.NaN)).toBe(false);
  });
});

describe('countUserMessageLines', () => {
  test('counts rendered lines including wrapping, independent of source newlines', () => {
    expect(countUserMessageLines(23, 23)).toBe(1);
    expect(countUserMessageLines(989, 23)).toBe(43);
    expect(countUserMessageLines(1380, 23)).toBe(60);
    expect(countUserMessageLines(69.001, 23)).toBe(3);
  });

  test('ignores unmeasurable or hidden text blocks', () => {
    expect(countUserMessageLines(0, 23)).toBe(0);
    expect(countUserMessageLines(100, 0)).toBe(0);
    expect(countUserMessageLines(100, Number.NaN)).toBe(0);
    expect(countUserMessageLines(Number.POSITIVE_INFINITY, 23)).toBe(0);
  });
});

describe('expandCollapsedUserMessage', () => {
  test('asks the collapsed ancestor to expand', () => {
    const dispatchEvent = vi.fn();
    const element = { closest: vi.fn(() => ({ dispatchEvent })) } as unknown as Element;
    expect(expandCollapsedUserMessage(element)).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: USER_MESSAGE_EXPAND_EVENT }));
  });

  test('does nothing outside a collapsed message', () => {
    const element = { closest: vi.fn(() => null) } as unknown as Element;
    expect(expandCollapsedUserMessage(element)).toBe(false);
  });
});
