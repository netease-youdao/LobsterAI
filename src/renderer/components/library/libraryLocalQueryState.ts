import {
  LibraryAvailability,
  LibraryCategory,
} from '../../../shared/library/constants';
import { compareLibraryLocalItems } from '../../../shared/library/localOrdering';
import type {
  LibraryLocalListData,
  LocalArtifactItem,
} from '../../../shared/library/types';

export const LibraryLoadPhase = {
  Initial: 'initial',
  Settled: 'settled',
  Revalidating: 'revalidating',
  Refreshing: 'refreshing',
  Appending: 'appending',
} as const;
export type LibraryLoadPhase = typeof LibraryLoadPhase[keyof typeof LibraryLoadPhase];

export const LibraryLoadIntent = {
  Initial: 'initial',
  Revalidate: 'revalidate',
  Refresh: 'refresh',
  Append: 'append',
} as const;
export type LibraryLoadIntent = typeof LibraryLoadIntent[keyof typeof LibraryLoadIntent];

export const getLibraryQueryLoadIntent = (
  hasResolvedSnapshot: boolean,
): LibraryLoadIntent => (
  hasResolvedSnapshot ? LibraryLoadIntent.Revalidate : LibraryLoadIntent.Initial
);

export const isLibraryRefreshPhase = (phase: LibraryLoadPhase): boolean => (
  phase === LibraryLoadPhase.Revalidating || phase === LibraryLoadPhase.Refreshing
);

export const isLibraryBusyPhase = (phase: LibraryLoadPhase): boolean => (
  phase !== LibraryLoadPhase.Settled
);

export interface LibraryLocalQuery {
  category: LibraryCategory;
  keyword: string;
  favoritesOnly: boolean;
}

export interface LibraryLocalItemChanges {
  items: LocalArtifactItem[];
  unavailableItemIds: string[];
}

export interface LibraryLocalItemChangeResult {
  data: LibraryLocalListData;
  requiresAuthoritativeRefresh: boolean;
}

export { compareLibraryLocalItems } from '../../../shared/library/localOrdering';

export interface LibraryLocalItemChangeContext {
  dirty?: boolean;
  inFlight?: boolean;
}

// SQLite's built-in NOCASE folds ASCII only, not locale-dependent Unicode case.
const normalizeSearchText = (value: string): string => (
  value.replace(/[A-Z]/g, character => character.toLowerCase())
);

export const matchesLibraryLocalQuery = (
  item: LocalArtifactItem,
  query: LibraryLocalQuery,
): boolean => {
  if (item.availability === LibraryAvailability.Missing || item.relatedSessionCount < 1) return false;
  if (query.category !== LibraryCategory.All && item.category !== query.category) return false;
  if (query.favoritesOnly && !item.isFavorite) return false;
  const keyword = normalizeSearchText(query.keyword.trim());
  if (!keyword) return true;
  return normalizeSearchText(item.title).includes(keyword)
    || normalizeSearchText(item.extension).includes(keyword);
};

export const applyLibraryLocalItemChanges = (
  current: LibraryLocalListData,
  changes: LibraryLocalItemChanges,
  query: LibraryLocalQuery,
  context: LibraryLocalItemChangeContext = {},
): LibraryLocalItemChangeResult => {
  const refresh = (): LibraryLocalItemChangeResult => ({
    data: current,
    requiresAuthoritativeRefresh: true,
  });
  if (context.dirty || context.inFlight) return refresh();
  // getLocalItems cannot distinguish a deleted relation from a newly missing
  // file. Re-read counts as well as membership instead of guessing missing.
  if (changes.unavailableItemIds.length > 0) return refresh();

  const nextById = new Map(current.list.map(item => [item.itemId, item]));
  const currentTail = current.list[current.list.length - 1];

  for (const item of changes.items) {
    const previous = nextById.get(item.itemId);
    if (!matchesLibraryLocalQuery(item, query)) {
      if (previous) return refresh();
      continue;
    }
    if (!previous) {
      if (!current.hasMore || !currentTail || compareLibraryLocalItems(item, currentTail) <= 0) {
        return refresh();
      }
      continue;
    }
    const oldSession = previous.latestSession;
    const newSession = item.latestSession;
    if (
      oldSession.sessionId !== newSession.sessionId
      || oldSession.createdAt !== newSession.createdAt
      || oldSession.updatedAt !== newSession.updatedAt
      || oldSession.title !== newSession.title
      || oldSession.agentId !== newSession.agentId
      || (current.hasMore && compareLibraryLocalItems(previous, item) !== 0)
    ) return refresh();
    nextById.set(item.itemId, item);
  }

  const list = [...nextById.values()].sort(compareLibraryLocalItems);
  const countAvailable = (items: LocalArtifactItem[]): number => items.filter(
    item => item.availability === LibraryAvailability.Available,
  ).length;
  return {
    data: {
      ...current,
      list,
      counts: {
        ...current.counts,
        available: current.counts.available + countAvailable(list) - countAvailable(current.list),
      },
    },
    requiresAuthoritativeRefresh: false,
  };
};

export const shouldShowLibraryInitialSkeleton = (
  phase: LibraryLoadPhase,
  hasResolvedSnapshot: boolean,
): boolean => phase === LibraryLoadPhase.Initial && !hasResolvedSnapshot;
