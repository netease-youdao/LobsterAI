import {
  HtmlShareAccessMode,
  HtmlShareDisabledSource,
  HtmlShareSourceType,
  HtmlShareStatus,
} from '../../shared/htmlShare/constants';
import { matchesLibraryCloudAvailability } from '../../shared/library/cloudAvailability';
import {
  isLibraryCategory,
  LibraryCategory,
  LibraryCloudAvailabilityFilter,
  LibraryCloudKind,
  LibraryCloudUnavailableReason,
  LibraryErrorCode,
  LibraryItemKind,
  LibraryLimits,
} from '../../shared/library/constants';
import type {
  DeployedSiteItem,
  LibraryCloudItem,
  LibraryCloudListData,
  LibraryCloudListOptions,
  LibraryResult,
  SharedFileItem,
} from '../../shared/library/types';
import { normalizePublishingSubscriptionRecoveryMode } from '../../shared/publishing/constants';
import { SiteKind, SiteStatus } from '../../shared/site/constants';
import { LibraryLocalStore } from './libraryLocalStore';

type FetchWithAuth = (url: string, options?: RequestInit) => Promise<Response>;

interface LibraryCloudApiItem {
  itemKind?: unknown;
  itemId?: unknown;
  title?: unknown;
  url?: unknown;
  category?: unknown;
  sourceType?: unknown;
  entryFile?: unknown;
  accessMode?: unknown;
  status?: unknown;
  moderationStatus?: unknown;
  disabledSource?: unknown;
  totalFiles?: unknown;
  totalBytes?: unknown;
  siteKind?: unknown;
  siteStatus?: unknown;
  shareStatus?: unknown;
  deploymentId?: unknown;
  deploymentStatus?: unknown;
  sessionId?: unknown;
  artifactId?: unknown;
  clientSourceKey?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  contentUpdatedAt?: unknown;
  accessExpiresAt?: unknown;
  effectiveAvailable?: unknown;
  effectiveExpiresAt?: unknown;
  effectiveUnavailableReason?: unknown;
  subscriptionRecoveryMode?: unknown;
  sortTime?: unknown;
}

interface LibraryCloudApiData {
  list?: LibraryCloudApiItem[];
  nextCursor?: string;
  hasMore?: boolean;
  counts?: {
    sharedFile?: number;
    deployedSite?: number;
  };
  sharedStatusCounts?: {
    all?: number;
    live?: number;
    disabled?: number;
  };
  serverNow?: unknown;
  recoveryPending?: unknown;
}

interface LibraryCloudApiResponse {
  code?: number;
  message?: string;
  data?: LibraryCloudApiData;
}

const readString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const readNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const readBoolean = (value: unknown): boolean | undefined => (
  typeof value === 'boolean' ? value : undefined
);

const readTimestamp = (value: unknown, fallback: number): number => {
  const numeric = readNumber(value);
  if (numeric !== undefined) return numeric;
  const text = readString(value);
  if (!text) return fallback;
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readOptionalTimestamp = (value: unknown): number | undefined => {
  const numeric = readNumber(value);
  if (numeric !== undefined) return numeric;
  const text = readString(value);
  if (!text) return undefined;
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readNullableTimestamp = (value: unknown): number | null | undefined => (
  value === null ? null : readOptionalTimestamp(value)
);

const normalizeCloudItem = (
  input: LibraryCloudApiItem,
  favorites: Set<string>,
  localStore: LibraryLocalStore,
): LibraryCloudItem | null => {
  const itemId = readString(input.itemId);
  const title = readString(input.title);
  const url = readString(input.url);
  const sortTime = readNumber(input.sortTime);
  if (!itemId || !title || !url || sortTime === undefined || !isLibraryCategory(input.category)) {
    return null;
  }
  if (input.category === LibraryCategory.All) return null;
  const sessionId = readString(input.sessionId);
  const clientSourceKey = readString(input.clientSourceKey);
  const latestSession = localStore.resolveCloudSession(sessionId, clientSourceKey);
  const createdAt = readTimestamp(input.createdAt, sortTime);
  const accessExpiresAt = readNullableTimestamp(input.accessExpiresAt);
  const effectiveAvailable = readBoolean(input.effectiveAvailable);
  const effectiveExpiresAt = readNullableTimestamp(input.effectiveExpiresAt);
  const effectiveUnavailableReason = readString(input.effectiveUnavailableReason);
  const normalizedEffectiveUnavailableReason = Object.values(
    LibraryCloudUnavailableReason,
  ).includes(effectiveUnavailableReason as LibraryCloudUnavailableReason)
    ? effectiveUnavailableReason as LibraryCloudUnavailableReason
    : undefined;
  const subscriptionRecoveryMode = normalizePublishingSubscriptionRecoveryMode(
    input.subscriptionRecoveryMode,
  );
  const effectiveAccessFields = {
    ...(effectiveAvailable === undefined ? {} : { effectiveAvailable }),
    ...(effectiveExpiresAt === undefined ? {} : { effectiveExpiresAt }),
    ...(normalizedEffectiveUnavailableReason === undefined
      ? {}
      : { effectiveUnavailableReason: normalizedEffectiveUnavailableReason }),
  };

  if (input.itemKind === LibraryItemKind.SharedFile) {
    const sourceType = readString(input.sourceType);
    const accessMode = readString(input.accessMode);
    const status = readString(input.status);
    if (
      !sourceType
      || !Object.values(HtmlShareSourceType).includes(sourceType as HtmlShareSourceType)
      || !accessMode
      || !Object.values(HtmlShareAccessMode).includes(accessMode as HtmlShareAccessMode)
      || !status
      || !Object.values(HtmlShareStatus).includes(status as HtmlShareStatus)
    ) {
      return null;
    }
    const item: SharedFileItem = {
      itemKind: LibraryItemKind.SharedFile,
      itemId,
      shareId: itemId,
      title,
      url,
      category: input.category,
      sortTime,
      createdAt,
      isFavorite: favorites.has(`${LibraryItemKind.SharedFile}:${itemId}`),
      sourceType: sourceType as HtmlShareSourceType,
      accessMode: accessMode as HtmlShareAccessMode,
      status: status as HtmlShareStatus,
      ...(latestSession ? { latestSession } : {}),
      ...(readString(input.moderationStatus)
        ? { moderationStatus: readString(input.moderationStatus) }
        : {}),
      ...(Object.values(HtmlShareDisabledSource).includes(
        readString(input.disabledSource) as HtmlShareDisabledSource,
      )
        ? { disabledSource: readString(input.disabledSource) as HtmlShareDisabledSource }
        : {}),
      ...(readString(input.entryFile) ? { entryFile: readString(input.entryFile) } : {}),
      ...(readNumber(input.totalFiles) === undefined
        ? {}
        : { totalFiles: readNumber(input.totalFiles) }),
      ...(readNumber(input.totalBytes) === undefined
        ? {}
        : { totalBytes: readNumber(input.totalBytes) }),
      ...(clientSourceKey ? { clientSourceKey } : {}),
      ...(readString(input.artifactId) ? { artifactId: readString(input.artifactId) } : {}),
      ...(readString(input.updatedAt) ? { updatedAt: readString(input.updatedAt) } : {}),
      ...(readString(input.contentUpdatedAt)
        ? { contentUpdatedAt: readString(input.contentUpdatedAt) }
        : {}),
      ...(accessExpiresAt === undefined ? {} : { accessExpiresAt }),
      ...(subscriptionRecoveryMode === undefined ? {} : { subscriptionRecoveryMode }),
      ...effectiveAccessFields,
    };
    return item;
  }

  if (input.itemKind === LibraryItemKind.DeployedSite) {
    const siteKind = readString(input.siteKind);
    const siteStatus = readString(input.siteStatus);
    const shareStatus = readString(input.shareStatus);
    const accessMode = readString(input.accessMode);
    if (
      !siteKind
      || !Object.values(SiteKind).includes(siteKind as SiteKind)
      || !siteStatus
      || !Object.values(SiteStatus).includes(siteStatus as SiteStatus)
      || !shareStatus
      || !Object.values(HtmlShareStatus).includes(shareStatus as HtmlShareStatus)
      || !accessMode
      || !Object.values(HtmlShareAccessMode).includes(accessMode as HtmlShareAccessMode)
    ) {
      return null;
    }
    const item: DeployedSiteItem = {
      itemKind: LibraryItemKind.DeployedSite,
      itemId,
      shareId: itemId,
      title,
      url,
      category: LibraryCategory.Site,
      sortTime,
      createdAt,
      isFavorite: favorites.has(`${LibraryItemKind.DeployedSite}:${itemId}`),
      siteKind: siteKind as SiteKind,
      siteStatus: siteStatus as SiteStatus,
      shareStatus: shareStatus as HtmlShareStatus,
      accessMode: accessMode as HtmlShareAccessMode,
      ...(latestSession ? { latestSession } : {}),
      ...(readString(input.deploymentId)
        ? { deploymentId: readString(input.deploymentId) }
        : {}),
      ...(readString(input.deploymentStatus)
        ? { deploymentStatus: readString(input.deploymentStatus) }
        : {}),
      ...(clientSourceKey ? { clientSourceKey } : {}),
      ...(readString(input.artifactId) ? { artifactId: readString(input.artifactId) } : {}),
      ...(readString(input.updatedAt) ? { updatedAt: readString(input.updatedAt) } : {}),
      ...(accessExpiresAt === undefined ? {} : { accessExpiresAt }),
      ...(subscriptionRecoveryMode === undefined ? {} : { subscriptionRecoveryMode }),
      ...effectiveAccessFields,
    };
    return item;
  }
  return null;
};

export const listLibraryCloudItems = async (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  localStore: LibraryLocalStore,
  ownerScope: string,
  options: LibraryCloudListOptions,
): Promise<LibraryResult<LibraryCloudListData>> => {
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? LibraryLimits.DefaultPageSize, LibraryLimits.MaxPageSize),
  );
  const favorites = localStore.getFavoriteIds(ownerScope, [
    LibraryItemKind.SharedFile,
    LibraryItemKind.DeployedSite,
  ]);

  try {
    const requestedKind = options.category === LibraryCategory.Site
      ? LibraryCloudKind.DeployedSite
      : options.category && options.category !== LibraryCategory.All
        && (options.kind === undefined || options.kind === LibraryCloudKind.All)
        ? LibraryCloudKind.SharedFile
        : options.kind ?? LibraryCloudKind.All;
    const requestedCategory = options.category === LibraryCategory.Site
      ? LibraryCategory.All
      : options.category ?? LibraryCategory.All;
    const hasClientFilters = Boolean(
      options.favoritesOnly
      || (options.availability
        && options.availability !== LibraryCloudAvailabilityFilter.All),
    );
    let nextRequestCursor = options.cursor?.trim();
    let nextCursor: string | undefined;
    let hasMore = false;
    let counts: LibraryCloudListData['counts'] = { sharedFile: 0, deployedSite: 0 };
    let sharedStatusCounts: LibraryCloudListData['sharedStatusCounts'] = {
      all: 0,
      live: 0,
      disabled: 0,
    };
    let pageCount = 0;
    let serverNow = Date.now();
    let recoveryPending = false;
    const items = new Map<string, LibraryCloudItem>();
    do {
      const query = new URLSearchParams({
        kind: requestedKind,
        category: requestedCategory,
        pageSize: String(pageSize),
      });
      if (options.keyword?.trim()) {
        query.set('keyword', options.keyword.trim().slice(0, LibraryLimits.MaxKeywordLength));
      }
      if (options.sharedStatus) query.set('sharedStatus', options.sharedStatus);
      if (nextRequestCursor) query.set('cursor', nextRequestCursor);
      const response = await fetchWithAuth(
        `${serverBaseUrl}/api/library/cloud-items?${query.toString()}`,
      );
      const body = (await response.json().catch((): null => null)) as LibraryCloudApiResponse | null;
      if (!response.ok || body?.code !== 0 || !body.data) {
        return {
          success: false,
          code: response.status === 401
            ? LibraryErrorCode.NotAuthenticated
            : LibraryErrorCode.CloudUnavailable,
          error: body?.message || response.statusText || 'Cloud library request failed.',
        };
      }
      serverNow = readOptionalTimestamp(body.data.serverNow) ?? serverNow;
      recoveryPending = recoveryPending || readBoolean(body.data.recoveryPending) === true;
      for (const input of body.data.list ?? []) {
        const item = normalizeCloudItem(input, favorites, localStore);
        if (
          !item
          || (options.favoritesOnly && !item.isFavorite)
          || (options.availability
            && !matchesLibraryCloudAvailability(item, options.availability, serverNow))
        ) {
          continue;
        }
        items.set(`${item.itemKind}:${item.itemId}`, item);
      }
      nextCursor = body.data.nextCursor;
      hasMore = Boolean(body.data.hasMore && nextCursor);
      counts = {
        sharedFile: Number(body.data.counts?.sharedFile ?? 0),
        deployedSite: Number(body.data.counts?.deployedSite ?? 0),
      };
      sharedStatusCounts = {
        all: Number(body.data.sharedStatusCounts?.all ?? 0),
        live: Number(body.data.sharedStatusCounts?.live ?? 0),
        disabled: Number(body.data.sharedStatusCounts?.disabled ?? 0),
      };
      nextRequestCursor = nextCursor;
      pageCount += 1;
    } while (
      hasClientFilters
      && items.size < pageSize
      && hasMore
      && nextRequestCursor
      && pageCount < LibraryLimits.MaxFilteredCloudPages
    );
    return {
      success: true,
      data: {
        list: [...items.values()],
        hasMore,
        ...(hasMore && nextCursor ? { nextCursor } : {}),
        counts,
        sharedStatusCounts,
        serverNow,
        recoveryPending,
      },
    };
  } catch (error) {
    return {
      success: false,
      code: LibraryErrorCode.CloudUnavailable,
      error: error instanceof Error ? error.message : 'Cloud library request failed.',
    };
  }
};
