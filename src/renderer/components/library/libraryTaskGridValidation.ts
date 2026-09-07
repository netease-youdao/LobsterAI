import {
  LibraryAvailability,
  LibraryErrorCode,
  LibraryGridLimits,
  LibraryGridProtocol,
  LibraryItemKind,
  LibraryLimits,
  LibraryLocalSort,
} from '../../../shared/library/constants';
import {
  getLibraryGridQueryKey,
  isLibraryGridItemCursor,
  isLibraryGridTaskCursor,
} from '../../../shared/library/gridOrdering';
import {
  compareLibraryBinaryStrings,
  compareLibraryLocalItems,
  isLibraryIdentifier,
  isLibraryTimestamp,
  LibraryLocalDataError,
} from '../../../shared/library/localOrdering';
import type {
  LibraryLocalTaskGroup,
  LibraryLocalTaskGroupsData,
  LibraryLocalTaskGroupsOptions,
  LibraryLocalTaskItemsData,
  LibraryLocalTaskItemsOptions,
  LibrarySessionRef,
  LocalArtifactItem,
} from '../../../shared/library/types';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const invalid = (message: string): never => {
  throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, message);
};
export const libraryGridDrift = (): never => {
  throw new LibraryLocalDataError(LibraryErrorCode.InvalidCursor, 'The task grid changed during the request.');
};
const validateProtocol = (value: unknown): void => {
  if (!isRecord(value) || value.protocolVersion !== LibraryGridProtocol.Version
    || value.sort !== LibraryLocalSort.RecentTask) {
    throw new LibraryLocalDataError(LibraryErrorCode.ProtocolMismatch, 'The task grid protocol is not supported.');
  }
};
const decodeCursor = (value: unknown): unknown => {
  if (typeof value !== 'string' || value.length > LibraryLimits.MaxLocalCursorLength
    || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, character => character.charCodeAt(0)),
    ));
  } catch {
    return undefined;
  }
};

export const sameLibraryGridSession = (left: LibrarySessionRef, right: LibrarySessionRef): boolean => (
  left.sessionId === right.sessionId && left.createdAt === right.createdAt
  && left.updatedAt === right.updatedAt && left.title === right.title && left.agentId === right.agentId
);

export const compareLibraryGridSessions = (left: LibrarySessionRef, right: LibrarySessionRef): number => (
  (left.updatedAt > right.updatedAt ? -1 : left.updatedAt < right.updatedAt ? 1 : 0)
  || (left.createdAt > right.createdAt ? -1 : left.createdAt < right.createdAt ? 1 : 0)
  || compareLibraryBinaryStrings(right.sessionId, left.sessionId)
);

const validateSession = (value: unknown): LibrarySessionRef => {
  if (!isRecord(value) || !isLibraryIdentifier(value.sessionId)
    || !isLibraryTimestamp(value.createdAt) || !isLibraryTimestamp(value.updatedAt)
    || !isLibraryTimestamp(value.lastRelatedAt)
    || typeof value.title !== 'string' || typeof value.agentId !== 'string') {
    return invalid('Invalid task grid session projection.');
  }
  return value as unknown as LibrarySessionRef;
};

const validateItems = (values: unknown, session: LibrarySessionRef): LocalArtifactItem[] => {
  if (!Array.isArray(values)) return invalid('Invalid task grid items.');
  const ids = new Set<string>();
  let previous: LocalArtifactItem | undefined;
  for (const value of values) {
    if (!isRecord(value) || value.itemKind !== LibraryItemKind.LocalArtifact
      || !isLibraryIdentifier(value.itemId) || !isLibraryTimestamp(value.sortTime)
      || !isLibraryTimestamp(value.createdAt)
      || (value.availability !== LibraryAvailability.Available
        && value.availability !== LibraryAvailability.PermissionDenied)
      || !isCount(value.relatedSessionCount) || value.relatedSessionCount < 1
      || typeof value.filePath !== 'string' || typeof value.isFavorite !== 'boolean') {
      return invalid('Invalid task grid artifact.');
    }
    const itemSession = validateSession(value.latestSession);
    if (!sameLibraryGridSession(session, itemSession)) return invalid('A task grid item has the wrong owner.');
    const item = value as unknown as LocalArtifactItem;
    if (ids.has(item.itemId) || (previous && compareLibraryLocalItems(previous, item) >= 0)) {
      return invalid('Task grid items are not strictly ordered.');
    }
    ids.add(item.itemId);
    previous = item;
  }
  return values as LocalArtifactItem[];
};

/** Grid previews intentionally have gaps; the file-list v2 validator must not be used here. */
export const validateLibraryTaskGroups = (
  value: unknown,
  options: LibraryLocalTaskGroupsOptions,
): LibraryLocalTaskGroupsData => {
  validateProtocol(value);
  if (!isRecord(value) || !Array.isArray(value.groups) || !isRecord(value.counts)
    || typeof value.hasMoreTasks !== 'boolean') return invalid('Invalid task grid page.');
  const { total, available, missing } = value.counts;
  const pageSize = Math.max(1, Math.min(LibraryGridLimits.MaxTaskPageSize,
    Math.floor(options.taskPageSize ?? LibraryGridLimits.DefaultTaskPageSize)));
  if (![total, available, missing].every(isCount) || Number(available) > Number(total)
    || value.groups.length > pageSize) {
    return invalid('Invalid task grid counts.');
  }
  const ids = new Set<string>();
  const itemIds = new Set<string>();
  let previous: LibrarySessionRef | undefined;
  let fileCount = 0;
  for (const group of value.groups) {
    if (!isRecord(group) || !isCount(group.matchedFileCount) || group.matchedFileCount === 0) {
      return invalid('An empty task must not be included in the grid.');
    }
    const session = validateSession(group.session);
    const items = validateItems(group.previewItems, session);
    if (items.length !== Math.min(LibraryGridLimits.PreviewCount, group.matchedFileCount)
      || ids.has(session.sessionId) || (previous && compareLibraryGridSessions(previous, session) >= 0)) {
      return invalid('Invalid task grid preview or task ordering.');
    }
    for (const item of items) {
      if (itemIds.has(item.itemId)) return invalid('An artifact appears under multiple task owners.');
      itemIds.add(item.itemId);
    }
    ids.add(session.sessionId);
    previous = session;
    fileCount += group.matchedFileCount;
  }
  if (fileCount > Number(total) || (!options.taskCursor && !value.hasMoreTasks && fileCount !== total)
    || (value.hasMoreTasks && fileCount >= Number(total))) return invalid('Task grid file totals do not match.');
  if (value.hasMoreTasks) {
    const cursor = decodeCursor(value.nextTaskCursor);
    if (!previous || !isLibraryGridTaskCursor(cursor)
      || cursor.queryKey !== getLibraryGridQueryKey(options)
      || cursor.sessionId !== previous.sessionId || cursor.sessionUpdatedAt !== previous.updatedAt
      || cursor.sessionCreatedAt !== previous.createdAt || value.nextTaskCursor === options.taskCursor
      || value.groups.length !== pageSize) {
      return invalid('Invalid task grid page cursor.');
    }
  } else if (value.nextTaskCursor !== undefined) return invalid('An exhausted task page has a cursor.');
  return value as unknown as LibraryLocalTaskGroupsData;
};

export const appendLibraryTaskGroups = (
  current: LibraryLocalTaskGroupsData,
  next: LibraryLocalTaskGroupsData,
): LibraryLocalTaskGroupsData => {
  if (current.counts.total !== next.counts.total || current.counts.available !== next.counts.available
    || current.counts.missing !== next.counts.missing) return libraryGridDrift();
  const last = current.groups[current.groups.length - 1];
  const first = next.groups[0];
  if (last && first && compareLibraryGridSessions(last.session, first.session) >= 0) return libraryGridDrift();
  const ids = new Set(current.groups.map(group => group.session.sessionId));
  const itemIds = new Set(current.groups.flatMap(group => group.previewItems.map(item => item.itemId)));
  if (next.groups.some(group => ids.has(group.session.sessionId)
    || group.previewItems.some(item => itemIds.has(item.itemId)))) return libraryGridDrift();
  const groups = [...current.groups, ...next.groups];
  const total = groups.reduce((sum, group) => sum + group.matchedFileCount, 0);
  if (next.hasMoreTasks ? total >= next.counts.total : total !== next.counts.total) return libraryGridDrift();
  return { ...next, groups };
};

export const validateLibraryTaskItems = (
  value: unknown,
  options: LibraryLocalTaskItemsOptions,
): LibraryLocalTaskItemsData => {
  validateProtocol(value);
  if (!isRecord(value) || !isCount(value.matchedFileCount) || typeof value.hasMoreItems !== 'boolean') {
    return invalid('Invalid task item page.');
  }
  const session = validateSession(value.session);
  const items = validateItems(value.items, session);
  const pageSize = Math.max(1, Math.min(LibraryGridLimits.MaxItemPageSize,
    Math.floor(options.pageSize ?? LibraryGridLimits.ItemPageSize)));
  if (session.sessionId !== options.sessionId || items.length > value.matchedFileCount
    || items.length > pageSize) {
    return invalid('Invalid task item page count or owner.');
  }
  if (!options.itemCursor && (value.hasMoreItems
    ? items.length >= value.matchedFileCount : items.length !== value.matchedFileCount)) {
    return invalid('Task item first-page count does not match its boundary.');
  }
  if (value.hasMoreItems) {
    const cursor = decodeCursor(value.nextItemCursor);
    const tail = items[items.length - 1];
    if (!tail || !isLibraryGridItemCursor(cursor) || cursor.queryKey !== getLibraryGridQueryKey(options)
      || cursor.sessionId !== options.sessionId || cursor.artifactSortTime !== tail.sortTime
      || cursor.itemId !== tail.itemId || value.nextItemCursor === options.itemCursor
      || items.length !== pageSize) {
      return invalid('Invalid task item cursor.');
    }
  } else if (value.nextItemCursor !== undefined) return invalid('An exhausted task item page has a cursor.');
  return value as unknown as LibraryLocalTaskItemsData;
};

export const appendLibraryTaskItems = (
  current: LibraryLocalTaskItemsData,
  next: LibraryLocalTaskItemsData,
): LibraryLocalTaskItemsData => {
  if (current.matchedFileCount !== next.matchedFileCount
    || !sameLibraryGridSession(current.session, next.session)) return libraryGridDrift();
  const last = current.items[current.items.length - 1];
  const first = next.items[0];
  const ids = new Set(current.items.map(item => item.itemId));
  if ((last && first && compareLibraryLocalItems(last, first) >= 0)
    || next.items.some(item => ids.has(item.itemId))) return libraryGridDrift();
  const items = [...current.items, ...next.items];
  if (next.hasMoreItems ? items.length >= next.matchedFileCount : items.length !== next.matchedFileCount) {
    return libraryGridDrift();
  }
  return { ...next, items };
};

/** A fresh expanded prefix and its summary are committed as one coherent candidate. */
export const validateLibraryTaskExpansion = (
  group: LibraryLocalTaskGroup,
  data: LibraryLocalTaskItemsData,
): void => {
  if (!sameLibraryGridSession(group.session, data.session) || group.matchedFileCount !== data.matchedFileCount
    || JSON.stringify(group.previewItems) !== JSON.stringify(data.items.slice(0, LibraryGridLimits.PreviewCount))) {
    libraryGridDrift();
  }
};
