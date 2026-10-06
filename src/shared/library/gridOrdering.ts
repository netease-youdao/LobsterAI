import {
  LibraryCategory,
  LibraryGridCursorKind,
  LibraryGridProtocol,
  LibraryLimits,
  LibraryLocalSort,
} from './constants';
import { isLibraryIdentifier, isLibraryTimestamp } from './localOrdering';
import type { LibraryLocalTaskFilters } from './types';

interface LibraryGridCursorBase {
  version: typeof LibraryGridProtocol.Version;
  sort: typeof LibraryLocalSort.RecentTask;
  queryKey: string;
  sessionId: string;
}

export interface LibraryGridTaskCursor extends LibraryGridCursorBase {
  kind: 'task_groups';
  sessionUpdatedAt: number;
  sessionCreatedAt: number;
}

export interface LibraryGridItemCursor extends LibraryGridCursorBase {
  kind: 'task_items';
  artifactSortTime: number;
  itemId: string;
}

export const getLibraryGridQueryKey = (filters: LibraryLocalTaskFilters): string => JSON.stringify([
  filters.category ?? LibraryCategory.All,
  filters.keyword?.trim().slice(0, LibraryLimits.MaxKeywordLength) ?? '',
  filters.favoritesOnly === true,
]);

const isGridCursorBase = (value: unknown): value is LibraryGridCursorBase => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as LibraryGridCursorBase;
  return cursor.version === LibraryGridProtocol.Version
    && cursor.sort === LibraryLocalSort.RecentTask
    && typeof cursor.queryKey === 'string'
    && cursor.queryKey.length <= LibraryLimits.MaxLocalCursorLength
    && isLibraryIdentifier(cursor.sessionId);
};

export const isLibraryGridTaskCursor = (value: unknown): value is LibraryGridTaskCursor => {
  if (!isGridCursorBase(value)) return false;
  const cursor = value as LibraryGridTaskCursor;
  return cursor.kind === LibraryGridCursorKind.TaskGroups
    && isLibraryTimestamp(cursor.sessionUpdatedAt)
    && isLibraryTimestamp(cursor.sessionCreatedAt);
};

export const isLibraryGridItemCursor = (value: unknown): value is LibraryGridItemCursor => {
  if (!isGridCursorBase(value)) return false;
  const cursor = value as LibraryGridItemCursor;
  return cursor.kind === LibraryGridCursorKind.TaskItems
    && isLibraryTimestamp(cursor.artifactSortTime)
    && isLibraryIdentifier(cursor.itemId);
};
