import { describe, expect, test } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryItemKind,
  LibraryLocalProtocol,
  LibraryLocalSort,
  LibraryOrigin,
} from '../../../shared/library/constants';
import type { LibraryLocalListData, LocalArtifactItem } from '../../../shared/library/types';
import {
  applyLibraryLocalItemChanges,
  getLibraryQueryLoadIntent,
  isLibraryBusyPhase,
  isLibraryRefreshPhase,
  LibraryLoadIntent,
  LibraryLoadPhase,
  matchesLibraryLocalQuery,
  shouldShowLibraryInitialSkeleton,
} from './libraryLocalQueryState';

const makeItem = (
  itemId: string,
  sortTime: number,
  overrides: Partial<LocalArtifactItem> = {},
): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId,
  title: `${itemId}.pdf`,
  category: LibraryCategory.Document,
  sortTime,
  createdAt: sortTime,
  isFavorite: false,
  latestSession: {
    sessionId: `session-${itemId}`,
    title: `Task ${itemId}`,
    agentId: 'main',
    createdAt: 1,
    updatedAt: sortTime,
    lastRelatedAt: sortTime,
  },
  filePath: `/tmp/${itemId}.pdf`,
  artifactType: LibraryArtifactType.Document,
  extension: '.pdf',
  availability: LibraryAvailability.Available,
  origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1,
  ...overrides,
});

const makeData = (list: LocalArtifactItem[], hasMore = false): LibraryLocalListData => ({
  protocolVersion: LibraryLocalProtocol.Version,
  sort: LibraryLocalSort.RecentTask,
  list,
  hasMore,
  ...(hasMore ? { nextCursor: 'cursor' } : {}),
  counts: { total: list.length, available: list.length, missing: 0 },
});

const allQuery = {
  category: LibraryCategory.All,
  keyword: '',
  favoritesOnly: false,
};

describe('library local query state', () => {
  test('keeps the snapshot when membership changes need authoritative counts', () => {
    const first = makeItem('first', 100);
    const second = makeItem('second', 90);
    const updatedSecond = makeItem('second', 120, {
      latestSession: { ...second.latestSession, title: 'Updated task' },
    });
    const inserted = makeItem('inserted', 110);

    const result = applyLibraryLocalItemChanges(
      makeData([first, second]),
      { items: [updatedSecond, inserted], unavailableItemIds: ['first'] },
      allQuery,
    );

    expect(result.requiresAuthoritativeRefresh).toBe(true);
    expect(result.data.list.map(item => item.itemId)).toEqual(['first', 'second']);
  });

  test('does not insert an unseen item beyond the loaded cursor boundary', () => {
    const current = makeData([makeItem('newest', 100), makeItem('tail', 50)], true);
    const older = makeItem('older', 40);
    older.latestSession.updatedAt = 0;
    const result = applyLibraryLocalItemChanges(
      current,
      { items: [older], unavailableItemIds: [] },
      allQuery,
    );

    expect(result.data.list.map(item => item.itemId)).toEqual(['newest', 'tail']);
    expect(result.data.nextCursor).toBe('cursor');
    expect(result.requiresAuthoritativeRefresh).toBe(false);
  });

  test('reorders a fully loaded task without growing the browsing window', () => {
    const first = makeItem('a', 100);
    const second = makeItem('b', 90, { latestSession: first.latestSession });
    const result = applyLibraryLocalItemChanges(makeData([first, second]), {
      items: [{ ...second, sortTime: 110 }], unavailableItemIds: [],
    }, allQuery);
    expect(result.requiresAuthoritativeRefresh).toBe(false);
    expect(result.data.list.map(item => item.itemId)).toEqual(['b', 'a']);
  });

  test('preserves a paginated snapshot when an existing ordering key changes', () => {
    const first = makeItem('first', 100);
    const current = makeData([first], true);
    const result = applyLibraryLocalItemChanges(current, {
      items: [{ ...first, sortTime: 99 }], unavailableItemIds: [],
    }, allQuery);
    expect(result.requiresAuthoritativeRefresh).toBe(true);
    expect(result.data).toBe(current);
  });

  test('never repairs task projection changes using only loaded files', () => {
    const first = makeItem('first', 100);
    for (const latestSession of [
      { ...first.latestSession, updatedAt: 0.5 },
      { ...first.latestSession, createdAt: 0.5 },
      { ...first.latestSession, sessionId: 'other' },
      { ...first.latestSession, title: 'Renamed' },
      { ...first.latestSession, agentId: 'other' },
    ]) {
      const current = makeData([first]);
      const result = applyLibraryLocalItemChanges(current, {
        items: [{ ...first, latestSession }], unavailableItemIds: [],
      }, allQuery);
      expect(result.requiresAuthoritativeRefresh).toBe(true);
      expect(result.data).toBe(current);
    }
  });

  test('merges ordinary favorites but revalidates favorites-only membership', () => {
    const first = makeItem('first', 100);
    const current = makeData([first], true);
    const favorite = { ...first, isFavorite: true };
    const ordinary = applyLibraryLocalItemChanges(current, {
      items: [favorite], unavailableItemIds: [],
    }, allQuery);
    expect(ordinary.requiresAuthoritativeRefresh).toBe(false);
    expect(ordinary.data.list[0].isFavorite).toBe(true);
    const filtered = applyLibraryLocalItemChanges(makeData([favorite], true), {
      items: [first], unavailableItemIds: [],
    }, { ...allQuery, favoritesOnly: true });
    expect(filtered.requiresAuthoritativeRefresh).toBe(true);
  });

  test('disallows targeted merges over dirty or in-flight snapshots', () => {
    const current = makeData([makeItem('first', 100)]);
    for (const context of [{ dirty: true }, { inFlight: true }]) {
      expect(applyLibraryLocalItemChanges(current, {
        items: current.list, unavailableItemIds: [],
      }, allQuery, context).requiresAuthoritativeRefresh).toBe(true);
    }
  });

  test('updates availability counts without changing a valid pagination boundary', () => {
    const first = makeItem('first', 100);
    const result = applyLibraryLocalItemChanges(makeData([first], true), {
      items: [{ ...first, availability: LibraryAvailability.PermissionDenied }], unavailableItemIds: [],
    }, allQuery);
    expect(result.requiresAuthoritativeRefresh).toBe(false);
    expect(result.data.counts).toEqual({ total: 1, available: 0, missing: 0 });
    expect(result.data.nextCursor).toBe('cursor');
  });

  test('excludes missing and unowned records but retains permission-denied records', () => {
    expect(matchesLibraryLocalQuery(makeItem('missing', 1, {
      availability: LibraryAvailability.Missing,
    }), allQuery)).toBe(false);
    expect(matchesLibraryLocalQuery(makeItem('unowned', 1, { relatedSessionCount: 0 }), allQuery)).toBe(false);
    expect(matchesLibraryLocalQuery(makeItem('denied', 1, {
      availability: LibraryAvailability.PermissionDenied,
    }), allQuery)).toBe(true);
  });

  test('uses the same category, favorite, filename, and extension filters as the list', () => {
    const favoriteSheet = makeItem('budget', 1, {
      title: '年度预算.XLSX',
      category: LibraryCategory.Spreadsheet,
      extension: '.xlsx',
      isFavorite: true,
    });

    expect(matchesLibraryLocalQuery(favoriteSheet, {
      category: LibraryCategory.Spreadsheet,
      keyword: '预算',
      favoritesOnly: true,
    })).toBe(true);
    expect(matchesLibraryLocalQuery(favoriteSheet, {
      category: LibraryCategory.All,
      keyword: '.XLSX',
      favoritesOnly: false,
    })).toBe(true);
    expect(matchesLibraryLocalQuery(favoriteSheet, {
      category: LibraryCategory.Document,
      keyword: '',
      favoritesOnly: false,
    })).toBe(false);
  });

  test('matches SQLite ASCII-only NOCASE behavior for Unicode filenames', () => {
    expect(matchesLibraryLocalQuery(makeItem('unicode', 1, { title: 'ÄPFEL.pdf' }), {
      ...allQuery, keyword: 'äpfel',
    })).toBe(false);
    expect(matchesLibraryLocalQuery(makeItem('unicode', 1, { title: 'ÄPFEL.pdf' }), {
      ...allQuery, keyword: 'Äpfel',
    })).toBe(true);
  });

  test('never returns resolved content to the initial skeleton', () => {
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Initial, false)).toBe(true);
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Initial, true)).toBe(false);
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Revalidating, true)).toBe(false);
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Refreshing, true)).toBe(false);
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Appending, true)).toBe(false);
  });

  test('revalidates an existing snapshot without returning to the initial loading state', () => {
    expect(getLibraryQueryLoadIntent(false)).toBe(LibraryLoadIntent.Initial);
    expect(getLibraryQueryLoadIntent(true)).toBe(LibraryLoadIntent.Revalidate);
    expect(isLibraryRefreshPhase(LibraryLoadPhase.Revalidating)).toBe(true);
    expect(isLibraryRefreshPhase(LibraryLoadPhase.Refreshing)).toBe(true);
    expect(isLibraryRefreshPhase(LibraryLoadPhase.Initial)).toBe(false);
  });

  test('treats cold loading, revalidation, refresh, and append as busy work', () => {
    expect(isLibraryBusyPhase(LibraryLoadPhase.Initial)).toBe(true);
    expect(isLibraryBusyPhase(LibraryLoadPhase.Revalidating)).toBe(true);
    expect(isLibraryBusyPhase(LibraryLoadPhase.Refreshing)).toBe(true);
    expect(isLibraryBusyPhase(LibraryLoadPhase.Appending)).toBe(true);
    expect(isLibraryBusyPhase(LibraryLoadPhase.Settled)).toBe(false);
  });
});
