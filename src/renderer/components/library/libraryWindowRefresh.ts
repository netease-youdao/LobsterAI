import {
  LibraryAvailability,
  LibraryErrorCode,
  LibraryItemKind,
  LibraryLimits,
  LibraryLocalProtocol,
  LibraryLocalSort,
} from '../../../shared/library/constants';
import {
  compareLibraryLocalItems,
  compareLibraryLocalOrderKeys,
  getLibraryLocalOrderKey,
  isLibraryIdentifier,
  isLibraryLocalOrderKey,
  isLibraryTimestamp,
} from '../../../shared/library/localOrdering';
import type {
  LibraryLocalListData,
  LibraryLocalListOptions,
  LibraryResult,
  LibrarySessionRef,
  LocalArtifactItem,
} from '../../../shared/library/types';
import type { LibraryLocalQuery } from './libraryLocalQueryState';

export const LibraryWindowRefreshLimits = {
  AnchorExtraItemLimit: 200,
  AnchorExtraRequestLimit: 2,
  AutomaticReadBudgetMs: 2_000,
  AnchorCandidateLimit: 8,
  AnchorCorrectionLimit: 2,
  TopThresholdPx: 24,
} as const;

export const LibraryWindowRefreshStatus = {
  Success: 'success',
  Invalidated: 'invalidated',
  BudgetExceeded: 'budget_exceeded',
  Failure: 'failure',
} as const;

type ValidationFailure = {
  status: typeof LibraryWindowRefreshStatus.Failure;
  code: LibraryErrorCode;
  error: string;
};

type Invalidated = {
  status: typeof LibraryWindowRefreshStatus.Invalidated;
  code?: LibraryErrorCode;
};

export type LibraryLocalValidationResult =
  | { status: typeof LibraryWindowRefreshStatus.Success }
  | ValidationFailure
  | Invalidated;

export type LibraryWindowRefreshResult =
  | {
    status: typeof LibraryWindowRefreshStatus.Success;
    data: LibraryLocalListData;
    anchorKey?: string;
    anchorDegraded: boolean;
  }
  | ValidationFailure
  | Invalidated
  | { status: typeof LibraryWindowRefreshStatus.BudgetExceeded };

interface LibraryLocalPageValidationOptions {
  pageSize?: number;
  requestCursor?: string;
}

interface LibraryWindowRefreshOptions {
  readPage: (options: LibraryLocalListOptions) => Promise<LibraryResult<LibraryLocalListData>>;
  query: LibraryLocalQuery;
  browseDepth: number;
  getAnchorKeys: () => string[];
  isCurrent: () => boolean;
  getDataEpoch: () => number;
  now?: () => number;
}

const success = (): LibraryLocalValidationResult => ({ status: LibraryWindowRefreshStatus.Success });
const invalidated = (): Invalidated => ({ status: LibraryWindowRefreshStatus.Invalidated });
const invalidData = (error: string): ValidationFailure => ({
  status: LibraryWindowRefreshStatus.Failure,
  code: LibraryErrorCode.InvalidLocalData,
  error,
});
const protocolMismatch = (): ValidationFailure => ({
  status: LibraryWindowRefreshStatus.Failure,
  code: LibraryErrorCode.ProtocolMismatch,
  error: 'The local library protocol is not supported.',
});
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);
const sameProjection = (left: LibrarySessionRef, right: LibrarySessionRef): boolean => (
  left.createdAt === right.createdAt && left.updatedAt === right.updatedAt
  && left.title === right.title && left.agentId === right.agentId
);

const cursorMatchesTail = (cursor: string, tail: LocalArtifactItem): boolean => {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return false;
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, character => character.charCodeAt(0)),
    );
    const value: unknown = JSON.parse(json);
    return isRecord(value) && value.version === LibraryLocalProtocol.Version
      && value.sort === LibraryLocalSort.RecentTask && isLibraryLocalOrderKey(value)
      && compareLibraryLocalOrderKeys(value, getLibraryLocalOrderKey(tail)) === 0;
  } catch {
    return false;
  }
};

export const getLibraryLocalItemKey = (item: LocalArtifactItem): string => (
  `${item.itemKind}:${item.itemId}`
);

/** Validates an individual response without hiding broken or legacy records. */
export const validateLibraryLocalPage = (
  input: unknown,
  options: LibraryLocalPageValidationOptions = {},
): LibraryLocalValidationResult => {
  if (!isRecord(input)
    || input.protocolVersion !== LibraryLocalProtocol.Version
    || input.sort !== LibraryLocalSort.RecentTask) return protocolMismatch();
  if (!Array.isArray(input.list) || !isRecord(input.counts) || typeof input.hasMore !== 'boolean') {
    return invalidData('Invalid local library page.');
  }
  const { total, available, missing } = input.counts;
  if (![total, available, missing].every(value => Number.isSafeInteger(value) && Number(value) >= 0)
    || Number(available) > Number(total) || input.list.length > Number(total)
    || input.list.length > (options.pageSize ?? LibraryLimits.MaxPageSize)) {
    return invalidData('Invalid local library counts or page size.');
  }
  if (input.hasMore && (input.list.length === 0
    || typeof input.nextCursor !== 'string' || input.nextCursor.length === 0
    || input.nextCursor.length > LibraryLimits.MaxLocalCursorLength
    || input.nextCursor === options.requestCursor)) {
    return invalidData('The local library cursor did not advance.');
  }
  if (!input.hasMore && input.nextCursor !== undefined) {
    return invalidData('An exhausted local library page has a cursor.');
  }
  if (input.hasMore && options.pageSize !== undefined && input.list.length !== options.pageSize) {
    return invalidData('A non-final local library page is incomplete.');
  }
  const ids = new Set<string>();
  const sessions = new Map<string, LibrarySessionRef>();
  let previous: LocalArtifactItem | undefined;
  for (const value of input.list) {
    if (!isRecord(value) || !isRecord(value.latestSession)
      || value.latestSession.createdAt === undefined || value.latestSession.updatedAt === undefined) {
      return protocolMismatch();
    }
    if (value.itemKind !== LibraryItemKind.LocalArtifact || !isLibraryIdentifier(value.itemId)
      || !isLibraryIdentifier(value.latestSession.sessionId)
      || !isLibraryTimestamp(value.sortTime)
      || !isLibraryTimestamp(value.latestSession.createdAt)
      || !isLibraryTimestamp(value.latestSession.updatedAt)
      || typeof value.latestSession.title !== 'string' || typeof value.latestSession.agentId !== 'string'
      || value.availability === LibraryAvailability.Missing
      || !Number.isSafeInteger(value.relatedSessionCount) || Number(value.relatedSessionCount) < 1) {
      return invalidData('Invalid local library item or task projection.');
    }
    const item = value as unknown as LocalArtifactItem;
    if (ids.has(item.itemId) || (previous && compareLibraryLocalItems(previous, item) >= 0)) {
      return invalidData('Local library page order is not strictly decreasing.');
    }
    const session = sessions.get(item.latestSession.sessionId);
    if (session && !sameProjection(session, item.latestSession)) {
      return invalidData('A local library page has inconsistent task projections.');
    }
    ids.add(item.itemId);
    sessions.set(item.latestSession.sessionId, item.latestSession);
    previous = item;
  }
  if (input.hasMore && previous && !cursorMatchesTail(String(input.nextCursor), previous)) {
    return invalidData('The local library cursor does not identify the page tail.');
  }
  if (!options.requestCursor && (
    input.hasMore ? input.list.length >= Number(total) : input.list.length !== total
  )) return invalidData('Local library first-page counts do not match its boundary.');
  return success();
};

/** Cross-response drift is retryable; it is not silently deduplicated. */
export const validateLibraryLocalAppend = (
  current: LibraryLocalListData,
  page: LibraryLocalListData,
  options: LibraryLocalPageValidationOptions = {},
): LibraryLocalValidationResult => {
  const pageValidation = validateLibraryLocalPage(page, {
    ...options,
    requestCursor: options.requestCursor ?? current.nextCursor,
  });
  if (pageValidation.status !== LibraryWindowRefreshStatus.Success) return pageValidation;
  if (current.counts.total !== page.counts.total || current.counts.available !== page.counts.available
    || current.counts.missing !== page.counts.missing) return invalidated();
  const previousTail = current.list[current.list.length - 1];
  const nextHead = page.list[0];
  if (previousTail && nextHead && compareLibraryLocalItems(previousTail, nextHead) >= 0) {
    return invalidated();
  }
  const ids = new Set(current.list.map(item => item.itemId));
  const sessions = new Map(current.list.map(item => [item.latestSession.sessionId, item.latestSession]));
  for (const item of page.list) {
    const session = sessions.get(item.latestSession.sessionId);
    if (ids.has(item.itemId) || (session && !sameProjection(session, item.latestSession))) {
      return invalidated();
    }
  }
  const length = current.list.length + page.list.length;
  if (page.hasMore ? length >= page.counts.total : length !== page.counts.total) return invalidated();
  return success();
};

/**
 * Builds a single continuous prefix. The coordinator, not this reader, owns
 * the one-immediate-retry allowance shared by cursor errors and data drift.
 */
export const readLibraryLocalWindow = async (
  options: LibraryWindowRefreshOptions,
): Promise<LibraryWindowRefreshResult> => {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const epoch = options.getDataEpoch();
  const isCurrent = (): boolean => options.isCurrent() && epoch === options.getDataEpoch();
  const overBudget = (): boolean => now() - startedAt >= LibraryWindowRefreshLimits.AutomaticReadBudgetMs;
  const baseline = Number.isFinite(options.browseDepth)
    ? Math.max(LibraryLimits.DefaultPageSize, Math.floor(options.browseDepth))
    : LibraryLimits.DefaultPageSize;
  let data: LibraryLocalListData | undefined;
  let extraRequests = 0;
  let extraItems = 0;
  const getAnchorKeys = (): string[] => options.getAnchorKeys().slice(0, LibraryWindowRefreshLimits.AnchorCandidateLimit);
  const findAnchor = (keys: string[]): string | undefined => {
    const present = new Set(data?.list.map(getLibraryLocalItemKey));
    return keys.find(key => present.has(key));
  };
  while (true) {
    if (!isCurrent()) return invalidated();
    const baseComplete = data !== undefined && (data.list.length >= baseline || !data.hasMore);
    const keys = getAnchorKeys();
    if (baseComplete) {
      if (!data?.hasMore || keys.length === 0 || findAnchor(keys) === keys[0]
        || overBudget() || extraRequests >= LibraryWindowRefreshLimits.AnchorExtraRequestLimit
        || extraItems >= LibraryWindowRefreshLimits.AnchorExtraItemLimit) break;
    } else if (overBudget()) {
      return { status: LibraryWindowRefreshStatus.BudgetExceeded };
    }
    const pageSize = Math.min(LibraryLimits.MaxPageSize, baseComplete
      ? LibraryWindowRefreshLimits.AnchorExtraItemLimit - extraItems
      : baseline - (data?.list.length ?? 0));
    const cursor = data?.nextCursor;
    let response: LibraryResult<LibraryLocalListData>;
    try {
      response = await options.readPage({
        ...options.query,
        pageSize,
        ...(cursor ? { cursor, sort: LibraryLocalSort.RecentTask } : {}),
      });
    } catch (error) {
      if (!isCurrent()) return invalidated();
      return {
        status: LibraryWindowRefreshStatus.Failure,
        code: LibraryErrorCode.Internal,
        error: error instanceof Error ? error.message : 'Local library request failed.',
      };
    }
    if (!isCurrent()) return invalidated();
    if (!response.success) {
      if (response.code === LibraryErrorCode.InvalidCursor) {
        return { status: LibraryWindowRefreshStatus.Invalidated, code: response.code };
      }
      return { status: LibraryWindowRefreshStatus.Failure, code: response.code, error: response.error };
    }
    const validation = data
      ? validateLibraryLocalAppend(data, response.data, { pageSize, requestCursor: cursor })
      : validateLibraryLocalPage(response.data, { pageSize });
    if (validation.status !== LibraryWindowRefreshStatus.Success) return validation;
    if (baseComplete) {
      extraRequests += 1;
      extraItems += response.data.list.length;
    }
    data = {
      ...response.data,
      list: [...(data?.list ?? []), ...response.data.list],
    };
    if (overBudget() && data.hasMore && data.list.length < baseline) {
      return { status: LibraryWindowRefreshStatus.BudgetExceeded };
    }
  }
  if (!isCurrent()) return invalidated();
  if (!data) return invalidData('Local library refresh produced no page.');
  const anchorKeys = getAnchorKeys();
  const anchorKey = findAnchor(anchorKeys);
  return {
    status: LibraryWindowRefreshStatus.Success,
    data,
    ...(anchorKey ? { anchorKey } : {}),
    anchorDegraded: data.list.length > 0 && anchorKeys.length > 0 && !anchorKey,
  };
};
