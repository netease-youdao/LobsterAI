import { HtmlShareStatus } from '../../../shared/htmlShare/constants';
import {
  LibraryItemKind,
  LibrarySharedStatusFilter,
  type LibrarySharedStatusFilter as LibrarySharedStatusFilterValue,
} from '../../../shared/library/constants';
import type {
  LibraryCloudItem,
  LibraryCloudListData,
  LibraryItem,
  LibraryLocalListData,
  LibrarySharedStatusCounts,
  SharedFileItem,
} from '../../../shared/library/types';

const isSameLibraryItem = (
  left: Pick<LibraryItem, 'itemId' | 'itemKind'>,
  right: Pick<LibraryItem, 'itemId' | 'itemKind'>,
): boolean => left.itemId === right.itemId && left.itemKind === right.itemKind;

export const applyLibraryFavoriteState = <T extends LibraryItem>(
  items: T[],
  target: T,
  favorite: boolean,
  favoritesOnly: boolean,
): T[] => items.flatMap(item => {
  if (!isSameLibraryItem(item, target)) return [item];
  if (favoritesOnly && !favorite) return [];
  return [{ ...item, isFavorite: favorite } as T];
});

export const restoreLibraryFavoriteState = <T extends LibraryItem>(
  items: T[],
  target: T,
): T[] => {
  let found = false;
  const restored = items.map(item => {
    if (!isSameLibraryItem(item, target)) return item;
    found = true;
    return { ...item, isFavorite: target.isFavorite } as T;
  });
  return found ? restored : [...restored, target];
};

type CloudStatusCountData = Pick<LibraryCloudListData, 'counts'> & {
  sharedStatusCounts?: Partial<LibrarySharedStatusCounts>;
};

export const getLibrarySharedStatusCount = (
  data: CloudStatusCountData,
  status: LibrarySharedStatusFilterValue,
): number | undefined => {
  const count = data.sharedStatusCounts?.[status];
  if (typeof count === 'number' && Number.isFinite(count)) return count;

  // Older main-process builds do not return status facets. Keep the page
  // usable during renderer HMR and only show the source total we can trust.
  return status === LibrarySharedStatusFilter.All
    && Number.isFinite(data.counts.sharedFile)
    ? data.counts.sharedFile
    : undefined;
};

export const matchesLibrarySharedStatus = (
  item: Pick<SharedFileItem, 'status'>,
  status: LibrarySharedStatusFilterValue,
): boolean => (
  status === LibrarySharedStatusFilter.All || item.status === status
);

export const hideLibraryLocalItems = (
  data: LibraryLocalListData,
): LibraryLocalListData => ({
  ...data,
  list: [],
  hasMore: false,
  nextCursor: undefined,
  counts: data.counts,
});

export const hideLibraryCloudItems = (
  data: LibraryCloudListData,
): LibraryCloudListData => ({
  list: [],
  hasMore: false,
  counts: data.counts,
  sharedStatusCounts: data.sharedStatusCounts,
  ...(data.serverNow === undefined ? {} : { serverNow: data.serverNow }),
});

export const removeLibraryCloudItem = (
  data: LibraryCloudListData,
  target: LibraryCloudItem,
): LibraryCloudListData => {
  const containsTarget = data.list.some(item => isSameLibraryItem(item, target));
  if (!containsTarget) return data;

  if (target.itemKind === LibraryItemKind.DeployedSite) {
    return {
      ...data,
      list: data.list.filter(item => !isSameLibraryItem(item, target)),
      counts: {
        ...data.counts,
        deployedSite: Math.max(0, data.counts.deployedSite - 1),
      },
    };
  }

  const statusCountKey = target.status === HtmlShareStatus.Live
    ? 'live'
    : target.status === HtmlShareStatus.Disabled
      ? 'disabled'
      : undefined;
  return {
    ...data,
    list: data.list.filter(item => !isSameLibraryItem(item, target)),
    counts: {
      ...data.counts,
      sharedFile: Math.max(0, data.counts.sharedFile - 1),
    },
    sharedStatusCounts: {
      ...data.sharedStatusCounts,
      all: Math.max(0, data.sharedStatusCounts.all - 1),
      ...(statusCountKey
        ? { [statusCountKey]: Math.max(0, data.sharedStatusCounts[statusCountKey] - 1) }
        : {}),
    },
  };
};
