import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/services/logReporter', async () => {
  const actual = await vi.importActual<typeof import('@/services/logReporter')>(
    '@/services/logReporter'
  );
  return { ...actual, reportYdAnalyzer: vi.fn() };
});

import {
  LibraryCategory,
  LibraryCloudAvailabilityFilter,
  LibrarySourceFilter,
  LibraryViewMode,
} from '@shared/library/constants';

import { LogReporterAction, reportYdAnalyzer } from '@/services/logReporter';

import {
  getLibraryLoadedItemCountBucket,
  getLibrarySearchLengthBucket,
  LibraryAnalyticsActionType,
  LibraryAnalyticsControl,
  LibraryAnalyticsSurface,
  reportLibraryAction,
} from './libraryAnalytics';

beforeEach(() => {
  vi.mocked(reportYdAnalyzer).mockReset();
});

describe('library analytics', () => {
  test('buckets search length and result counts', () => {
    expect(getLibrarySearchLengthBucket('')).toBe('0');
    expect(getLibrarySearchLengthBucket('12345678901')).toBe('11_30');
    expect(getLibraryLoadedItemCountBucket(0)).toBe('0');
    expect(getLibraryLoadedItemCountBucket(21)).toBe('21_50');
  });

  test('reports my-files context without the search text', () => {
    reportLibraryAction({
      pageViewId: 'page-view-1',
      librarySource: LibrarySourceFilter.Cloud,
      category: LibraryCategory.Document,
      availability: LibraryCloudAvailabilityFilter.Available,
      favoritesOnly: true,
      keyword: 'private search text',
      viewMode: LibraryViewMode.List,
      isAuthenticated: true,
    }, {
      actionType: LibraryAnalyticsActionType.FilterChange,
      control: LibraryAnalyticsControl.Category,
      targetValue: LibraryCategory.Document,
      loadedItemCount: 7,
    });

    expect(reportYdAnalyzer).toHaveBeenCalledWith(expect.objectContaining({
      action: LogReporterAction.LibraryAction,
      surface: LibraryAnalyticsSurface.MyFiles,
      pageViewId: 'page-view-1',
      librarySource: LibrarySourceFilter.Cloud,
      actionType: LibraryAnalyticsActionType.FilterChange,
      hasSearch: true,
      searchLengthBucket: '11_30',
      loadedItemCountBucket: '6_20',
    }));
    expect(JSON.stringify(vi.mocked(reportYdAnalyzer).mock.calls))
      .not.toContain('private search text');
  });
});
