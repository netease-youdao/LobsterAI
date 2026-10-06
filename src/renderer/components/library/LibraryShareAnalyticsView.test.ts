import { describe, expect, test } from 'vitest';

import { libraryShareAnalyticsDateValues } from './LibraryShareAnalyticsView';

describe('libraryShareAnalyticsDateValues', () => {
  test('builds inclusive 7-day and 30-day local ranges', () => {
    const today = new Date(2026, 7, 19, 12, 0, 0);

    expect(libraryShareAnalyticsDateValues(7, today)).toEqual({
      from: '2026-08-13',
      to: '2026-08-19',
    });
    expect(libraryShareAnalyticsDateValues(30, today)).toEqual({
      from: '2026-07-21',
      to: '2026-08-19',
    });
  });
});
