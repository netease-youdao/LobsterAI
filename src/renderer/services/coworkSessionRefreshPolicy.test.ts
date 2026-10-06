import { describe, expect, test } from 'vitest';

import {
  getPreservedMessageWindow,
  shouldReloadCurrentSessionForChange,
} from './coworkSessionRefreshPolicy';

describe('coworkSessionRefreshPolicy', () => {
  test('reloads only when the current session is included in a scoped change', () => {
    expect(shouldReloadCurrentSessionForChange('session-1', {
      sessionIds: ['session-1'],
    })).toBe(true);
    expect(shouldReloadCurrentSessionForChange('session-1', {
      sessionIds: ['session-2'],
    })).toBe(false);
  });

  test('keeps legacy unscoped notifications backward compatible', () => {
    expect(shouldReloadCurrentSessionForChange('session-1')).toBe(true);
    expect(shouldReloadCurrentSessionForChange('session-1', { sessionIds: [] })).toBe(true);
    expect(shouldReloadCurrentSessionForChange(null, { sessionIds: ['session-1'] })).toBe(false);
  });

  test('preserves a history window that starts before the refreshed default page', () => {
    expect(getPreservedMessageWindow(0, 9, 39)).toEqual({
      offset: 0,
      limit: 39,
    });
    expect(getPreservedMessageWindow(14, 15, 45)).toEqual({
      offset: 14,
      limit: 31,
    });
  });

  test('does not request another page when the refreshed window is already sufficient', () => {
    expect(getPreservedMessageWindow(9, 9, 39)).toBeNull();
    expect(getPreservedMessageWindow(10, 9, 39)).toBeNull();
    expect(getPreservedMessageWindow(0, 0, 39)).toBeNull();
  });
});
