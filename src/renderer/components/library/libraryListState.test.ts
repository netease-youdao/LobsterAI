import { describe, expect, test } from 'vitest';

import { HtmlShareStatus } from '../../../shared/htmlShare/constants';
import {
  LibraryItemKind,
  LibraryLocalProtocol,
  LibraryLocalSort,
  LibrarySharedStatusFilter,
} from '../../../shared/library/constants';
import type { LocalArtifactItem, SharedFileItem } from '../../../shared/library/types';
import {
  applyLibraryFavoriteState,
  getLibrarySharedStatusCount,
  hideLibraryCloudItems,
  hideLibraryLocalItems,
  matchesLibrarySharedStatus,
  removeLibraryCloudItem,
  restoreLibraryFavoriteState,
} from './libraryListState';

const makeLocalItem = (itemId: string, isFavorite: boolean): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId,
  title: `${itemId}.pdf`,
  category: 'document',
  sortTime: 1,
  createdAt: 1,
  isFavorite,
  latestSession: {
    sessionId: 'session-1',
    title: 'Task',
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
    lastRelatedAt: 1,
  },
  filePath: `/tmp/${itemId}.pdf`,
  artifactType: 'document',
  extension: '.pdf',
  availability: 'available',
  origin: 'conversation',
  relatedSessionCount: 1,
});

describe('library list state', () => {
  test('updates favorite state in place and removes an unfavorited filtered item', () => {
    const first = makeLocalItem('first', false);
    const second = makeLocalItem('second', true);

    expect(applyLibraryFavoriteState([first, second], first, true, false)).toEqual([
      { ...first, isFavorite: true },
      second,
    ]);
    expect(applyLibraryFavoriteState([first, second], second, false, true)).toEqual([first]);
  });

  test('restores a filtered item when persisting its favorite state fails', () => {
    const item = makeLocalItem('item-1', true);
    expect(restoreLibraryFavoriteState([], item)).toEqual([item]);
  });

  test('hides local items without clearing the source count', () => {
    expect(hideLibraryLocalItems({
      protocolVersion: LibraryLocalProtocol.Version,
      sort: LibraryLocalSort.RecentTask,
      list: [],
      nextCursor: 'local-next',
      hasMore: true,
      counts: { total: 12, available: 10, missing: 2 },
    })).toEqual({
      protocolVersion: LibraryLocalProtocol.Version,
      sort: LibraryLocalSort.RecentTask,
      list: [],
      hasMore: false,
      counts: { total: 12, available: 10, missing: 2 },
    });
  });

  test('hides cloud items without clearing share and site counts', () => {
    expect(hideLibraryCloudItems({
      list: [],
      nextCursor: 'cloud-next',
      hasMore: true,
      counts: { sharedFile: 83, deployedSite: 14 },
      sharedStatusCounts: { all: 83, live: 70, disabled: 13 },
      serverNow: 1_000,
    })).toEqual({
      list: [],
      hasMore: false,
      counts: { sharedFile: 83, deployedSite: 14 },
      sharedStatusCounts: { all: 83, live: 70, disabled: 13 },
      serverNow: 1_000,
    });
  });

  test('reads exact shared status facets when provided', () => {
    const data = {
      counts: { sharedFile: 83, deployedSite: 14 },
      sharedStatusCounts: { all: 83, live: 70, disabled: 13 },
    };

    expect(getLibrarySharedStatusCount(data, LibrarySharedStatusFilter.All)).toBe(83);
    expect(getLibrarySharedStatusCount(data, LibrarySharedStatusFilter.Live)).toBe(70);
    expect(getLibrarySharedStatusCount(data, LibrarySharedStatusFilter.Disabled)).toBe(13);
  });

  test('keeps legacy cloud responses renderable without status facets', () => {
    const legacyData = {
      counts: { sharedFile: 83, deployedSite: 14 },
    };

    expect(getLibrarySharedStatusCount(legacyData, LibrarySharedStatusFilter.All)).toBe(83);
    expect(getLibrarySharedStatusCount(legacyData, LibrarySharedStatusFilter.Live)).toBeUndefined();
    expect(
      getLibrarySharedStatusCount(legacyData, LibrarySharedStatusFilter.Disabled),
    ).toBeUndefined();
  });

  test('filters mixed legacy results by the selected shared status', () => {
    const liveItem = { status: HtmlShareStatus.Live };
    const disabledItem = { status: HtmlShareStatus.Disabled };

    expect(matchesLibrarySharedStatus(liveItem, LibrarySharedStatusFilter.All)).toBe(true);
    expect(matchesLibrarySharedStatus(disabledItem, LibrarySharedStatusFilter.All)).toBe(true);
    expect(matchesLibrarySharedStatus(liveItem, LibrarySharedStatusFilter.Live)).toBe(true);
    expect(matchesLibrarySharedStatus(disabledItem, LibrarySharedStatusFilter.Live)).toBe(false);
    expect(matchesLibrarySharedStatus(liveItem, LibrarySharedStatusFilter.Disabled)).toBe(false);
    expect(matchesLibrarySharedStatus(disabledItem, LibrarySharedStatusFilter.Disabled)).toBe(true);
  });

  test('removes a deleted stopped share and updates all cloud count facets', () => {
    const deletedItem: SharedFileItem = {
      itemKind: LibraryItemKind.SharedFile,
      itemId: 'shr_deleted',
      shareId: 'shr_deleted',
      title: 'report.pdf',
      category: 'document',
      sortTime: 1,
      createdAt: 1,
      isFavorite: false,
      url: 'https://example.test/s/shr_deleted/',
      sourceType: 'document_file',
      accessMode: 'public',
      status: HtmlShareStatus.Disabled,
    };
    const data = {
      list: [deletedItem],
      hasMore: false,
      counts: { sharedFile: 10, deployedSite: 2 },
      sharedStatusCounts: { all: 10, live: 7, disabled: 3 },
    };

    expect(removeLibraryCloudItem(data, deletedItem)).toEqual({
      ...data,
      list: [],
      counts: { sharedFile: 9, deployedSite: 2 },
      sharedStatusCounts: { all: 9, live: 7, disabled: 2 },
    });
  });
});
