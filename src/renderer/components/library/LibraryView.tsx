import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentIcon,
  DocumentIcon,
  FolderIcon,
  GlobeAltIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  Squares2X2Icon,
  StarIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import {
  LibraryCategory,
  LibraryChangeReason,
  LibraryCloudAvailabilityFilter,
  LibraryCloudKind,
  LibraryErrorCode,
  LibraryItemKind,
  LibraryLimits,
  LibraryLocalProtocol,
  LibraryLocalSort,
  LibrarySourceFilter,
  LibraryViewMode,
} from '../../../shared/library/constants';
import type {
  LibraryChangedPayload,
  LibraryCloudItem,
  LibraryCloudListData,
  LibraryItem,
  LibraryLocalDetailData,
  LibraryLocalListData,
  LibrarySessionRef,
  LocalArtifactItem,
} from '../../../shared/library/types';
import { loadDetectedFileArtifact } from '../../services/artifactDetection';
import { copyTextToClipboard } from '../../services/clipboard';
import { i18nService } from '../../services/i18n';
import { startLibraryBackfill } from '../../services/libraryBackfill';
import {
  PublishingSubscriptionRecoveryCoordinatorEvent,
  reconcilePublishingSubscriptionRecovery,
} from '../../services/publishingSubscriptionRecovery';
import type { RootState } from '../../store';
import {
  ArtifactPreviewActionSource,
  ArtifactPublishEntryPoint,
} from '../artifacts/artifactAnalytics';
import {
  ArtifactFileShareProvider,
  useOptionalArtifactFileShare,
} from '../artifacts/ArtifactFileShareController';
import { isArtifactFileShareable } from '../artifacts/artifactFileSharePolicy';
import { shouldShowFreePublishingDeleteQuotaNotice } from '../artifacts/publishingDeleteNoticePolicy';
import CardOverflowMenu, { type CardOverflowMenuItem } from '../common/CardOverflowMenu';
import {
  MANAGEMENT_BODY_TEXT,
  MANAGEMENT_META_TEXT,
  MANAGEMENT_PAGE_TITLE_TEXT,
  MANAGEMENT_TITLE_TEXT,
} from '../common/managementTypography';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import ShareUploadIcon from '../icons/ShareUploadIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import Tooltip, { TooltipAlign, TooltipPosition } from '../ui/Tooltip';
import { LIBRARY_ACTION_MENU_WIDTH_PX } from './libraryActionMenuPresentation';
import {
  createLibraryAnalyticsOperationId,
  createLibraryAnalyticsPageViewId,
  getLibraryLoadedItemCountBucket,
  LibraryAnalyticsActionType,
  type LibraryAnalyticsContext,
  LibraryAnalyticsControl,
  LibraryAnalyticsEventPhase,
  LibraryAnalyticsResult,
  LibraryAnalyticsSurface,
  reportLibraryAction,
} from './libraryAnalytics';
import {
  canShareLibraryArtifact,
  createLibraryArtifactCandidate,
} from './libraryArtifactCandidate';
import LibraryCategoryDropdown from './LibraryCategoryDropdown';
import {
  formatLibraryDateGroupTitle,
  getLibraryDateGroupKey,
} from './libraryDateGrouping';
import {
  getLibraryCardActionIds,
  LibraryItemAction,
  type LibraryItemAction as LibraryItemActionValue,
} from './libraryItemActionPolicy';
import {
  formatLibraryTime,
  getLibraryDisplayFileName,
  getLibraryItemStatus,
  getLibrarySourceLabel,
  isLibraryWebsiteItem,
} from './libraryItemPresentation';
import {
  applyLibraryFavoriteState,
  removeLibraryCloudItem,
  restoreLibraryFavoriteState,
} from './libraryListState';
import {
  LibraryLoadingIndicator,
  LibraryToolbarLoadingStatus,
} from './LibraryLoadingIndicator';
import {
  getLibraryQueryLoadCause,
  LibraryLoadCause,
  type LibraryLoadCause as LibraryLoadCauseValue,
  type LibraryQueryIdentity,
  shouldResetLibraryScrollOnCommit,
} from './libraryLoadingPresentation';
import {
  getLibraryQueryLoadIntent,
  isLibraryBusyPhase,
  LibraryLoadIntent,
  LibraryLoadPhase,
} from './libraryLocalQueryState';
import LibraryPreviewModal from './LibraryPreviewModal';
import {
  type LibraryRefreshBatch,
  LibraryRefreshCoordinator,
  LibraryRefreshOutcome,
} from './libraryRefreshCoordinator';
import { getLibrarySessionAnchorKey, type LibraryScrollAnchor } from './libraryScrollAnchor';
import LibraryCloudView from './LibrarySharedFilesView';
import { groupLibraryItemsByTask } from './libraryTaskGrouping';
import LibraryThumbnail from './LibraryThumbnail';
import LibraryVirtualizedGroups, {
  type LibraryDateGroup,
} from './LibraryVirtualizedGroups';
import {
  LibraryWindowRefreshStatus,
  readLibraryLocalWindow,
  validateLibraryLocalAppend,
  validateLibraryLocalPage,
} from './libraryWindowRefresh';
import { useLibraryLoadingFeedback } from './useLibraryLoadingFeedback';
import { useLibraryScrollAnchor } from './useLibraryScrollAnchor';
import { useLibraryTaskGrid } from './useLibraryTaskGrid';

interface LibraryViewProps {
  isAuthenticated: boolean;
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSession: (session: LibrarySessionRef) => void;
  sitesHidden?: boolean;
  sitesReadOnly?: boolean;
  updateBadge?: React.ReactNode;
  requestedSource?: LibrarySourceFilter;
  navigationRequestId?: number;
}

interface LibraryCloudResolvedQuery {
  queryKey: string;
  scopeKey: string;
  availability: LibraryCloudAvailabilityFilter;
}

const CardDetailLoadStatus = {
  Loading: 'loading',
  Ready: 'ready',
  Error: 'error',
} as const;

type CardDetailLoadState =
  | { status: typeof CardDetailLoadStatus.Loading }
  | { status: typeof CardDetailLoadStatus.Ready; data: LibraryLocalDetailData }
  | { status: typeof CardDetailLoadStatus.Error };

const LIBRARY_GRID_CLASSNAME = 'grid justify-start gap-3';
const LIBRARY_GRID_STYLE: React.CSSProperties = {
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 264px))',
};
const EMPTY_LOCAL: LibraryLocalListData = {
  protocolVersion: LibraryLocalProtocol.Version,
  sort: LibraryLocalSort.RecentTask,
  list: [],
  hasMore: false,
  counts: { total: 0, available: 0, missing: 0 },
};

const EMPTY_CLOUD: LibraryCloudListData = {
  list: [],
  hasMore: false,
  counts: { sharedFile: 0, deployedSite: 0 },
  sharedStatusCounts: { all: 0, live: 0, disabled: 0 },
};

const appendUniqueItems = <T extends LibraryItem>(current: T[], next: T[]): T[] => {
  const items = new Map(current.map(item => [`${item.itemKind}:${item.itemId}`, item]));
  for (const item of next) items.set(`${item.itemKind}:${item.itemId}`, item);
  return [...items.values()];
};

const CATEGORY_FILTERS = [
  LibraryCategory.All,
  LibraryCategory.Slides,
  LibraryCategory.Web,
  LibraryCategory.Document,
  LibraryCategory.Spreadsheet,
  LibraryCategory.Image,
  LibraryCategory.Media,
  LibraryCategory.Other,
] as const;

const SOURCE_FILTERS = [
  LibrarySourceFilter.Local,
  LibrarySourceFilter.Cloud,
] as const;

const getLocalLibraryError = (code?: LibraryErrorCode, fallback?: string): string => {
  if (code === LibraryErrorCode.ProtocolMismatch) return i18nService.t('libraryRestartForUpdate');
  if (code === LibraryErrorCode.InvalidCursor || code === LibraryErrorCode.InvalidLocalData) {
    return i18nService.t('libraryInvalidLocalData');
  }
  return fallback ?? i18nService.t('unknownError');
};

const formatLibrarySessionTime = (value: number): string => new Intl.DateTimeFormat(
  i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
  { hour: '2-digit', minute: '2-digit' },
).format(new Date(value));

const SourceTab: React.FC<{
  source: LibrarySourceFilter;
  active: boolean;
  loading?: boolean;
  announceLoading?: boolean;
  onClick: () => void;
}> = ({
  source,
  active,
  loading = false,
  announceLoading = false,
  onClick,
}) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={`non-draggable inline-flex h-8 items-center gap-1.5 rounded-lg px-3 ${MANAGEMENT_PAGE_TITLE_TEXT} font-semibold transition-colors ${
      active ? 'bg-surface-raised text-foreground' : 'text-secondary hover:text-foreground'
    }`}
  >
    {i18nService.t(`librarySource_${source}`)}
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      {loading && (
        <LibraryLoadingIndicator
          label={i18nService.t('libraryUpdating')}
          announce={announceLoading}
        />
      )}
    </span>
  </button>
);

const LibraryListItemIcon: React.FC<{ item: LibraryItem }> = ({ item }) => {
  const isWebsite = isLibraryWebsiteItem(item);
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
      {isWebsite ? (
        <GlobeAltIcon className="h-[18px] w-[18px] text-primary" aria-hidden="true" />
      ) : (
        <FileTypeIcon fileName={getLibraryDisplayFileName(item)} className="h-[18px] w-[18px]" />
      )}
    </div>
  );
};

const LibraryItemCard: React.FC<{
  item: LibraryItem;
  viewMode: LibraryViewMode;
  onOpen: () => void;
  onMenuOpen?: () => void;
  menuItems: CardOverflowMenuItem[];
}> = ({ item, viewMode, onOpen, onMenuOpen, menuItems }) => {
  const list = viewMode === LibraryViewMode.List;
  if (list) {
    return (
      <article
        data-library-item-key={`${item.itemKind}:${item.itemId}`}
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={event => {
          if (event.key === 'Enter' && event.currentTarget === event.target) onOpen();
        }}
        className="group flex min-h-14 items-center gap-3 px-2 py-2 transition-colors hover:bg-surface-raised/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary/30"
      >
        <LibraryListItemIcon item={item} />
        <h3 className={`min-w-0 flex-1 truncate ${MANAGEMENT_BODY_TEXT} font-medium leading-5 text-foreground`}>
          {item.title}
        </h3>
        <div className="ml-auto flex shrink-0 items-center">
          <CardOverflowMenu
            items={menuItems}
            menuWidthPx={LIBRARY_ACTION_MENU_WIDTH_PX}
            onOpen={onMenuOpen}
            className="!h-8 !w-8 text-tertiary hover:bg-surface hover:text-foreground"
          />
        </div>
      </article>
    );
  }

  return (
    <article
      data-library-item-key={`${item.itemKind}:${item.itemId}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={event => {
        if (event.key === 'Enter' && event.currentTarget === event.target) onOpen();
      }}
      className="group relative overflow-hidden rounded-xl border border-border bg-surface p-2.5 transition-colors hover:border-primary/35 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-primary/30"
    >
      <div className="aspect-video w-full shrink-0 overflow-hidden rounded-lg border border-border">
        <LibraryThumbnail item={item} />
      </div>
      <div className="min-w-0 pt-2 pr-10">
        <h3 className={`line-clamp-2 ${MANAGEMENT_BODY_TEXT} font-medium leading-5 text-foreground`}>
          {item.title}
        </h3>
        <div className={`mt-1 flex min-w-0 items-center gap-1.5 ${MANAGEMENT_META_TEXT} leading-[var(--lobster-leading-xs)] text-secondary`}>
          <span className="truncate">{getLibrarySourceLabel(item)}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{getLibraryItemStatus(item)}</span>
        </div>
        <div className={`${MANAGEMENT_META_TEXT} mt-1 leading-[var(--lobster-leading-xs)] text-tertiary`}>
          {formatLibraryTime(item.sortTime)}
        </div>
      </div>
      <div className="absolute right-2 top-2">
        <CardOverflowMenu
          items={menuItems}
          menuWidthPx={LIBRARY_ACTION_MENU_WIDTH_PX}
          onOpen={onMenuOpen}
          className="!h-8 !w-8 bg-background/85 text-secondary hover:bg-background hover:text-foreground"
        />
      </div>
    </article>
  );
};

const LibraryViewContent: React.FC<LibraryViewProps> = ({
  isAuthenticated,
  isSidebarCollapsed,
  onToggleSidebar,
  onOpenSession,
  sitesHidden = false,
  sitesReadOnly = false,
  updateBadge,
  requestedSource = LibrarySourceFilter.Local,
  navigationRequestId = 0,
}) => {
  const artifactFileShare = useOptionalArtifactFileShare();
  const ownerAccountKey = useSelector((state: RootState) => state.auth.ownerAccountKey);
  const subscriptionStatus = useSelector(
    (state: RootState) => state.auth.quota?.subscriptionStatus,
  );
  const showFreeShareDeleteQuotaNotice = useSelector((state: RootState) => (
    shouldShowFreePublishingDeleteQuotaNotice(state.auth.quota?.subscriptionStatus)
  ));
  const favoriteOwnerScope = ownerAccountKey ?? undefined;
  const [analyticsPageViewId] = useState(createLibraryAnalyticsPageViewId);
  const [source, setSource] = useState<LibrarySourceFilter>(requestedSource);
  const [category, setCategory] = useState<LibraryCategory>(LibraryCategory.All);
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [cloudAvailability, setCloudAvailability] = useState<LibraryCloudAvailabilityFilter>(
    LibraryCloudAvailabilityFilter.All,
  );
  const [viewMode, setViewMode] = useState<LibraryViewMode>(LibraryViewMode.Grid);
  const [localData, setLocalData] = useState<LibraryLocalListData>(EMPTY_LOCAL);
  const [cloudData, setCloudData] = useState<LibraryCloudListData>(EMPTY_CLOUD);
  const [loadActivity, setLoadActivity] = useState<{
    phase: LibraryLoadPhase;
    cause: LibraryLoadCauseValue;
    id: number;
  }>({
    phase: LibraryLoadPhase.Initial,
    cause: LibraryLoadCause.Initial,
    id: 0,
  });
  const [localResolvedQueryKey, setLocalResolvedQueryKey] = useState('');
  const [cloudResolvedQuery, setCloudResolvedQuery] = useState<LibraryCloudResolvedQuery>();
  const [error, setError] = useState<string>();
  const [localNotice, setLocalNotice] = useState<string>();
  const [cloudError, setCloudError] = useState<string>();
  const [activeItem, setActiveItem] = useState<LibraryItem>();
  const [localDetail, setLocalDetail] = useState<LibraryLocalDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [cardDetailStates, setCardDetailStates] = useState<Record<string, CardDetailLoadState>>({});
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const localEpochRef = useRef(0);
  const localDirtyRef = useRef(false);
  const localCursorValidRef = useRef(false);
  const browseDepthRef = useRef<number>(LibraryLimits.DefaultPageSize);
  const localDataRef = useRef(localData);
  const gridInvalidateRef = useRef<(payload?: LibraryChangedPayload) => void>(() => undefined);
  const gridAnchorSessionIdsRef = useRef(new Map<string, string>());
  const gridLoadCauseRef = useRef<LibraryLoadCauseValue>(LibraryLoadCause.Initial);
  const gridManualRefreshRef = useRef(false);
  const currentQueryKeyRef = useRef('');
  const queryIdentityRef = useRef<LibraryQueryIdentity>();
  const pendingLocalRefreshCauseRef = useRef<LibraryLoadCauseValue>(
    LibraryLoadCause.BackgroundRefresh,
  );
  const refreshCoordinatorRef = useRef<LibraryRefreshCoordinator | undefined>(undefined);
  const refreshBatchHandlerRef = useRef<(batch: LibraryRefreshBatch) => Promise<LibraryRefreshOutcome>>(
    async () => LibraryRefreshOutcome.Stopped,
  );
  const refreshLocalWindowRef = useRef<
    (cause?: LibraryLoadCauseValue, retryAvailable?: boolean) => Promise<LibraryRefreshOutcome>
  >(async () => LibraryRefreshOutcome.Stopped);
  const cardDetailRequestIdsRef = useRef(new Set<string>());
  const scrollContainerRef = useRef<HTMLElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const localSearchInputRef = useRef<HTMLInputElement>(null);
  const pageExposureReportedRef = useRef(false);
  const lastListResultSignatureRef = useRef('');
  const lastReportedKeywordRef = useRef('');
  const pendingRefreshOperationIdRef = useRef<string>();

  const beginLibraryLoad = useCallback((
    phase: LibraryLoadPhase,
    cause: LibraryLoadCauseValue,
  ): void => {
    refreshCoordinatorRef.current?.setBusy(true);
    setLoadActivity(current => ({
      phase,
      cause,
      id: current.id + 1,
    }));
  }, []);

  const settleLibraryLoad = useCallback((): void => {
    setLoadActivity(current => (
      current.phase === LibraryLoadPhase.Settled
        ? current
        : { ...current, phase: LibraryLoadPhase.Settled }
    ));
    refreshCoordinatorRef.current?.setBusy(false);
  }, []);

  useEffect(() => {
    localDataRef.current = localData;
  }, [localData]);

  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(keywordInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keywordInput]);

  const wantsLocal = source === LibrarySourceFilter.Local;
  const wantsLocalGrid = wantsLocal && viewMode === LibraryViewMode.Grid;
  const wantsLocalList = wantsLocal && !wantsLocalGrid;
  const wantsCloud = source === LibrarySourceFilter.Cloud;
  const hasActiveLocalFilter = category !== LibraryCategory.All
    || keyword.length > 0
    || favoritesOnly;
  const localQueryKey = useMemo(() => JSON.stringify({
    category,
    keyword,
    favoritesOnly,
  }), [category, favoritesOnly, keyword]);
  const cloudScopeKey = useMemo(() => JSON.stringify({
    favoriteOwnerScope,
    isAuthenticated,
    sitesHidden,
  }), [favoriteOwnerScope, isAuthenticated, sitesHidden]);
  const cloudQueryKey = useMemo(() => JSON.stringify({
    category,
    keyword,
    favoritesOnly,
    cloudAvailability,
    cloudScopeKey,
  }), [
    category,
    cloudAvailability,
    cloudScopeKey,
    favoritesOnly,
    keyword,
  ]);
  const queryKey = wantsLocal ? `local:${localQueryKey}` : `cloud:${cloudQueryKey}`;
  const activeCloudResolvedQuery = cloudResolvedQuery?.scopeKey === cloudScopeKey
    ? cloudResolvedQuery
    : undefined;
  const visibleCloudData = activeCloudResolvedQuery ? cloudData : EMPTY_CLOUD;
  const cloudDisplayAvailability = activeCloudResolvedQuery?.availability ?? cloudAvailability;
  currentQueryKeyRef.current = queryKey;
  const notifyPositionChanged = useCallback(() => {
    setLocalNotice(i18nService.t('libraryPositionChanged'));
  }, []);
  const {
    capture: captureScrollAnchor,
    captureSession: captureSessionAnchor,
    pauseAppend,
    isAppendArmed,
    restore: restoreScrollAnchor,
    restoration,
    finish: finishScrollRestoration,
    appendArmed,
  } = useLibraryScrollAnchor(scrollContainerRef, queryKey, notifyPositionChanged, viewMode);

  const beforeGridLayoutChange = useCallback((sessionId?: string, collapse?: boolean, manual?: boolean) => {
    const anchor = collapse && sessionId ? captureSessionAnchor(sessionId) : captureScrollAnchor();
    pauseAppend();
    return manual ? { ...anchor, candidates: [], scrollTop: 0 } : anchor;
  }, [captureScrollAnchor, captureSessionAnchor, pauseAppend]);
  const afterGridLayoutChange = useCallback((anchor: unknown, isCurrent: () => boolean) => {
    restoreScrollAnchor(anchor as LibraryScrollAnchor, isCurrent);
  }, [restoreScrollAnchor]);
  const getGridAnchorSessionIds = useCallback(() => captureScrollAnchor().candidates
    .map(candidate => gridAnchorSessionIdsRef.current.get(candidate.itemKey))
    .filter((sessionId): sessionId is string => sessionId !== undefined), [captureScrollAnchor]);
  const taskGrid = useLibraryTaskGrid({
    active: wantsLocalGrid,
    category,
    keyword,
    favoritesOnly,
    onBeforeLayoutChange: beforeGridLayoutChange,
    onAfterLayoutChange: afterGridLayoutChange,
    getAnchorSessionIds: getGridAnchorSessionIds,
  });
  const {
    refresh: refreshTaskGrid,
    loadMoreTasks,
    expand: expandTask,
    loadMoreItems: loadMoreTaskItems,
    collapse: collapseTask,
  } = taskGrid;
  gridInvalidateRef.current = taskGrid.invalidate;
  const hasResolvedSnapshot = wantsLocalGrid
    ? taskGrid.hasResolvedSnapshot
    : wantsLocal ? localResolvedQueryKey.length > 0 : activeCloudResolvedQuery !== undefined;
  const hasResolvedCurrentQuery = wantsLocalGrid
    ? taskGrid.hasResolvedCurrentQuery
    : wantsLocal ? localResolvedQueryKey === localQueryKey : activeCloudResolvedQuery?.queryKey === cloudQueryKey;
  const gridLoadPhase = taskGrid.loading
    ? LibraryLoadPhase.Initial
    : taskGrid.loadingMore ? LibraryLoadPhase.Appending
      : taskGrid.refreshing ? LibraryLoadPhase.Refreshing : LibraryLoadPhase.Settled;
  const loadPhase = wantsLocalGrid ? gridLoadPhase : loadActivity.phase;
  const loadingFeedback = useLibraryLoadingFeedback({
    activityId: wantsLocalGrid ? taskGrid.activityId : loadActivity.id,
    phase: loadPhase,
    cause: wantsLocalGrid
      ? taskGrid.loadingMore ? LibraryLoadCause.Append
        : taskGrid.refreshing
          ? gridManualRefreshRef.current ? LibraryLoadCause.ManualRefresh : LibraryLoadCause.BackgroundRefresh
          : gridLoadCauseRef.current
      : loadActivity.cause,
    hasResolvedSnapshot,
  });
  const loading = loadingFeedback.showInitialSkeleton;
  const loadingMore = loadPhase === LibraryLoadPhase.Appending;
  const isBusy = isLibraryBusyPhase(loadPhase);
  const localDisplayError = wantsLocalGrid
    ? error ?? (taskGrid.errorCode === LibraryErrorCode.ProtocolMismatch ? getLocalLibraryError(taskGrid.errorCode)
      : taskGrid.needsManualRefresh ? i18nService.t('libraryGridRefreshFromTop')
      : taskGrid.error ? getLocalLibraryError(taskGrid.errorCode, i18nService.t('libraryGridTaskLoadFailed')) : undefined)
    : error;
  const localDisplayNotice = wantsLocalGrid && taskGrid.needsManualRefresh
    ? i18nService.t('libraryGridRefreshFromTop') : localNotice;

  useLayoutEffect(() => {
    if (restoration && (wantsLocalGrid ? taskGrid.groups.length === 0 : localData.list.length === 0)) {
      if (restoration.isCurrent() && scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      finishScrollRestoration(restoration.id, false);
    }
  }, [finishScrollRestoration, localData.list.length, restoration, taskGrid.groups.length, wantsLocalGrid]);
  const analyticsContext = useMemo<LibraryAnalyticsContext>(() => ({
    pageViewId: analyticsPageViewId,
    librarySource: source,
    category,
    ...(wantsCloud ? { availability: cloudAvailability } : {}),
    favoritesOnly,
    keyword,
    viewMode: wantsCloud ? LibraryViewMode.List : viewMode,
    isAuthenticated,
  }), [
    analyticsPageViewId,
    category,
    cloudAvailability,
    favoritesOnly,
    isAuthenticated,
    keyword,
    source,
    viewMode,
    wantsCloud,
  ]);

  useEffect(() => {
    if (pageExposureReportedRef.current) return;
    pageExposureReportedRef.current = true;
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.PageExposure,
    });
  }, [analyticsContext]);

  useEffect(() => {
    if (lastReportedKeywordRef.current === keyword) return;
    lastReportedKeywordRef.current = keyword;
    reportLibraryAction(analyticsContext, {
      actionType: keyword
        ? LibraryAnalyticsActionType.SearchApplied
        : LibraryAnalyticsActionType.SearchCleared,
      control: LibraryAnalyticsControl.Search,
    });
  }, [analyticsContext, keyword]);

  const reportListResult = useCallback((
    result: LibraryAnalyticsResult,
    resultCount?: number,
    hasMore?: boolean,
  ): void => {
    const signature = JSON.stringify({
      librarySource: analyticsContext.librarySource,
      category: analyticsContext.category,
      availability: analyticsContext.availability,
      favoritesOnly: analyticsContext.favoritesOnly,
      hasSearch: analyticsContext.keyword.trim().length > 0,
      result,
      loadedItemCountBucket: getLibraryLoadedItemCountBucket(resultCount),
      hasMore,
      operationId: pendingRefreshOperationIdRef.current,
    });
    if (lastListResultSignatureRef.current === signature) return;
    lastListResultSignatureRef.current = signature;
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.ListResult,
      result,
      loadedItemCount: resultCount,
      hasMore,
      ...(pendingRefreshOperationIdRef.current
        ? {
            operationId: pendingRefreshOperationIdRef.current,
            eventPhase: LibraryAnalyticsEventPhase.Result,
          }
        : {}),
    });
    pendingRefreshOperationIdRef.current = undefined;
  }, [analyticsContext]);

  const clearKeyword = useCallback(() => {
    setKeywordInput('');
    setKeyword('');
  }, []);

  const handleSourceChange = (nextSource: LibrarySourceFilter): void => {
    if (nextSource === source) return;
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.SourceChange,
      control: LibraryAnalyticsControl.Source,
      targetValue: nextSource,
    });
    setActiveItem(undefined);
    setCategory(LibraryCategory.All);
    setKeywordInput('');
    setKeyword('');
    setSource(nextSource);
    scrollContainerRef.current?.scrollTo({ top: 0 });
  };

  const handleCategoryChange = (nextCategory: LibraryCategory): void => {
    if (nextCategory === category) return;
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.FilterChange,
      control: LibraryAnalyticsControl.Category,
      targetValue: nextCategory,
    });
    setCategory(nextCategory);
  };

  const handleAvailabilityChange = (
    nextAvailability: LibraryCloudAvailabilityFilter,
  ): void => {
    if (nextAvailability === cloudAvailability) return;
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.FilterChange,
      control: LibraryAnalyticsControl.Availability,
      targetValue: nextAvailability,
    });
    setCloudAvailability(nextAvailability);
  };

  const handleFavoritesOnlyToggle = (): void => {
    const nextFavoritesOnly = !favoritesOnly;
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.FilterChange,
      control: LibraryAnalyticsControl.Favorites,
      targetValue: nextFavoritesOnly,
    });
    setFavoritesOnly(nextFavoritesOnly);
  };

  const handleViewModeChange = (nextViewMode: LibraryViewMode): void => {
    if (nextViewMode === viewMode) return;
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.ViewModeChange,
      control: LibraryAnalyticsControl.ViewMode,
      targetValue: nextViewMode,
    });
    setViewMode(nextViewMode);
  };

  useEffect(() => {
    setActiveItem(undefined);
    setCategory(LibraryCategory.All);
    setKeywordInput('');
    setKeyword('');
    setSource(requestedSource);
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, [navigationRequestId, requestedSource]);

  useEffect(() => {
    if (sitesHidden && category === LibraryCategory.Site) {
      setCategory(LibraryCategory.All);
    }
  }, [category, sitesHidden]);

  const loadData = useCallback(async (
    intent: LibraryLoadIntent,
    cause: LibraryLoadCauseValue,
  ) => {
    if (wantsLocalGrid) return;
    const append = intent === LibraryLoadIntent.Append;
    if (wantsLocal && append && (!localCursorValidRef.current || localDirtyRef.current || restoration)) return;
    const requestId = ++requestIdRef.current;
    const requestEpoch = localEpochRef.current;
    let appliedActiveResult = false;
    const requestLocalQueryKey = localQueryKey;
    const requestCloudQueryKey = cloudQueryKey;
    const requestCloudScopeKey = cloudScopeKey;
    const requestCloudAvailability = cloudAvailability;
    beginLibraryLoad(append
      ? LibraryLoadPhase.Appending
      : intent === LibraryLoadIntent.Revalidate
        ? LibraryLoadPhase.Revalidating
        : intent === LibraryLoadIntent.Refresh
          ? LibraryLoadPhase.Refreshing
          : LibraryLoadPhase.Initial, cause);
    if (!append) {
      setError(undefined);
      setCloudError(undefined);
    }
    const loadLocalPage = wantsLocal && (!append || localData.hasMore);
    const loadCloudPage = wantsCloud && (!append || visibleCloudData.hasMore);
    const localPromise = loadLocalPage
      ? window.electron.library.listLocal({
          category,
          keyword,
          favoritesOnly,
          pageSize: LibraryLimits.DefaultPageSize,
          ...(append && localData.nextCursor
            ? { cursor: localData.nextCursor, sort: LibraryLocalSort.RecentTask }
            : {}),
        })
      : Promise.resolve(null);
    const cloudKind = sitesHidden
      ? LibraryCloudKind.SharedFile
      : LibraryCloudKind.All;
    const cloudPromise = loadCloudPage && isAuthenticated && favoriteOwnerScope
      ? window.electron.library.listCloud({
          kind: cloudKind,
          category,
          keyword,
          favoritesOnly,
          favoriteOwnerScope,
          availability: cloudAvailability,
          pageSize: LibraryLimits.DefaultPageSize,
          ...(append && visibleCloudData.nextCursor
            ? { cursor: visibleCloudData.nextCursor }
            : {}),
        })
      : Promise.resolve(null);
    const applyLocalResult = async () => {
      try {
        const localResult = await localPromise;
        if (requestId !== requestIdRef.current) return;
        if (requestEpoch !== localEpochRef.current) return;
        if (localResult?.success) {
          const validation = append
            ? validateLibraryLocalAppend(localDataRef.current, localResult.data, {
                pageSize: LibraryLimits.DefaultPageSize,
                requestCursor: localData.nextCursor,
              })
            : validateLibraryLocalPage(localResult.data, { pageSize: LibraryLimits.DefaultPageSize });
          if (validation.status !== LibraryWindowRefreshStatus.Success) {
            localDirtyRef.current = true;
            localCursorValidRef.current = false;
            if (validation.status === LibraryWindowRefreshStatus.Invalidated) {
              localEpochRef.current += 1;
              refreshCoordinatorRef.current?.consumeImmediateRetry();
              refreshCoordinatorRef.current?.enqueue({ reason: LibraryChangeReason.Repair });
            } else setError(getLocalLibraryError(validation.code, validation.error));
            return;
          }
          const nextData = {
            ...localResult.data,
            list: append ? [...localDataRef.current.list, ...localResult.data.list] : localResult.data.list,
          };
          if (!append) {
            reportListResult(
              LibraryAnalyticsResult.Success,
              nextData.list.length,
              nextData.hasMore,
            );
          }
          localDataRef.current = nextData;
          browseDepthRef.current = Math.max(LibraryLimits.DefaultPageSize, nextData.list.length);
          localDirtyRef.current = false;
          localCursorValidRef.current = true;
          setLocalData(nextData);
          if (!append) setLocalResolvedQueryKey(requestLocalQueryKey);
          appliedActiveResult = true;
        } else if (localResult) {
          if (!append) reportListResult(LibraryAnalyticsResult.Failure);
          localDirtyRef.current = true;
          localCursorValidRef.current = false;
          if (localResult.code === LibraryErrorCode.InvalidCursor) {
            refreshCoordinatorRef.current?.consumeImmediateRetry();
            refreshCoordinatorRef.current?.enqueue({ reason: LibraryChangeReason.Repair });
          } else setError(getLocalLibraryError(localResult.code, localResult.error));
        }
      } catch (loadError) {
        if (requestId === requestIdRef.current) {
          if (!append) reportListResult(LibraryAnalyticsResult.Failure);
          localDirtyRef.current = true;
          localCursorValidRef.current = false;
          setError(loadError instanceof Error ? loadError.message : i18nService.t('unknownError'));
        }
      }
    };
    const applyCloudResult = async () => {
      try {
        const cloudResult = await cloudPromise;
        if (requestId !== requestIdRef.current) return;
        if (cloudResult?.success) {
          if (!append) {
            reportListResult(
              LibraryAnalyticsResult.Success,
              cloudResult.data.list.length,
              cloudResult.data.hasMore,
            );
          }
          setCloudData(current => {
            if (append) {
              return {
                ...cloudResult.data,
                list: appendUniqueItems(current.list, cloudResult.data.list),
                recoveryPending: current.recoveryPending
                  || cloudResult.data.recoveryPending,
              };
            }
            return cloudResult.data;
          });
          if (!append) {
            setCloudResolvedQuery({
              queryKey: requestCloudQueryKey,
              scopeKey: requestCloudScopeKey,
              availability: requestCloudAvailability,
            });
          }
          appliedActiveResult = true;
        } else if (cloudResult) {
          if (!append) reportListResult(LibraryAnalyticsResult.Failure);
          setCloudError(cloudResult.error);
        } else if (!append) {
          if (wantsCloud && (!isAuthenticated || !favoriteOwnerScope)) {
            reportListResult(LibraryAnalyticsResult.AuthRequired);
            setCloudData(EMPTY_CLOUD);
            setCloudResolvedQuery(undefined);
          }
        }
      } catch (loadError) {
        if (requestId === requestIdRef.current) {
          if (!append) reportListResult(LibraryAnalyticsResult.Failure);
          setCloudError(
            loadError instanceof Error ? loadError.message : i18nService.t('unknownError'),
          );
        }
      }
    };
    await Promise.all([applyLocalResult(), applyCloudResult()]);
    if (requestId !== requestIdRef.current) return;
    if (
      !append
      && appliedActiveResult
      && shouldResetLibraryScrollOnCommit(cause)
    ) {
      scrollContainerRef.current?.scrollTo({ top: 0 });
    }
    settleLibraryLoad();
  }, [
    beginLibraryLoad,
    category,
    cloudQueryKey,
    cloudScopeKey,
    favoriteOwnerScope,
    favoritesOnly,
    isAuthenticated,
    keyword,
    localData.hasMore,
    localData.nextCursor,
    localQueryKey,
    cloudAvailability,
    reportListResult,
    restoration,
    settleLibraryLoad,
    sitesHidden,
    visibleCloudData.hasMore,
    visibleCloudData.nextCursor,
    wantsCloud,
    wantsLocal,
    wantsLocalGrid,
  ]);

  const refreshLocalWindow = useCallback(async (
    cause: LibraryLoadCauseValue = LibraryLoadCause.BackgroundRefresh,
    retryAvailable = true,
  ): Promise<LibraryRefreshOutcome> => {
    if (!mountedRef.current || !wantsLocalList) return LibraryRefreshOutcome.Stopped;
    const requestId = ++requestIdRef.current;
    const requestQueryKey = queryKey;
    const requestLocalQueryKey = localQueryKey;
    const requestEpoch = localEpochRef.current;
    const manual = cause === LibraryLoadCause.ManualRefresh;
    if (manual) browseDepthRef.current = LibraryLimits.DefaultPageSize;
    const isCurrent = (): boolean => requestId === requestIdRef.current
      && mountedRef.current && requestQueryKey === currentQueryKeyRef.current;
    localDirtyRef.current = true;
    localCursorValidRef.current = false;
    beginLibraryLoad(LibraryLoadPhase.Refreshing, cause);
    setError(undefined);
    try {
      const result = await readLibraryLocalWindow({
        readPage: options => window.electron.library.listLocal(options),
        query: { category, keyword, favoritesOnly },
        browseDepth: browseDepthRef.current,
        getAnchorKeys: () => manual ? [] : captureScrollAnchor().candidates.map(candidate => candidate.itemKey),
        isCurrent,
        getDataEpoch: () => localEpochRef.current,
      });
      if (!isCurrent()) return LibraryRefreshOutcome.Stopped;
      if (result.status === LibraryWindowRefreshStatus.Invalidated) {
        if (result.code === LibraryErrorCode.InvalidCursor && !retryAvailable) {
          setError(getLocalLibraryError(result.code));
          return LibraryRefreshOutcome.Stopped;
        }
        return LibraryRefreshOutcome.Invalidated;
      }
      if (result.status === LibraryWindowRefreshStatus.BudgetExceeded) {
        setError(i18nService.t('libraryRefreshFromTop'));
        return LibraryRefreshOutcome.Stopped;
      }
      if (result.status === LibraryWindowRefreshStatus.Failure) {
        setError(getLocalLibraryError(result.code, result.error));
        return LibraryRefreshOutcome.Stopped;
      }
      if (requestEpoch !== localEpochRef.current) return LibraryRefreshOutcome.Invalidated;
      const nextData = result.data;
      const anchor = captureScrollAnchor();
      restoreScrollAnchor(manual ? { ...anchor, candidates: [], scrollTop: 0 } : anchor,
        () => isCurrent() && requestEpoch === localEpochRef.current);
      localDataRef.current = nextData;
      localDirtyRef.current = false;
      localCursorValidRef.current = true;
      setLocalData(nextData);
      setLocalResolvedQueryKey(requestLocalQueryKey);
      setLocalNotice(undefined);
      setCardDetailStates({});
      setActiveItem(current => current?.itemKind === LibraryItemKind.LocalArtifact
        ? nextData.list.find(item => item.itemId === current.itemId) ?? current
        : current);
      reportListResult(LibraryAnalyticsResult.Success, nextData.list.length, nextData.hasMore);
      return LibraryRefreshOutcome.Committed;
    } catch (refreshError) {
      if (
        requestId === requestIdRef.current
        && mountedRef.current
        && requestQueryKey === currentQueryKeyRef.current
      ) {
        reportListResult(LibraryAnalyticsResult.Failure);
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : i18nService.t('unknownError'),
        );
      }
      return LibraryRefreshOutcome.Stopped;
    } finally {
      if (
        requestId === requestIdRef.current
        && mountedRef.current
        && requestQueryKey === currentQueryKeyRef.current
      ) {
        settleLibraryLoad();
      }
    }
  }, [
    beginLibraryLoad,
    captureScrollAnchor,
    category,
    favoritesOnly,
    keyword,
    localQueryKey,
    queryKey,
    reportListResult,
    restoreScrollAnchor,
    settleLibraryLoad,
    wantsLocalList,
  ]);
  refreshLocalWindowRef.current = refreshLocalWindow;

  const handleRefresh = useCallback((): void => {
    const operationId = createLibraryAnalyticsOperationId();
    pendingRefreshOperationIdRef.current = operationId;
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.Refresh,
      operationId,
      eventPhase: LibraryAnalyticsEventPhase.Start,
    });
    if (wantsLocalGrid) {
      setError(undefined);
      setLocalNotice(undefined);
      gridManualRefreshRef.current = true;
      gridLoadCauseRef.current = LibraryLoadCause.ManualRefresh;
      refreshTaskGrid({ manual: true });
      return;
    }
    if (wantsLocal) {
      localEpochRef.current += 1;
      localDirtyRef.current = true;
      localCursorValidRef.current = false;
      pendingLocalRefreshCauseRef.current = LibraryLoadCause.ManualRefresh;
      const coordinator = refreshCoordinatorRef.current;
      if (coordinator) {
        coordinator.resetPending();
        coordinator.enqueue({ reason: LibraryChangeReason.Repair });
        coordinator.flushNow();
      } else {
        void refreshLocalWindow(LibraryLoadCause.ManualRefresh);
      }
      return;
    }
    void loadData(LibraryLoadIntent.Refresh, LibraryLoadCause.ManualRefresh);
  }, [analyticsContext, loadData, refreshLocalWindow, refreshTaskGrid, wantsLocal, wantsLocalGrid]);

  useEffect(() => {
    const handleRecoveryInvalidation = (event: Event): void => {
      const ownerAccountKey = (event as CustomEvent<{ ownerAccountKey?: string }>).detail
        ?.ownerAccountKey;
      if (
        !wantsCloud
        || !isAuthenticated
        || !favoriteOwnerScope
        || ownerAccountKey !== favoriteOwnerScope
      ) {
        return;
      }
      void loadData(LibraryLoadIntent.Refresh, LibraryLoadCause.BackgroundRefresh);
    };
    window.addEventListener(
      PublishingSubscriptionRecoveryCoordinatorEvent.LibraryInvalidated,
      handleRecoveryInvalidation,
    );
    return () => {
      window.removeEventListener(
        PublishingSubscriptionRecoveryCoordinatorEvent.LibraryInvalidated,
        handleRecoveryInvalidation,
      );
    };
  }, [favoriteOwnerScope, isAuthenticated, loadData, wantsCloud]);

  useEffect(() => {
    if (
      wantsCloud
      && isAuthenticated
      && favoriteOwnerScope
      && hasResolvedCurrentQuery
      && visibleCloudData.recoveryPending === true
    ) {
      reconcilePublishingSubscriptionRecovery(favoriteOwnerScope);
    }
  }, [
    favoriteOwnerScope,
    hasResolvedCurrentQuery,
    isAuthenticated,
    visibleCloudData.recoveryPending,
    wantsCloud,
  ]);

  useLayoutEffect(() => {
    const queryIdentity: LibraryQueryIdentity = {
      source,
      scopeKey: cloudScopeKey,
      category,
      keyword,
      favoritesOnly,
      availability: cloudAvailability,
    };
    const cause = getLibraryQueryLoadCause(queryIdentityRef.current, queryIdentity);
    const sameQuery = queryIdentityRef.current !== undefined
      && JSON.stringify(queryIdentityRef.current) === JSON.stringify(queryIdentity);
    queryIdentityRef.current = queryIdentity;
    requestIdRef.current += 1;
    refreshCoordinatorRef.current?.resetPending();
    refreshCoordinatorRef.current?.resetRetries();
    pendingLocalRefreshCauseRef.current = LibraryLoadCause.BackgroundRefresh;
    if (!sameQuery) {
      browseDepthRef.current = LibraryLimits.DefaultPageSize;
      localCursorValidRef.current = false;
    }
    setError(undefined);
    setLocalNotice(undefined);
    if (wantsLocalGrid) {
      gridLoadCauseRef.current = cause;
      gridManualRefreshRef.current = false;
      settleLibraryLoad();
      return;
    }
    if (wantsLocalList && sameQuery && localResolvedQueryKey === localQueryKey) {
      if (localDirtyRef.current || !localCursorValidRef.current) {
        void refreshLocalWindow(LibraryLoadCause.BackgroundRefresh);
      } else settleLibraryLoad();
      return;
    }
    void loadData(getLibraryQueryLoadIntent(hasResolvedSnapshot), cause);
  // Cursor changes are outputs of this request and must not trigger a new first page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    category,
    cloudScopeKey,
    favoritesOnly,
    keyword,
    cloudAvailability,
    source,
    viewMode,
  ]);

  refreshBatchHandlerRef.current = async batch => {
    if (!mountedRef.current) return LibraryRefreshOutcome.Stopped;
    const refreshCause = pendingLocalRefreshCauseRef.current;
    const outcome = await refreshLocalWindowRef.current(refreshCause, batch.immediateRetryAvailable);
    if (outcome !== LibraryRefreshOutcome.Invalidated
      && pendingLocalRefreshCauseRef.current === refreshCause) {
      pendingLocalRefreshCauseRef.current = LibraryLoadCause.BackgroundRefresh;
    }
    return outcome;
  };

  useEffect(() => {
    mountedRef.current = true;
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: batch => refreshBatchHandlerRef.current(batch),
      onError: refreshError => {
        console.warn('[LibraryRefresh] Refresh coordinator failed.', refreshError);
      },
    });
    refreshCoordinatorRef.current = coordinator;
    const unsubscribe = window.electron.library.onChanged(payload => {
      if (payload.itemKind && payload.itemKind !== LibraryItemKind.LocalArtifact) return;
      // Invalidation cannot wait for coalescing, including during an append.
      localEpochRef.current += 1;
      localDirtyRef.current = true;
      localCursorValidRef.current = false;
      setCardDetailStates({});
      gridInvalidateRef.current(payload);
      coordinator.enqueue(payload);
    });
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      unsubscribe();
      coordinator.dispose();
      if (refreshCoordinatorRef.current === coordinator) {
        refreshCoordinatorRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    refreshCoordinatorRef.current?.setActive(
      wantsLocalList,
    );
    refreshCoordinatorRef.current?.setBusy(isBusy);
  }, [isBusy, wantsLocalList]);

  useEffect(() => {
    void startLibraryBackfill();
  }, []);

  const localPreviewSnapshot = wantsLocalGrid ? taskGrid.dataRevision : localData;
  useEffect(() => {
    let active = true;
    setLocalDetail(null);
    if (activeItem?.itemKind !== LibraryItemKind.LocalArtifact) {
      setDetailLoading(false);
      return () => { active = false; };
    }
    setDetailLoading(true);
    void window.electron.library.getLocalDetail(activeItem.itemId).then(result => {
      if (active && result.success) {
        const validation = validateLibraryLocalPage({
          ...EMPTY_LOCAL,
          list: [result.data.item],
          counts: { total: 1, available: 1, missing: 0 },
        });
        if (validation.status === LibraryWindowRefreshStatus.Success) {
          setLocalDetail(result.data);
          setActiveItem(current => current?.itemKind === LibraryItemKind.LocalArtifact
            && current.itemId === result.data.item.itemId ? result.data.item : current);
        } else if (validation.status === LibraryWindowRefreshStatus.Failure) {
          setError(getLocalLibraryError(validation.code, validation.error));
        }
      } else if (active && !result.success && result.code === LibraryErrorCode.NotFound) {
        setActiveItem(undefined);
      }
      if (active) setDetailLoading(false);
    }).catch(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [activeItem?.itemId, activeItem?.itemKind, localPreviewSnapshot]);

  const dateGroups = useMemo<LibraryDateGroup[]>(() => {
    const now = Date.now();
    const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';
    if (wantsLocalGrid) {
      const dates = new Map<string, LibraryDateGroup>();
      for (const group of taskGrid.groups) {
        const sessionId = group.session.sessionId;
        const dateKey = getLibraryDateGroupKey(group.session.updatedAt);
        let date = dates.get(dateKey);
        if (!date) {
          date = {
            key: dateKey,
            title: formatLibraryDateGroupTitle(group.session.updatedAt, {
              locale,
              todayLabel: i18nService.t('libraryTime_today'),
              yesterdayLabel: i18nService.t('libraryTime_yesterday'),
              now,
            }),
            sessionGroups: [],
          };
          dates.set(dateKey, date);
        }
        date.sessionGroups.push({
          key: sessionId,
          session: group.session,
          title: group.session.title,
          sortTime: group.session.updatedAt,
          items: group.items,
          disclosure: {
            expanded: group.expanded,
            matchedFileCount: group.matchedFileCount,
            loading: group.loading,
            disabled: !group.canLoadMoreItems,
            error: group.error ? i18nService.t('libraryGridTaskLoadFailed') : undefined,
            onExpand: () => { pauseAppend(); void expandTask(sessionId); },
            onLoadMore: () => { pauseAppend(); void loadMoreTaskItems(sessionId); },
            onCollapse: () => { pauseAppend(); collapseTask(sessionId); },
            onRetry: () => { pauseAppend(); void loadMoreTaskItems(sessionId); },
          },
        });
      }
      return [...dates.values()];
    }
    return groupLibraryItemsByTask(localData.list).map(dateBucket => {
      const sessionGroups = dateBucket.sessionBuckets.map(sessionBucket => {
        const firstItem = sessionBucket.items[0];
        const session = firstItem.latestSession;
        return {
          key: `${dateBucket.dateKey}:${sessionBucket.sessionKey}`,
          title: session?.title ?? i18nService.t('libraryCloudGroup'),
          sortTime: sessionBucket.representativeTime,
          ...(session ? { session } : {}),
          items: sessionBucket.items,
        };
      });
      return {
        key: dateBucket.dateKey,
        title: formatLibraryDateGroupTitle(dateBucket.representativeTime, {
          locale,
          todayLabel: i18nService.t('libraryTime_today'),
          yesterdayLabel: i18nService.t('libraryTime_yesterday'),
          now,
        }),
        sessionGroups,
      };
    });
  }, [localData.list, taskGrid.groups, expandTask, loadMoreTaskItems, collapseTask, pauseAppend, wantsLocalGrid]);

  gridAnchorSessionIdsRef.current = new Map(taskGrid.groups.flatMap(group => [
    [getLibrarySessionAnchorKey(group.session.sessionId), group.session.sessionId],
    ...group.items.map(item => [`${item.itemKind}:${item.itemId}`, group.session.sessionId]),
  ] as Array<[string, string]>));

  useEffect(() => {
    if (!wantsLocalGrid || isBusy) return;
    gridManualRefreshRef.current = false;
    if (taskGrid.error) reportListResult(LibraryAnalyticsResult.Failure);
    else if (taskGrid.hasResolvedCurrentQuery) {
      reportListResult(LibraryAnalyticsResult.Success,
        taskGrid.groups.reduce((sum, group) => sum + group.items.length, 0), taskGrid.hasMoreTasks);
    }
  }, [isBusy, reportListResult, taskGrid.error, taskGrid.groups, taskGrid.hasMoreTasks, taskGrid.hasResolvedCurrentQuery, wantsLocalGrid]);

  const updateFavorite = async (item: LibraryItem): Promise<void> => {
    const next = !item.isFavorite;
    const operationId = createLibraryAnalyticsOperationId();
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.FavoriteChange,
      itemKind: item.itemKind,
      itemCategory: item.category,
      favorite: next,
      operationId,
      eventPhase: LibraryAnalyticsEventPhase.Start,
    });
    if (item.itemKind === LibraryItemKind.LocalArtifact) {
      taskGrid.invalidate();
      localEpochRef.current += 1;
      localDirtyRef.current = true;
      localCursorValidRef.current = false;
      setLocalData(current => ({
        ...current,
        list: applyLibraryFavoriteState(current.list, item, next, favoritesOnly),
      }));
    } else {
      setCloudData(current => ({
        ...current,
        list: applyLibraryFavoriteState(current.list, item, next, favoritesOnly),
      }));
    }
    setActiveItem(current => current?.itemId === item.itemId
      && current.itemKind === item.itemKind ? { ...current, isFavorite: next } : current);
    const result = await window.electron.library.setFavorite({
      ownerScope: favoriteOwnerScope ?? '',
      itemKind: item.itemKind,
      itemId: item.itemId,
      favorite: next,
    }).catch(() => ({
      success: false as const,
      code: LibraryErrorCode.Internal,
      error: i18nService.t('unknownError'),
    }));
    if (item.itemKind === LibraryItemKind.LocalArtifact) {
      taskGrid.invalidate({ reason: LibraryChangeReason.Favorite, itemIds: [item.itemId] });
      refreshCoordinatorRef.current?.enqueue({ reason: LibraryChangeReason.Favorite, itemIds: [item.itemId] });
    }
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.FavoriteChange,
      itemKind: item.itemKind,
      itemCategory: item.category,
      favorite: next,
      operationId,
      eventPhase: LibraryAnalyticsEventPhase.Result,
      result: result.success ? LibraryAnalyticsResult.Success : LibraryAnalyticsResult.Failure,
    });
    if (!result.success) {
      setError(result.error);
      if (item.itemKind === LibraryItemKind.LocalArtifact) {
        setLocalData(current => ({
          ...current,
          list: restoreLibraryFavoriteState(current.list, item),
        }));
      } else {
        setCloudData(current => ({
          ...current,
          list: restoreLibraryFavoriteState(current.list, item),
        }));
      }
      setActiveItem(current => current?.itemId === item.itemId
        && current.itemKind === item.itemKind ? { ...current, isFavorite: item.isFavorite } : current);
    }
  };

  const updateCloudItem = useCallback((updatedItem: LibraryCloudItem): void => {
    setCloudData(current => ({
      ...current,
      list: current.list.map(item => (
        item.itemKind === updatedItem.itemKind
          && item.shareId === updatedItem.shareId
          ? updatedItem
          : item
      )),
    }));
  }, []);

  const deleteCloudItem = useCallback((deletedItem: LibraryCloudItem): void => {
    setCloudData(current => removeLibraryCloudItem(current, deletedItem));
  }, []);

  const openItem = (item: LibraryItem): void => {
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.ItemPreviewOpen,
      itemKind: item.itemKind,
      itemCategory: item.category,
    });
    setActiveItem(item);
  };

  const handleCloudDetailOpen = (item: LibraryCloudItem): void => {
    reportLibraryAction(analyticsContext, {
      actionType: LibraryAnalyticsActionType.ItemPreviewOpen,
      itemKind: item.itemKind,
      itemCategory: item.category,
    });
    scrollContainerRef.current?.scrollTo({ top: 0 });
  };

  const openLocalWithApp = (item: LocalArtifactItem): void => {
    void window.electron.library.openLocal(item.itemId).then(result => {
      if (!result.success) setError(result.error);
    });
  };

  const revealLocal = (item: LocalArtifactItem): void => {
    void window.electron.library.revealLocal(item.itemId).then(result => {
      if (!result.success) setError(result.error);
    });
  };

  const copyValue = (value: string): void => {
    void copyTextToClipboard(value).then(copied => {
      if (!copied) setError(i18nService.t('copyFailed'));
    });
  };

  const openCloudLink = (item: Exclude<LibraryItem, LocalArtifactItem>): void => {
    void window.electron.shell.openExternal(item.url).then(result => {
      if (!result.success) setError(result.error ?? i18nService.t('unknownError'));
    });
  };

  const loadCardDetail = (item: LocalArtifactItem): void => {
    const requestEpoch = localEpochRef.current;
    const knownSessionCount = item.latestSession ? 1 : 0;
    if (
      item.relatedSessionCount <= knownSessionCount
      || cardDetailStates[item.itemId]
      || cardDetailRequestIdsRef.current.has(item.itemId)
    ) {
      return;
    }
    cardDetailRequestIdsRef.current.add(item.itemId);
    setCardDetailStates(current => ({
      ...current,
      [item.itemId]: { status: CardDetailLoadStatus.Loading },
    }));
    void window.electron.library.getLocalDetail(item.itemId).then(result => {
      if (requestEpoch !== localEpochRef.current || !mountedRef.current) return;
      if (result.success) {
        setCardDetailStates(current => ({
          ...current,
          [item.itemId]: { status: CardDetailLoadStatus.Ready, data: result.data },
        }));
      } else {
        setCardDetailStates(current => ({
          ...current,
          [item.itemId]: { status: CardDetailLoadStatus.Error },
        }));
      }
    }).catch(() => {
      if (requestEpoch !== localEpochRef.current || !mountedRef.current) return;
      setCardDetailStates(current => ({
        ...current,
        [item.itemId]: { status: CardDetailLoadStatus.Error },
      }));
    }).finally(() => {
      cardDetailRequestIdsRef.current.delete(item.itemId);
    });
  };

  const shareLocalItem = async (item: LocalArtifactItem): Promise<void> => {
    if (
      !canShareLibraryArtifact(item)
      || !artifactFileShare
    ) {
      setError(i18nService.t('artifactShareSourceUnavailable'));
      return;
    }
    try {
      const artifact = await loadDetectedFileArtifact(createLibraryArtifactCandidate(item));
      if (!artifact || !isArtifactFileShareable(artifact)) {
        setError(i18nService.t('artifactShareSourceUnavailable'));
        return;
      }
      await artifactFileShare.openShare(artifact, {
        source: ArtifactPreviewActionSource.LibraryList,
        entryPoint: ArtifactPublishEntryPoint.LibraryMenu,
        surface: LibraryAnalyticsSurface.MyFiles,
        pageViewId: analyticsPageViewId,
      });
    } catch (shareError) {
      const message = shareError instanceof Error
        ? shareError.message
        : i18nService.t('htmlShareFailed');
      setError(message);
    }
  };

  const getRelatedSessionMenuItems = (item: LibraryItem): CardOverflowMenuItem[] => {
    const detailState = item.itemKind === LibraryItemKind.LocalArtifact
      ? cardDetailStates[item.itemId]
      : undefined;
    const sessions = detailState?.status === CardDetailLoadStatus.Ready
      ? detailState.data.sessions
      : item.latestSession
        ? [item.latestSession]
        : [];
    const uniqueSessions = [...new Map(
      sessions.map(session => [session.sessionId, session]),
    ).values()];
    const menuItems: CardOverflowMenuItem[] = uniqueSessions.map(session => ({
      key: `session:${session.sessionId}`,
      label: session.title,
      onSelect: () => onOpenSession(session),
    }));
    const expectedCount = item.itemKind === LibraryItemKind.LocalArtifact
      ? item.relatedSessionCount
      : uniqueSessions.length;
    if (
      item.itemKind === LibraryItemKind.LocalArtifact
      && detailState?.status !== CardDetailLoadStatus.Ready
      && detailState?.status !== CardDetailLoadStatus.Error
      && expectedCount > uniqueSessions.length
    ) {
      menuItems.push({
        key: 'sessions-loading',
        label: i18nService.t('loading'),
        disabled: true,
      });
    } else if (
      detailState?.status === CardDetailLoadStatus.Ready
      && menuItems.length === 0
    ) {
      menuItems.push({
        key: 'sessions-empty',
        label: i18nService.t('libraryRelatedSessionsUnavailable'),
        disabled: true,
      });
    } else if (
      detailState?.status === CardDetailLoadStatus.Error
      && menuItems.length === 0
    ) {
      menuItems.push({
        key: 'sessions-unavailable',
        label: i18nService.t('libraryRelatedSessionsUnavailable'),
        disabled: true,
      });
    }
    return menuItems;
  };

  const getCardActionLabel = (
    item: LibraryItem,
    action: LibraryItemActionValue,
  ): string => {
    if (action === LibraryItemAction.ToggleFavorite) {
      return item.isFavorite
        ? i18nService.t('libraryRemoveFavorite')
        : i18nService.t('libraryAddFavorite');
    }
    if (action === LibraryItemAction.ShareLocal) return i18nService.t('htmlShare');
    if (action === LibraryItemAction.OpenWithApp) return i18nService.t('libraryOpenWithApp');
    if (action === LibraryItemAction.RevealLocal) return i18nService.t('libraryRevealFile');
    if (action === LibraryItemAction.CopyLink) return i18nService.t('libraryCopyLink');
    if (action === LibraryItemAction.ManageSite) return i18nService.t('libraryManageSite');
    if (action === LibraryItemAction.RelatedSessions) {
      return i18nService.t('libraryRelatedSessions');
    }
    return i18nService.t('libraryOpenLink');
  };

  const getCardActionIcon = (
    item: LibraryItem,
    action: LibraryItemActionValue,
  ): React.ReactNode => {
    if (action === LibraryItemAction.ToggleFavorite) {
      return item.isFavorite
        ? <StarSolidIcon className="h-4 w-4 text-amber-500" />
        : <StarIcon className="h-4 w-4" />;
    }
    if (action === LibraryItemAction.ShareLocal) return <ShareUploadIcon className="h-4 w-4" />;
    if (action === LibraryItemAction.RelatedSessions) {
      return <ChatBubbleLeftRightIcon className="h-4 w-4" />;
    }
    if (action === LibraryItemAction.RevealLocal) return <FolderIcon className="h-4 w-4" />;
    if (action === LibraryItemAction.CopyLink) {
      return <ClipboardDocumentIcon className="h-4 w-4" />;
    }
    if (action === LibraryItemAction.ManageSite) return <GlobeAltIcon className="h-4 w-4" />;
    return <ArrowTopRightOnSquareIcon className="h-4 w-4" />;
  };

  const buildCardMenuItems = (item: LibraryItem): CardOverflowMenuItem[] => (
    getLibraryCardActionIds(item).map(action => ({
      key: action,
      label: getCardActionLabel(item, action),
      icon: getCardActionIcon(item, action),
      disabled: action === LibraryItemAction.ShareLocal
        && item.itemKind === LibraryItemKind.LocalArtifact
        && !canShareLibraryArtifact(item),
      ...(action === LibraryItemAction.RelatedSessions
        ? {
            children: getRelatedSessionMenuItems(item),
            trailing: (
              <span className="text-tertiary">
                {item.itemKind === LibraryItemKind.LocalArtifact
                  ? item.relatedSessionCount
                  : item.latestSession ? 1 : 0}
              </span>
            ),
          }
        : {}),
      onSelect: () => {
        if (action === LibraryItemAction.ToggleFavorite) {
          void updateFavorite(item);
          return;
        }
        if (item.itemKind === LibraryItemKind.LocalArtifact) {
          if (action === LibraryItemAction.ShareLocal) void shareLocalItem(item);
          else if (action === LibraryItemAction.OpenWithApp) openLocalWithApp(item);
          else if (action === LibraryItemAction.RevealLocal) revealLocal(item);
          return;
        }
        if (action === LibraryItemAction.OpenLink) openCloudLink(item);
        else if (action === LibraryItemAction.CopyLink) copyValue(item.url);
      },
    }))
  );

  const hasMore = hasResolvedCurrentQuery && (
    (wantsLocalGrid ? taskGrid.hasMoreTasks : wantsLocal && localData.hasMore)
    || (wantsCloud && visibleCloudData.hasMore)
  );

  useEffect(() => {
    const root = scrollContainerRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (
      !root
      || !sentinel
      || isBusy
      || !hasMore
      || localDisplayError
      || cloudError
      || (wantsLocal && (restoration || !appendArmed))
      || (wantsLocalGrid && !taskGrid.cursorValid)
      || (wantsLocalList && (!localCursorValidRef.current || localDirtyRef.current))
      || typeof IntersectionObserver === 'undefined'
    ) {
      return undefined;
    }

    let requested = false;
    const observer = new IntersectionObserver(entries => {
      if (requested || !entries.some(entry => entry.isIntersecting)) return;
      if (wantsLocal && !isAppendArmed()) return;
      if (wantsLocalList && (!localCursorValidRef.current || localDirtyRef.current)) return;
      requested = true;
      observer.disconnect();
      if (wantsLocalGrid) void loadMoreTasks();
      else void loadData(LibraryLoadIntent.Append, LibraryLoadCause.Append);
    }, {
      root,
      rootMargin: '0px 0px 320px 0px',
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [appendArmed, cloudError, localDisplayError, hasMore, isBusy, isAppendArmed, loadData, restoration, taskGrid.cursorValid, loadMoreTasks, wantsLocal, wantsLocalGrid, wantsLocalList]);

  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';

  return (
    <div
      data-skin-management-page="true"
      className="relative z-10 flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <div className="draggable flex h-12 shrink-0 items-center border-b border-border px-4">
        {isSidebarCollapsed && !isWindows && (
          <div className={`non-draggable mr-2 flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
            <button type="button" onClick={onToggleSidebar} aria-label={i18nService.t('expand')} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised">
              <SidebarToggleIcon className="h-4 w-4" isCollapsed />
            </button>
            {updateBadge}
          </div>
        )}
        <div
          role="tablist"
          aria-label={i18nService.t('libraryTitle')}
          className="non-draggable flex items-center gap-1"
        >
          {SOURCE_FILTERS.map(value => (
            <SourceTab
              key={value}
              source={value}
              active={source === value}
              loading={source === value && loadingFeedback.showSourceActivity}
              announceLoading={loadingFeedback.showLongWaitLabel}
              onClick={() => handleSourceChange(value)}
            />
          ))}
        </div>
      </div>

      <main
        ref={scrollContainerRef}
        aria-busy={loadingFeedback.ariaBusy}
        className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]"
      >
          {wantsCloud ? (
            <LibraryCloudView
              analyticsPageViewId={analyticsPageViewId}
              data={visibleCloudData}
              loadingFeedback={loadingFeedback}
              hasResolvedSnapshot={activeCloudResolvedQuery !== undefined}
              loadingMore={loadingMore}
              error={cloudError && activeCloudResolvedQuery
                ? i18nService.t('libraryResultsNotUpdated').replace('{message}', cloudError)
                : cloudError}
              isAuthenticated={isAuthenticated}
              ownerAccountKey={ownerAccountKey}
              subscriptionStatus={subscriptionStatus}
              showFreeShareDeleteQuotaNotice={showFreeShareDeleteQuotaNotice}
              category={category}
              status={cloudAvailability}
              displayStatus={cloudDisplayAvailability}
              favoritesOnly={favoritesOnly}
              keywordInput={keywordInput}
              loadMoreSentinelRef={loadMoreSentinelRef}
              onCategoryChange={handleCategoryChange}
              onStatusChange={handleAvailabilityChange}
              onToggleFavoritesOnly={handleFavoritesOnlyToggle}
              onKeywordInputChange={setKeywordInput}
              onKeywordClear={clearKeyword}
              onRefresh={handleRefresh}
              onDetailOpen={handleCloudDetailOpen}
              onOpenSession={onOpenSession}
              onItemUpdated={updateCloudItem}
              onItemDeleted={deleteCloudItem}
              onToggleFavorite={item => void updateFavorite(item)}
              hideSites={sitesHidden}
              sitesReadOnly={sitesReadOnly}
            />
          ) : (
        <div className="mx-auto w-full max-w-[1120px] px-4 py-6 sm:px-8">
          <div
            data-skin-management-toolbar="true"
            className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-border bg-background pb-3 pt-1"
          >
            <LibraryCategoryDropdown
              value={category}
              options={CATEGORY_FILTERS}
              onChange={handleCategoryChange}
              grouped
            />
            <LibraryToolbarLoadingStatus presentation={loadingFeedback} />
            <div className="ml-auto flex min-w-0 flex-[1_1_240px] items-center justify-end gap-2">
              <div className="relative min-w-[96px] max-w-56 flex-1">
                <div className="pointer-events-none absolute left-3 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center">
                  {loadingFeedback.showSearchActivity ? (
                    <LibraryLoadingIndicator
                      label={i18nService.t('librarySearching')}
                    />
                  ) : (
                    <MagnifyingGlassIcon className="h-4 w-4 text-tertiary" />
                  )}
                </div>
                <input
                  ref={localSearchInputRef}
                  value={keywordInput}
                  onChange={event => setKeywordInput(event.target.value)}
                  placeholder={i18nService.t('librarySearchPlaceholder')}
                  className="h-9 w-full rounded-xl border border-border bg-surface pl-9 pr-9 text-xs text-foreground outline-none placeholder:text-tertiary focus:ring-2 focus:ring-primary/30"
                />
                {keywordInput.length > 0 && (
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
                    <Tooltip
                      content={i18nService.t('libraryClearSearch')}
                      position={TooltipPosition.Bottom}
                      align={TooltipAlign.End}
                      delay={250}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          clearKeyword();
                          localSearchInputRef.current?.focus();
                        }}
                        aria-label={i18nService.t('libraryClearSearch')}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-tertiary hover:bg-surface-raised hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                      >
                        <XMarkIcon className="h-4 w-4" />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
              <Tooltip
                content={i18nService.t('libraryFavorites')}
                position={TooltipPosition.Bottom}
                delay={250}
              >
                <button type="button" onClick={handleFavoritesOnlyToggle} aria-pressed={favoritesOnly} aria-label={i18nService.t('libraryFavorites')} className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border ${favoritesOnly ? 'bg-amber-500/10 text-amber-500' : 'text-secondary hover:bg-surface-raised'}`}>
                  {favoritesOnly ? <StarSolidIcon className="h-4 w-4" /> : <StarIcon className="h-4 w-4" />}
                </button>
              </Tooltip>
              <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
                <Tooltip
                  content={i18nService.t('libraryGridView')}
                  position={TooltipPosition.Bottom}
                  delay={250}
                >
                  <button type="button" onClick={() => handleViewModeChange(LibraryViewMode.Grid)} aria-label={i18nService.t('libraryGridView')} className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${viewMode === LibraryViewMode.Grid ? 'bg-surface-raised text-foreground' : 'text-secondary'}`}><Squares2X2Icon className="h-4 w-4" /></button>
                </Tooltip>
                <Tooltip
                  content={i18nService.t('libraryListView')}
                  position={TooltipPosition.Bottom}
                  align={TooltipAlign.End}
                  delay={250}
                >
                  <button type="button" onClick={() => handleViewModeChange(LibraryViewMode.List)} aria-label={i18nService.t('libraryListView')} className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${viewMode === LibraryViewMode.List ? 'bg-surface-raised text-foreground' : 'text-secondary'}`}><ListBulletIcon className="h-4 w-4" /></button>
                </Tooltip>
              </div>
            </div>
          </div>

          {localDisplayError && (
            <div className="mt-4 flex items-center justify-between rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span>{hasResolvedSnapshot
                ? i18nService.t('libraryResultsNotUpdated').replace('{message}', localDisplayError)
                : localDisplayError}</span>
              <button type="button" onClick={handleRefresh} className="ml-3 inline-flex items-center gap-1"><ArrowPathIcon className="h-3.5 w-3.5" />{i18nService.t('retry')}</button>
            </div>
          )}

          {localDisplayNotice && !localDisplayError && (
            <p role="status" className="mt-4 text-xs text-secondary">{localDisplayNotice}</p>
          )}

          {!isAuthenticated && wantsCloud && (
            <div className="mt-4 rounded-xl border border-border bg-surface px-4 py-3 text-xs">
              <span className="text-secondary">{i18nService.t('libraryLoginForCloud')}</span>
            </div>
          )}

          <div>
            {loadingFeedback.initialPending ? (
              loading ? (
                <div className={viewMode === LibraryViewMode.List
                  ? 'mt-6 divide-y divide-border border-y border-border'
                  : `mt-6 ${LIBRARY_GRID_CLASSNAME}`}
                style={viewMode === LibraryViewMode.Grid ? LIBRARY_GRID_STYLE : undefined}>
                  {Array.from({ length: 6 }, (_, index) => (
                    <div key={index} className={viewMode === LibraryViewMode.List
                      ? 'h-14 bg-surface-raised/40 motion-safe:animate-pulse'
                      : 'rounded-xl border border-border bg-surface p-2.5 motion-safe:animate-pulse'}>
                      {viewMode === LibraryViewMode.Grid && (
                        <>
                          <div className="aspect-video rounded-lg bg-surface-raised" />
                          <div className="mt-2 h-4 w-3/4 rounded bg-surface-raised" />
                          <div className="mt-2 h-3 w-1/2 rounded bg-surface-raised" />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div aria-hidden="true" className="mt-6 min-h-96" />
              )
            ) : localDisplayError && !hasResolvedSnapshot ? (
              <div aria-hidden="true" className="mt-6 min-h-64" />
            ) : dateGroups.length === 0 ? (
              <div className="mt-12 rounded-2xl border border-dashed border-border py-16 text-center">
                <DocumentIcon className="mx-auto h-8 w-8 text-tertiary" />
                <h2 className={`${MANAGEMENT_TITLE_TEXT} mt-3 font-semibold text-foreground`}>
                  {i18nService.t(hasActiveLocalFilter
                    ? 'libraryEmptyTitle'
                    : 'libraryLocalEmptyTitle')}
                </h2>
                <p className={`${MANAGEMENT_BODY_TEXT} mt-1 leading-[var(--lobster-leading-sm)] text-secondary`}>
                  {i18nService.t(hasActiveLocalFilter
                    ? 'libraryEmptyDescription'
                    : 'libraryLocalEmptyDescription')}
                </p>
              </div>
            ) : (
              <LibraryVirtualizedGroups
                dateGroups={dateGroups}
                viewMode={viewMode}
                scrollContainerRef={scrollContainerRef}
                restoration={restoration}
                onRestored={finishScrollRestoration}
                onOpenSession={onOpenSession}
                formatSessionTime={formatLibrarySessionTime}
                renderItem={item => (
                  <LibraryItemCard
                    key={`${item.itemKind}:${item.itemId}`}
                    item={item}
                    viewMode={viewMode}
                    onOpen={() => openItem(item)}
                    onMenuOpen={item.itemKind === LibraryItemKind.LocalArtifact
                      && getLibraryCardActionIds(item).includes(
                        LibraryItemAction.RelatedSessions,
                      )
                      ? () => loadCardDetail(item)
                      : undefined}
                    menuItems={buildCardMenuItems(item)}
                  />
                )}
              />
            )}
            {!loadingFeedback.initialPending && hasMore && (
              <div
                ref={loadMoreSentinelRef}
                className="flex h-14 items-center justify-center"
                aria-live="polite"
              >
                {loadingMore && (
                  <>
                    <ArrowPathIcon className="h-4 w-4 text-tertiary motion-safe:animate-spin" aria-hidden="true" />
                    <span className="sr-only">{i18nService.t('loading')}</span>
                  </>
                )}
                {!loadingMore && wantsLocalGrid && (
                  <button type="button" onClick={() => { void loadMoreTasks(); }}
                    disabled={!taskGrid.cursorValid || isBusy || Boolean(restoration)}
                    className="rounded-lg px-3 py-1 text-xs text-secondary hover:bg-surface-raised disabled:opacity-50">
                    {i18nService.t('libraryLoadMore')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
          )}
      </main>

      {wantsLocal && activeItem && (
        <LibraryPreviewModal
          item={activeItem}
          analyticsPageViewId={analyticsPageViewId}
          detail={localDetail}
          detailLoading={detailLoading}
          onClose={() => setActiveItem(undefined)}
          onToggleFavorite={() => void updateFavorite(activeItem)}
          onOpenWithApp={() => {
            if (activeItem.itemKind === LibraryItemKind.LocalArtifact) {
              openLocalWithApp(activeItem);
            }
          }}
          onReveal={() => {
            if (activeItem.itemKind === LibraryItemKind.LocalArtifact) {
              revealLocal(activeItem);
            }
          }}
          onOpenLink={() => {
            if (activeItem.itemKind !== LibraryItemKind.LocalArtifact) {
              openCloudLink(activeItem);
            }
          }}
          onCopyLink={() => {
            if (activeItem.itemKind !== LibraryItemKind.LocalArtifact) {
              copyValue(activeItem.url);
            }
          }}
          onOpenSession={session => {
            setActiveItem(undefined);
            onOpenSession(session);
          }}
          onShowSites={() => undefined}
        />
      )}
    </div>
  );
};

const LibraryView: React.FC<LibraryViewProps> = props => (
  <ArtifactFileShareProvider sessionId="library">
    <LibraryViewContent {...props} />
  </ArtifactFileShareProvider>
);

export default LibraryView;
