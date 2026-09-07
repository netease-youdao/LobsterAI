import type {
  HtmlShareAccessMode,
  HtmlShareDisabledSource,
  HtmlShareSourceType,
  HtmlShareStatus,
} from '../htmlShare/constants';
import type { PublishingSubscriptionRecoveryMode } from '../publishing/constants';
import type { SiteKind, SiteStatus } from '../site/constants';
import type {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryChangeReason,
  LibraryCloudAvailabilityFilter,
  LibraryCloudKind,
  LibraryCloudUnavailableReason,
  LibraryErrorCode,
  LibraryGridProtocol,
  LibraryIndexPhase,
  LibraryItemKind,
  LibraryLocalProtocol,
  LibraryLocalSort,
  LibraryOrigin,
  LibraryRelationKind,
  LibrarySharedStatusFilter,
  LibrarySort,
} from './constants';

export interface LibrarySuccess<T> {
  success: true;
  data: T;
}

export interface LibraryFailure {
  success: false;
  code: LibraryErrorCode;
  error: string;
}

export type LibraryResult<T> = LibrarySuccess<T> | LibraryFailure;

export interface LibrarySessionRef {
  sessionId: string;
  title: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  lastRelatedAt: number;
  lastMessageId?: string;
  sessionArtifactId?: string;
}

export interface LibraryItemBase {
  itemKind: LibraryItemKind;
  itemId: string;
  title: string;
  category: Exclude<LibraryCategory, 'all'>;
  sortTime: number;
  createdAt: number;
  isFavorite: boolean;
  latestSession?: LibrarySessionRef;
}

export interface LocalArtifactItem extends LibraryItemBase {
  itemKind: 'local_artifact';
  latestSession: LibrarySessionRef;
  filePath: string;
  artifactType: LibraryArtifactType;
  extension: string;
  sizeBytes?: number;
  fileMtimeMs?: number;
  availability: LibraryAvailability;
  origin: LibraryOrigin;
  relatedSessionCount: number;
  clientSourceKey?: string;
}

export interface SharedFileItem extends LibraryItemBase {
  itemKind: 'shared_file';
  shareId: string;
  url: string;
  sourceType: HtmlShareSourceType;
  accessMode: HtmlShareAccessMode;
  status: HtmlShareStatus;
  moderationStatus?: string;
  disabledSource?: HtmlShareDisabledSource | null;
  entryFile?: string;
  totalFiles?: number;
  totalBytes?: number;
  clientSourceKey?: string;
  artifactId?: string;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  updatedAt?: string;
  contentUpdatedAt?: string;
  accessExpiresAt?: number | null;
  effectiveAvailable?: boolean;
  effectiveExpiresAt?: number | null;
  effectiveUnavailableReason?: LibraryCloudUnavailableReason;
  subscriptionRecoveryMode?: PublishingSubscriptionRecoveryMode;
}

export interface DeployedSiteItem extends LibraryItemBase {
  itemKind: 'deployed_site';
  shareId: string;
  url: string;
  siteKind: SiteKind;
  siteStatus: SiteStatus;
  shareStatus: HtmlShareStatus;
  accessMode: HtmlShareAccessMode;
  deploymentId?: string;
  deploymentStatus?: string;
  clientSourceKey?: string;
  artifactId?: string;
  updatedAt?: string;
  accessExpiresAt?: number | null;
  effectiveAvailable?: boolean;
  effectiveExpiresAt?: number | null;
  effectiveUnavailableReason?: LibraryCloudUnavailableReason;
  subscriptionRecoveryMode?: PublishingSubscriptionRecoveryMode;
}

export type LibraryItem = LocalArtifactItem | SharedFileItem | DeployedSiteItem;
export type LibraryCloudItem = SharedFileItem | DeployedSiteItem;

export interface LibraryLocalListOptions {
  category?: LibraryCategory;
  keyword?: string;
  cursor?: string;
  pageSize?: number;
  sort?: LibraryLocalSort;
  favoritesOnly?: boolean;
}

export interface LibraryLocalCounts {
  total: number;
  available: number;
  missing: number;
}

export interface LibraryLocalListData {
  protocolVersion: typeof LibraryLocalProtocol.Version;
  sort: typeof LibraryLocalSort.RecentTask;
  list: LocalArtifactItem[];
  nextCursor?: string;
  hasMore: boolean;
  counts: LibraryLocalCounts;
}

export interface LibraryGetLocalItemsInput {
  itemIds: string[];
}

export interface LibraryLocalTaskFilters {
  category?: LibraryCategory;
  keyword?: string;
  favoritesOnly?: boolean;
}

export interface LibraryLocalTaskGroupsOptions extends LibraryLocalTaskFilters {
  taskCursor?: string;
  taskPageSize?: number;
}

export interface LibraryLocalTaskGroup {
  session: LibrarySessionRef;
  matchedFileCount: number;
  previewItems: LocalArtifactItem[];
}

export interface LibraryLocalTaskGroupsData {
  protocolVersion: typeof LibraryGridProtocol.Version;
  sort: typeof LibraryLocalSort.RecentTask;
  groups: LibraryLocalTaskGroup[];
  nextTaskCursor?: string;
  hasMoreTasks: boolean;
  counts: LibraryLocalCounts;
}

export interface LibraryLocalTaskItemsOptions extends LibraryLocalTaskFilters {
  sessionId: string;
  itemCursor?: string;
  pageSize?: number;
}

export interface LibraryLocalTaskItemsData {
  protocolVersion: typeof LibraryGridProtocol.Version;
  sort: typeof LibraryLocalSort.RecentTask;
  session: LibrarySessionRef;
  matchedFileCount: number;
  items: LocalArtifactItem[];
  nextItemCursor?: string;
  hasMoreItems: boolean;
}

export interface LibraryGetLocalItemsData {
  items: LocalArtifactItem[];
  unavailableItemIds: string[];
}

export interface LibraryCloudListOptions {
  kind?: LibraryCloudKind;
  category?: LibraryCategory;
  keyword?: string;
  cursor?: string;
  pageSize?: number;
  sort?: LibrarySort;
  favoriteOwnerScope?: string;
  favoritesOnly?: boolean;
  availability?: LibraryCloudAvailabilityFilter;
  sharedStatus?: LibrarySharedStatusFilter;
}

export interface LibraryCloudCounts {
  sharedFile: number;
  deployedSite: number;
}

export interface LibrarySharedStatusCounts {
  all: number;
  live: number;
  disabled: number;
}

export interface LibraryCloudListData {
  list: LibraryCloudItem[];
  nextCursor?: string;
  hasMore: boolean;
  counts: LibraryCloudCounts;
  sharedStatusCounts: LibrarySharedStatusCounts;
  serverNow?: number;
  recoveryPending?: boolean;
}

export interface LibraryArtifactCandidate {
  sessionId: string;
  messageId?: string;
  sessionArtifactId?: string;
  filePath: string;
  detectedType: LibraryArtifactType;
  relationKind: LibraryRelationKind;
  relatedAt: number;
  origin?: LibraryOrigin;
}

export interface LibraryRecordCandidatesData {
  recorded: number;
  ignored: number;
}

export interface LibraryAddLocalFilesData {
  items: LocalArtifactItem[];
  ignoredPaths: string[];
}

export interface LibraryFavoriteInput {
  ownerScope: string;
  itemKind: LibraryItemKind;
  itemId: string;
  favorite: boolean;
}

export interface LibraryLocalActionInput {
  itemId: string;
}

export interface LibrarySessionRelation extends LibrarySessionRef {
  relationKind: LibraryRelationKind;
  firstRelatedAt: number;
}

export interface LibraryLocalDetailData {
  item: LocalArtifactItem;
  sessions: LibrarySessionRelation[];
}

export interface LibraryIndexStatus {
  phase: LibraryIndexPhase;
  trackedCount: number;
  availableCount: number;
  missingCount: number;
  watchedDirectoryCount: number;
  watcherDegraded: boolean;
  lastReconcileAt?: number;
  backfillCompletedAt?: number;
}

export interface LibraryBackfillState {
  cursor?: string;
  completedAt?: number;
  policyVersion: number;
}

export interface LibraryChangedPayload {
  reason: LibraryChangeReason;
  itemKind?: LibraryItemKind;
  itemIds?: string[];
  sessionIds?: string[];
}
