import {
  LibraryChangeReason,
  LibraryErrorCode,
  LibraryGridLimits,
  LibraryIpc,
  LibraryItemKind,
} from '../../../shared/library/constants';
import { getLibraryGridQueryKey } from '../../../shared/library/gridOrdering';
import { LibraryLocalDataError } from '../../../shared/library/localOrdering';
import type {
  LibraryChangedPayload,
  LibraryLocalCounts,
  LibraryLocalTaskFilters,
  LibraryLocalTaskGroup,
  LibraryLocalTaskGroupsData,
  LibraryLocalTaskGroupsOptions,
  LibraryLocalTaskItemsData,
  LibraryLocalTaskItemsOptions,
  LibraryResult,
  LocalArtifactItem,
} from '../../../shared/library/types';
import { LibraryRefreshCoordinator, LibraryRefreshOutcome } from './libraryRefreshCoordinator';
import {
  appendLibraryTaskGroups,
  appendLibraryTaskItems,
  libraryGridDrift,
  validateLibraryTaskExpansion,
  validateLibraryTaskGroups,
  validateLibraryTaskItems,
} from './libraryTaskGridValidation';

export const LibraryTaskGridRefreshLimits = {
  AutomaticReadBudgetMs: 2_000,
  AnchorExtraTaskPages: 2,
} as const;

export interface LibraryTaskGridApi {
  listLocalTaskGroups(options: LibraryLocalTaskGroupsOptions): Promise<LibraryResult<LibraryLocalTaskGroupsData>>;
  listLocalTaskItems(options: LibraryLocalTaskItemsOptions): Promise<LibraryResult<LibraryLocalTaskItemsData>>;
}

export interface LibraryTaskGridOptions extends LibraryLocalTaskFilters {
  active: boolean;
  onBeforeLayoutChange?: (sessionId?: string, collapse?: boolean, manual?: boolean) => unknown;
  onAfterLayoutChange?: (anchor: unknown, isCurrent: () => boolean) => void;
  getAnchorSessionIds?: () => string[];
}

export interface LibraryTaskGridGroup extends LibraryLocalTaskGroup {
  items: LocalArtifactItem[];
  expanded: boolean;
  loading: boolean;
  error?: string;
  canLoadMoreItems: boolean;
}

export interface LibraryTaskGridSnapshot {
  groups: LibraryTaskGridGroup[];
  counts: LibraryLocalCounts;
  hasMoreTasks: boolean;
  canLoadMoreTasks: boolean;
  cursorValid: boolean;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  hasResolvedSnapshot: boolean;
  hasResolvedCurrentQuery: boolean;
  error?: string;
  errorCode?: LibraryErrorCode;
  needsManualRefresh: boolean;
  activityId: number;
  dataRevision: number;
}

interface Expansion {
  depth: number;
  data?: LibraryLocalTaskItemsData;
  loading: boolean;
  error?: string;
  requestId: number;
}

class GridReadBudgetExceeded extends Error {}
class GridReadCancelled extends Error {}

const unwrap = <T>(response: LibraryResult<T>): T => {
  if (!response.success) throw new LibraryLocalDataError(response.code, response.error);
  return response.data;
};

const invokeGrid = async <T>(request: Promise<LibraryResult<T>>): Promise<T> => {
  try {
    return unwrap(await request);
  } catch (error) {
    if (error instanceof Error && /No handler registered for/.test(error.message)
      && [LibraryIpc.ListLocalTaskGroups, LibraryIpc.ListLocalTaskItems].some(channel => error.message.includes(channel))) {
      throw new LibraryLocalDataError(LibraryErrorCode.ProtocolMismatch, 'The task grid IPC is not supported.');
    }
    throw error;
  }
};

/**
 * Task and item pagination are deliberately separate. Only complete, validated
 * snapshots replace the current window; hidden items never advance task paging.
 */
export class LibraryTaskGridController {
  private options: LibraryTaskGridOptions = { active: false };
  private query: LibraryLocalTaskFilters = {};
  private queryKey = '';
  private contextGeneration = 0;
  private dataEpoch = 0;
  private intentVersion = 0;
  private requestSequence = 0;
  private expansions = new Map<string, Expansion>();
  private data?: LibraryLocalTaskGroupsData;
  private taskDepth: number = LibraryGridLimits.DefaultTaskPageSize;
  private dirty = true;
  private resolved = false;
  private loading = false;
  private loadingMore = false;
  private refreshing = false;
  private manualPending = false;
  private error?: string;
  private errorCode?: LibraryErrorCode;
  private needsManualRefresh = false;
  private activityId = 0;
  private dataRevision = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  private coordinator: LibraryRefreshCoordinator;
  private snapshot: LibraryTaskGridSnapshot;

  constructor(private readonly api: () => LibraryTaskGridApi | undefined, private readonly now = Date.now) {
    this.coordinator = this.createCoordinator();
    this.snapshot = this.buildSnapshot();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): LibraryTaskGridSnapshot => this.snapshot;

  configure(options: LibraryTaskGridOptions): void {
    if (this.disposed) return;
    const queryKey = getLibraryGridQueryKey(options);
    const queryChanged = queryKey !== this.queryKey;
    const visibilityChanged = options.active !== this.options.active;
    this.options = options;
    this.query = { category: options.category, keyword: options.keyword, favoritesOnly: options.favoritesOnly };
    if (queryChanged || visibilityChanged) {
      this.contextGeneration += 1;
      this.loadingMore = false;
      this.loading = false;
      this.refreshing = false;
      for (const expansion of this.expansions.values()) {
        if (expansion.loading) this.dirty = true;
        expansion.loading = false;
        expansion.requestId = ++this.requestSequence;
      }
      // An old query/view request must not hold the next query's coordinator open.
      this.coordinator.dispose();
      this.coordinator = this.createCoordinator();
    }
    if (queryChanged) {
      this.queryKey = queryKey;
      this.data = undefined;
      this.expansions.clear();
      this.taskDepth = LibraryGridLimits.DefaultTaskPageSize;
      this.dirty = true;
      this.resolved = false;
      this.error = undefined;
      this.errorCode = undefined;
      this.needsManualRefresh = false;
      this.manualPending = false;
    }
    this.coordinator.setActive(options.active);
    if (options.active && (queryChanged || visibilityChanged) && this.dirty) {
      this.coordinator.enqueue({ reason: LibraryChangeReason.Repair });
      this.coordinator.flushNow();
    }
    if (queryChanged || visibilityChanged) this.emit();
  }

  readonly invalidate = (payload: LibraryChangedPayload = { reason: LibraryChangeReason.Repair }): void => {
    if (this.disposed || (payload.itemKind && payload.itemKind !== LibraryItemKind.LocalArtifact)) return;
    this.dataEpoch += 1;
    this.dirty = true;
    this.loadingMore = false;
    if (payload.reason === LibraryChangeReason.SessionDeleted) {
      for (const sessionId of payload.sessionIds ?? []) this.expansions.delete(sessionId);
    }
    for (const expansion of this.expansions.values()) {
      expansion.loading = false;
      expansion.requestId = ++this.requestSequence;
    }
    this.emit();
    this.coordinator.enqueue(payload);
  };

  readonly refresh = (options: { manual?: boolean } = {}): void => {
    if (this.disposed) return;
    this.coordinator.resetPending();
    this.manualPending = options.manual === true;
    this.needsManualRefresh = false;
    this.error = undefined;
    this.errorCode = undefined;
    this.invalidate();
    this.coordinator.flushNow();
  };

  readonly loadMoreTasks = async (): Promise<void> => {
    if (!this.snapshot.canLoadMoreTasks || !this.data) return;
    const current = this.data;
    const contextGuard = this.createGuard();
    const intentVersion = this.intentVersion;
    const guard = (): boolean => contextGuard() && intentVersion === this.intentVersion;
    this.loadingMore = true;
    this.activityId += 1;
    this.emit();
    try {
      const page = await this.readGroups({
        ...this.query, taskCursor: current.nextTaskCursor, taskPageSize: LibraryGridLimits.DefaultTaskPageSize,
      });
      if (!guard()) return;
      const next = appendLibraryTaskGroups(current, page);
      const expansions = new Map(this.expansions);
      const startedAt = this.now();
      for (const group of page.groups) {
        const expansion = expansions.get(group.session.sessionId);
        if (expansion) {
          const data = await this.readExpandedPrefix(group, expansion.depth, guard, startedAt);
          expansions.set(group.session.sessionId, { ...expansion, data, loading: false, error: undefined });
        }
      }
      if (!guard()) return;
      this.commit(() => {
        this.data = next;
        this.dataRevision += 1;
        this.expansions = expansions;
        this.taskDepth = next.groups.length;
        this.loadingMore = false;
      }, guard);
    } catch (error) {
      if (!guard()) return;
      this.loadingMore = false;
      this.handleReadFailure(error);
    } finally {
      if (contextGuard() && this.loadingMore) {
        this.loadingMore = false;
        this.emit();
      }
    }
  };

  readonly expand = (sessionId: string): Promise<void> => this.loadTaskItems(sessionId);
  readonly loadMoreItems = (sessionId: string): Promise<void> => this.loadTaskItems(sessionId);

  readonly collapse = (sessionId: string): void => {
    if (!this.expansions.has(sessionId)) return;
    this.intentVersion += 1;
    const guard = this.createGuard();
    this.commit(() => this.expansions.delete(sessionId), guard, sessionId, true);
  };

  dispose(): void {
    this.disposed = true;
    this.contextGeneration += 1;
    this.coordinator.dispose();
    this.listeners.clear();
  }

  private createCoordinator(): LibraryRefreshCoordinator {
    return new LibraryRefreshCoordinator({ onFlush: batch => this.readWindow(batch.immediateRetryAvailable) });
  }

  private createGuard(): () => boolean {
    const generation = this.contextGeneration;
    const epoch = this.dataEpoch;
    return () => !this.disposed && this.options.active
      && generation === this.contextGeneration && epoch === this.dataEpoch;
  }

  private requireApi(): LibraryTaskGridApi {
    const api = this.api();
    if (!api || typeof api.listLocalTaskGroups !== 'function' || typeof api.listLocalTaskItems !== 'function') {
      throw new LibraryLocalDataError(LibraryErrorCode.ProtocolMismatch, 'The task grid API is not supported.');
    }
    return api;
  }

  private async readGroups(options: LibraryLocalTaskGroupsOptions): Promise<LibraryLocalTaskGroupsData> {
    return validateLibraryTaskGroups(await invokeGrid(this.requireApi().listLocalTaskGroups(options)), options);
  }

  private async readItems(options: LibraryLocalTaskItemsOptions): Promise<LibraryLocalTaskItemsData> {
    return validateLibraryTaskItems(await invokeGrid(this.requireApi().listLocalTaskItems(options)), options);
  }

  private checkBudget(guard: () => boolean, startedAt?: number): void {
    if (!guard()) throw new GridReadCancelled();
    if (startedAt !== undefined && this.now() - startedAt >= LibraryTaskGridRefreshLimits.AutomaticReadBudgetMs) {
      throw new GridReadBudgetExceeded();
    }
  }

  private async readExpandedPrefix(
    group: LibraryLocalTaskGroup,
    depth: number,
    guard: () => boolean,
    startedAt: number | undefined,
  ): Promise<LibraryLocalTaskItemsData> {
    let data: LibraryLocalTaskItemsData | undefined;
    do {
      this.checkBudget(guard, startedAt);
      const page = await this.readItems({
        ...this.query,
        sessionId: group.session.sessionId,
        itemCursor: data?.nextItemCursor,
        pageSize: Math.min(LibraryGridLimits.MaxItemPageSize, depth - (data?.items.length ?? 0)),
      });
      this.checkBudget(guard, startedAt);
      data = data ? appendLibraryTaskItems(data, page) : page;
      validateLibraryTaskExpansion(group, data);
    } while (data.hasMoreItems && data.items.length < depth);
    return data;
  }

  private async readWindow(immediateRetryAvailable: boolean): Promise<LibraryRefreshOutcome> {
    if (!this.options.active || this.disposed) return LibraryRefreshOutcome.Stopped;
    const contextGuard = this.createGuard();
    const intentVersion = this.intentVersion;
    const guard = (): boolean => contextGuard() && intentVersion === this.intentVersion;
    const manual = this.manualPending;
    const firstSnapshot = !this.data;
    const baseline = manual ? LibraryGridLimits.DefaultTaskPageSize : this.taskDepth;
    const oldExpansions = manual ? new Map<string, Expansion>() : new Map(this.expansions);
    this.loading = !this.data;
    this.refreshing = Boolean(this.data);
    if (this.loading || manual) this.activityId += 1;
    this.emit();
    // Initial/manual reads already have a fixed one-task-page scope. A slow
    // successful IPC must still display; only automatic window rebuilds expire.
    const startedAt = manual || firstSnapshot ? undefined : this.now();
    let candidate: LibraryLocalTaskGroupsData | undefined;
    let extraPages = 0;
    try {
      while (true) {
        this.checkBudget(guard, startedAt);
        const baseComplete = Boolean(candidate && (candidate.groups.length >= baseline || !candidate.hasMoreTasks));
        if (baseComplete) {
          const primary = manual || firstSnapshot ? undefined : this.options.getAnchorSessionIds?.()[0];
          if (!candidate?.hasMoreTasks || !primary
            || candidate.groups.some(group => group.session.sessionId === primary)
            || extraPages >= LibraryTaskGridRefreshLimits.AnchorExtraTaskPages) break;
          extraPages += 1;
        }
        const page = await this.readGroups({
          ...this.query,
          taskCursor: candidate?.nextTaskCursor,
          taskPageSize: baseComplete ? LibraryGridLimits.DefaultTaskPageSize : Math.min(
            LibraryGridLimits.MaxTaskPageSize, baseline - (candidate?.groups.length ?? 0),
          ),
        });
        this.checkBudget(guard, startedAt);
        candidate = candidate ? appendLibraryTaskGroups(candidate, page) : page;
      }
      if (!candidate) throw new Error('The task grid did not return a page.');
      const expansions = new Map(oldExpansions);
      for (const group of candidate.groups) {
        const old = oldExpansions.get(group.session.sessionId);
        if (old) {
          const data = await this.readExpandedPrefix(group, old.depth, guard, startedAt);
          expansions.set(group.session.sessionId, { ...old, data, loading: false, error: undefined });
        }
      }
      this.checkBudget(guard, startedAt);
      const completed = candidate;
      this.commit(() => {
        this.data = completed;
        this.dataRevision += 1;
        this.expansions = expansions;
        this.taskDepth = Math.max(LibraryGridLimits.DefaultTaskPageSize, completed.groups.length);
        this.dirty = false;
        this.resolved = true;
        this.loading = false;
        this.refreshing = false;
        this.error = undefined;
        this.errorCode = undefined;
        this.needsManualRefresh = false;
        this.manualPending = false;
      }, guard, undefined, false, manual || firstSnapshot);
      return LibraryRefreshOutcome.Committed;
    } catch (error) {
      if (!contextGuard() || error instanceof GridReadCancelled || intentVersion !== this.intentVersion) {
        return LibraryRefreshOutcome.Invalidated;
      }
      this.loading = false;
      this.refreshing = false;
      if (error instanceof LibraryLocalDataError && error.code === LibraryErrorCode.InvalidCursor) {
        // Stable cursor/data contradictions are not a reason to poll forever.
        // Only cancellation by actual epoch/intent changes above uses quiet retries.
        if (!immediateRetryAvailable) {
          this.recordFailure(error);
          return LibraryRefreshOutcome.Stopped;
        }
        this.dirty = true;
        this.emit();
        return LibraryRefreshOutcome.Invalidated;
      }
      this.recordFailure(error);
      return LibraryRefreshOutcome.Stopped;
    }
  }

  private async loadTaskItems(sessionId: string): Promise<void> {
    const group = this.data?.groups.find(value => value.session.sessionId === sessionId);
    const previous = this.expansions.get(sessionId);
    if (!group || !this.options.active || this.dirty || this.refreshing || previous?.loading
      || (previous?.data && !previous.data.hasMoreItems) || group.matchedFileCount <= LibraryGridLimits.PreviewCount) return;
    const requestId = ++this.requestSequence;
    const expansion: Expansion = {
      depth: previous?.depth ?? LibraryGridLimits.ItemPageSize,
      data: previous?.data,
      loading: true,
      requestId,
    };
    this.intentVersion += 1;
    const contextGuard = this.createGuard();
    const guard = (): boolean => contextGuard() && this.expansions.get(sessionId)?.requestId === requestId;
    this.commit(() => this.expansions.set(sessionId, expansion), contextGuard, sessionId);
    try {
      const page = await this.readItems({
        ...this.query, sessionId,
        itemCursor: previous?.data?.nextItemCursor,
        pageSize: LibraryGridLimits.ItemPageSize,
      });
      if (!guard()) return;
      const data = previous?.data ? appendLibraryTaskItems(previous.data, page) : page;
      validateLibraryTaskExpansion(group, data);
      // Another operation may have refreshed this summary while this item read was outstanding.
      const latest = this.data?.groups.find(value => value.session.sessionId === sessionId);
      if (!latest) return libraryGridDrift();
      validateLibraryTaskExpansion(latest, data);
      this.commit(() => {
        this.dataRevision += 1;
        this.expansions.set(sessionId, { data, depth: data.items.length, loading: false, requestId });
      }, guard, sessionId);
    } catch (error) {
      if (!guard()) return;
      expansion.loading = false;
      if (error instanceof LibraryLocalDataError && (error.code === LibraryErrorCode.InvalidCursor
        || error.code === LibraryErrorCode.NotFound)) {
        this.handleReadFailure(error);
      } else {
        expansion.error = error instanceof Error ? error.message : 'Task files could not be loaded.';
        if (error instanceof LibraryLocalDataError && error.code === LibraryErrorCode.ProtocolMismatch) {
          this.recordFailure(error);
        } else this.emit();
      }
    }
  }

  private handleReadFailure(error: unknown): void {
    if (error instanceof LibraryLocalDataError && (error.code === LibraryErrorCode.InvalidCursor
      || error.code === LibraryErrorCode.NotFound) && this.coordinator.consumeImmediateRetry()) {
      // The fresh authoritative read is the retry for this failed foreground
      // request; it must not receive a second immediate-retry allowance.
      this.invalidate();
      this.coordinator.flushNow();
    } else this.recordFailure(error);
  }

  private recordFailure(error: unknown): void {
    this.dirty = true;
    this.manualPending = false;
    this.needsManualRefresh = error instanceof GridReadBudgetExceeded || Boolean(this.data);
    this.errorCode = error instanceof LibraryLocalDataError ? error.code : LibraryErrorCode.Internal;
    this.error = error instanceof Error ? error.message : 'The task grid could not be loaded.';
    this.emit();
  }

  private commit(
    update: () => void,
    isCurrent: () => boolean,
    sessionId?: string,
    collapse = false,
    manual = false,
  ): void {
    if (!isCurrent()) return;
    const anchor = this.options.onBeforeLayoutChange?.(sessionId, collapse, manual);
    update();
    this.emit();
    this.options.onAfterLayoutChange?.(anchor, isCurrent);
  }

  private buildSnapshot(): LibraryTaskGridSnapshot {
    const cursorValid = !this.dirty && Boolean(this.data);
    return {
      groups: this.data?.groups.map(group => {
        const expansion = this.expansions.get(group.session.sessionId);
        return {
          ...group,
          items: expansion?.data?.items ?? group.previewItems,
          expanded: Boolean(expansion),
          loading: expansion?.loading ?? false,
          error: expansion?.error,
          canLoadMoreItems: cursorValid && !this.refreshing && !expansion?.loading
            && (expansion?.data?.hasMoreItems ?? group.matchedFileCount > LibraryGridLimits.PreviewCount),
        };
      }) ?? [],
      counts: this.data?.counts ?? { total: 0, available: 0, missing: 0 },
      hasMoreTasks: this.data?.hasMoreTasks ?? false,
      canLoadMoreTasks: this.options.active && cursorValid && Boolean(this.data?.hasMoreTasks)
        && !this.loading && !this.loadingMore && !this.refreshing,
      cursorValid,
      loading: this.loading,
      loadingMore: this.loadingMore,
      refreshing: this.refreshing,
      hasResolvedSnapshot: Boolean(this.data),
      hasResolvedCurrentQuery: this.resolved,
      error: this.error,
      errorCode: this.errorCode,
      needsManualRefresh: this.needsManualRefresh,
      activityId: this.activityId,
      dataRevision: this.dataRevision,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }
}
