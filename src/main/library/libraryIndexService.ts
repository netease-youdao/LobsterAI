import fs from 'fs';
import path from 'path';

import {
  HtmlShareSourceType,
  type HtmlShareSourceType as HtmlShareSourceTypeValue,
} from '../../shared/htmlShare/constants';
import {
  getLibraryArtifactTypeForExtension,
  getLibraryCategoryForExtension,
  LIBRARY_INDEX_POLICY_VERSION,
  LibraryArtifactType,
  LibraryAvailability,
  LibraryChangeReason,
  LibraryIndexPhase,
  LibraryLimits,
  LibraryOrigin,
} from '../../shared/library/constants';
import type {
  LibraryAddLocalFilesData,
  LibraryArtifactCandidate,
  LibraryBackfillState,
  LibraryChangedPayload,
  LibraryIndexStatus,
  LibraryRecordCandidatesData,
  LocalArtifactItem,
} from '../../shared/library/types';
import {
  buildArtifactFileClientSourceKey,
  buildHtmlShareClientSourceKey,
} from '../libs/htmlShare/htmlShareSourceKey';
import type { SessionProjectionChanges } from '../libs/sessionProjectionNotifications';
import {
  type LibraryIndexedFile,
  LibraryLocalStore,
} from './libraryLocalStore';

interface DirectoryWatchEntry {
  watcher: fs.FSWatcher;
  itemsByBaseName: Map<string, Set<string>>;
}

interface LibraryIndexServiceOptions {
  store: LibraryLocalStore;
  userDataPath: string;
  onChanged: (payload: LibraryChangedPayload) => void;
  getMetadata: <T>(key: string) => T | undefined;
  setMetadata: <T>(key: string, value: T) => void;
}

const LibraryIndexMetadataKey = {
  BackfillCursor: 'library.index.backfill.v1.cursor',
  BackfillCompletedAt: 'library.index.backfill.v1.completedAt',
  PolicyVersion: 'library.index.policyVersion',
  LastReconcileAt: 'library.index.lastReconcileAt',
} as const;

const RETRY_DELAYS_MS = [250, 1_000, 3_000, 10_000, 15_000] as const;
const RECONCILE_CONCURRENCY = 8;

const getShareSourceType = (
  artifactType: LibraryArtifactType,
): HtmlShareSourceTypeValue | null => {
  switch (artifactType) {
    case LibraryArtifactType.Html:
      return HtmlShareSourceType.HtmlFile;
    case LibraryArtifactType.Svg:
      return HtmlShareSourceType.SvgFile;
    case LibraryArtifactType.Image:
      return HtmlShareSourceType.ImageFile;
    case LibraryArtifactType.Document:
      return HtmlShareSourceType.DocumentFile;
    case LibraryArtifactType.Markdown:
      return HtmlShareSourceType.MarkdownFile;
    case LibraryArtifactType.Mermaid:
      return HtmlShareSourceType.MermaidFile;
    default:
      return null;
  }
};

const getClientSourceKey = (
  artifactType: LibraryArtifactType,
  filePath: string,
): string | undefined => {
  const sourceType = getShareSourceType(artifactType);
  if (!sourceType) return undefined;
  return sourceType === HtmlShareSourceType.HtmlFile
    ? buildHtmlShareClientSourceKey(filePath)
    : buildArtifactFileClientSourceKey(sourceType, filePath);
};

const isMissingError = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
);

const isPermissionError = (error: unknown): boolean => (
  error instanceof Error
  && 'code' in error
  && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
);

const getSanitizedFsError = (message: string, error: unknown): Error => {
  const code = error instanceof Error && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return new Error(`${message}${code ? ` (${code})` : ''}`);
};

export class LibraryIndexService {
  private readonly store: LibraryLocalStore;
  private readonly userDataPath: string;
  private readonly onChanged: (payload: LibraryChangedPayload) => void;
  private readonly getMetadata: LibraryIndexServiceOptions['getMetadata'];
  private readonly setMetadata: LibraryIndexServiceOptions['setMetadata'];
  private readonly watchers = new Map<string, DirectoryWatchEntry>();
  private readonly itemPaths = new Map<string, string>();
  private readonly watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private phase: LibraryIndexStatus['phase'] = LibraryIndexPhase.Idle;
  private stopped = false;
  private watcherDegraded = false;

  constructor(options: LibraryIndexServiceOptions) {
    this.store = options.store;
    this.userDataPath = path.resolve(options.userDataPath);
    this.onChanged = options.onChanged;
    this.getMetadata = options.getMetadata;
    this.setMetadata = options.setMetadata;
  }

  start(): void {
    this.stopped = false;
    this.rebuildWatchers();
    this.scheduleReconcile(2_000);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    for (const entry of this.watchers.values()) entry.watcher.close();
    this.watchers.clear();
    this.itemPaths.clear();
  }

  async recordCandidates(candidates: LibraryArtifactCandidate[]): Promise<LibraryRecordCandidatesData> {
    let recorded = 0;
    let ignored = 0;
    const changedIds: string[] = [];
    for (const candidate of candidates) {
      if (!this.store.sessionExists(candidate.sessionId)) {
        ignored += 1;
        continue;
      }
      try {
        const item = await this.indexCandidate(candidate);
        if (!item) {
          ignored += 1;
          if (this.store.sessionExists(candidate.sessionId)) {
            this.scheduleCandidateRetry(candidate, 0);
          }
          continue;
        }
        recorded += 1;
        changedIds.push(item.itemId);
      } catch (error) {
        if (isMissingError(error)) {
          ignored += 1;
          this.scheduleCandidateRetry(candidate, 0);
          continue;
        }
        ignored += 1;
        console.warn(
          '[Library] Failed to index an artifact candidate.',
          getSanitizedFsError('Artifact candidate indexing failed', error),
        );
      }
    }
    if (changedIds.length > 0) {
      this.onChanged({ reason: 'recorded', itemIds: [...new Set(changedIds)] });
    }
    return { recorded, ignored };
  }

  async addLocalFiles(filePaths: string[]): Promise<LibraryAddLocalFilesData> {
    const items: LocalArtifactItem[] = [];
    const ignoredPaths: string[] = [];
    for (const filePath of filePaths) {
      try {
        const indexed = await this.resolveIndexedFile(filePath, LibraryOrigin.Manual);
        if (!indexed) {
          ignoredPaths.push(filePath);
          continue;
        }
        const storedItem = this.store.upsertFile(indexed);
        this.addWatch(storedItem.itemId, storedItem.filePath);
        const visibleItem = this.store.getVisibleItem(storedItem.itemId);
        if (visibleItem) items.push(visibleItem);
      } catch {
        ignoredPaths.push(filePath);
      }
    }
    if (items.length > 0) {
      this.onChanged({ reason: 'recorded', itemIds: items.map(item => item.itemId) });
    }
    return { items, ignoredPaths };
  }

  async repair(): Promise<LibraryIndexStatus> {
    await this.reconcile({ notify: true });
    this.store.cleanupExpiredMissing(LibraryLimits.MissingRetentionMs);
    this.store.cleanupOrphanRelations();
    this.rebuildWatchers();
    return this.getStatus();
  }

  getStatus(): LibraryIndexStatus {
    const counts = this.store.countByAvailability();
    const backfill = this.getBackfillState();
    return {
      phase: this.phase,
      trackedCount: counts.tracked,
      availableCount: counts.available,
      missingCount: counts.missing,
      watchedDirectoryCount: this.watchers.size,
      watcherDegraded: this.watcherDegraded,
      ...(this.getMetadata<number>(LibraryIndexMetadataKey.LastReconcileAt)
        ? { lastReconcileAt: this.getMetadata<number>(LibraryIndexMetadataKey.LastReconcileAt) }
        : {}),
      ...(backfill.completedAt ? { backfillCompletedAt: backfill.completedAt } : {}),
    };
  }

  getBackfillState(): LibraryBackfillState {
    const cursor = this.getMetadata<string>(LibraryIndexMetadataKey.BackfillCursor);
    const completedAt = this.getMetadata<number>(LibraryIndexMetadataKey.BackfillCompletedAt);
    return {
      policyVersion:
        this.getMetadata<number>(LibraryIndexMetadataKey.PolicyVersion)
        ?? LIBRARY_INDEX_POLICY_VERSION,
      ...(cursor ? { cursor } : {}),
      ...(completedAt && completedAt > 0 ? { completedAt } : {}),
    };
  }

  setBackfillState(state: LibraryBackfillState): void {
    const previousPolicyVersion = this.getMetadata<number>(LibraryIndexMetadataKey.PolicyVersion);
    if (previousPolicyVersion !== state.policyVersion) {
      this.setMetadata(LibraryIndexMetadataKey.BackfillCursor, '');
      this.setMetadata(LibraryIndexMetadataKey.BackfillCompletedAt, 0);
    }
    if (state.cursor !== undefined) {
      this.setMetadata(LibraryIndexMetadataKey.BackfillCursor, state.cursor);
    }
    if (state.completedAt !== undefined) {
      this.setMetadata(LibraryIndexMetadataKey.BackfillCompletedAt, state.completedAt);
    }
    this.setMetadata(LibraryIndexMetadataKey.PolicyVersion, state.policyVersion);
  }

  unwatchItem(itemId: string): void {
    const filePath = this.itemPaths.get(itemId);
    if (!filePath) return;
    this.itemPaths.delete(itemId);
    const directory = path.dirname(filePath);
    const entry = this.watchers.get(directory);
    if (!entry) return;
    const baseName = path.basename(filePath);
    const itemIds = entry.itemsByBaseName.get(baseName);
    itemIds?.delete(itemId);
    if (itemIds?.size === 0) entry.itemsByBaseName.delete(baseName);
    if (entry.itemsByBaseName.size === 0) {
      entry.watcher.close();
      this.watchers.delete(directory);
    }
  }

  refreshTrackingForItem(itemId: string): void {
    const item = this.store.getItem(itemId);
    if (item) this.addWatch(item.itemId, item.filePath);
  }

  notifyChange(payload: LibraryChangedPayload): void {
    this.onChanged(payload);
  }

  notifySessionProjectionChanges(changes: SessionProjectionChanges): void {
    const sessionIds = this.store.listSessionIdsWithArtifactRelations(changes.changedSessionIds);
    if (sessionIds.length > 0) {
      this.notifyChange({ reason: LibraryChangeReason.SessionProjectionChanged, sessionIds });
    }
    if (changes.affectedArtifactIds.length > 0) {
      this.notifyChange({
        reason: LibraryChangeReason.SessionDeleted,
        sessionIds: changes.deletedSessionIds,
        itemIds: changes.affectedArtifactIds,
      });
    }
  }

  private async indexCandidate(candidate: LibraryArtifactCandidate): Promise<LocalArtifactItem | null> {
    const cwd = this.store.getSessionCwd(candidate.sessionId);
    if (!cwd) return null;
    const resolvedPath = path.isAbsolute(candidate.filePath)
      ? candidate.filePath
      : path.resolve(cwd, candidate.filePath);
    const indexed = await this.resolveIndexedFile(
      resolvedPath,
      candidate.origin ?? LibraryOrigin.Conversation,
    );
    if (!indexed) return null;
    const item = this.store.upsertFile(indexed, candidate);
    if (!item) return null;
    this.addWatch(item.itemId, item.filePath);
    return item;
  }

  private async resolveIndexedFile(
    rawFilePath: string,
    origin: LocalArtifactItem['origin'],
  ): Promise<LibraryIndexedFile | null> {
    const absolutePath = path.resolve(rawFilePath);
    const realPath = await fs.promises.realpath(absolutePath);
    if (this.isExcludedPath(realPath)) return null;
    const stats = await fs.promises.stat(realPath);
    if (!stats.isFile()) return null;
    const extension = path.extname(realPath).toLowerCase();
    const artifactType = getLibraryArtifactTypeForExtension(extension);
    if (!artifactType) return null;
    const normalizedPath = path.normalize(realPath);
    const pathKey = process.platform === 'win32'
      ? normalizedPath.replace(/\\/g, '/').toLowerCase()
      : normalizedPath;
    const verifiedAt = Date.now();
    return {
      pathKey,
      filePath: normalizedPath,
      fileName: path.basename(normalizedPath),
      extension,
      artifactType,
      category: getLibraryCategoryForExtension(extension) as LibraryIndexedFile['category'],
      fileIdentity: `${stats.dev}:${stats.ino}:${Math.trunc(stats.birthtimeMs)}`,
      clientSourceKey: getClientSourceKey(artifactType, normalizedPath),
      sizeBytes: stats.size,
      fileMtimeMs: Math.trunc(stats.mtimeMs),
      availability: LibraryAvailability.Available,
      origin,
      verifiedAt,
    };
  }

  private isExcludedPath(filePath: string): boolean {
    const normalized = path.normalize(filePath);
    const segments = normalized.split(path.sep);
    if (segments.includes('node_modules') || segments.includes('.cowork-temp')) return true;
    const libraryCachePath = path.join(this.userDataPath, 'library');
    return normalized === libraryCachePath || normalized.startsWith(`${libraryCachePath}${path.sep}`);
  }

  private scheduleCandidateRetry(candidate: LibraryArtifactCandidate, attempt: number): void {
    if (this.stopped || attempt >= RETRY_DELAYS_MS.length) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.stopped || !this.store.sessionExists(candidate.sessionId)) return;
      void this.indexCandidate(candidate)
        .then(item => {
          if (item) {
            this.onChanged({ reason: 'recorded', itemIds: [item.itemId] });
          } else {
            this.scheduleCandidateRetry(candidate, attempt + 1);
          }
        })
        .catch(error => {
          if (isMissingError(error)) this.scheduleCandidateRetry(candidate, attempt + 1);
        });
    }, RETRY_DELAYS_MS[attempt]);
    this.retryTimers.add(timer);
  }

  private rebuildWatchers(): void {
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    for (const entry of this.watchers.values()) entry.watcher.close();
    this.watchers.clear();
    this.itemPaths.clear();
    this.watcherDegraded = false;
    for (const item of this.store.listTracked()) this.addWatch(item.itemId, item.filePath);
  }

  private addWatch(itemId: string, filePath: string): void {
    if (this.stopped) return;
    const directory = path.dirname(filePath);
    const baseName = path.basename(filePath);
    let entry = this.watchers.get(directory);
    if (!entry) {
      if (this.watchers.size >= LibraryLimits.WatchDirectoryLimit) {
        this.watcherDegraded = true;
        return;
      }
      try {
        const itemsByBaseName = new Map<string, Set<string>>();
        const watcher = fs.watch(directory, (eventType, changedName) => {
          const changedBaseName = changedName?.toString();
          if (!changedBaseName) {
            for (const ids of itemsByBaseName.values()) {
              for (const id of ids) this.scheduleWatchRefresh(id);
            }
            return;
          }
          if (eventType === 'rename') {
            void this.tryRelocateWithinDirectory(directory, changedBaseName);
          }
          for (const id of itemsByBaseName.get(changedBaseName) ?? []) {
            this.scheduleWatchRefresh(id);
          }
        });
        watcher.on('error', error => {
          console.warn(
            '[Library] Directory watcher failed; stat reconciliation will be used.',
            getSanitizedFsError('Directory watcher failed', error),
          );
          watcher.close();
          this.watchers.delete(directory);
          this.watcherDegraded = true;
        });
        entry = { watcher, itemsByBaseName };
        this.watchers.set(directory, entry);
      } catch (error) {
        console.warn(
          '[Library] Unable to watch an indexed artifact directory.',
          getSanitizedFsError('Directory watcher setup failed', error),
        );
        this.watcherDegraded = true;
        return;
      }
    }
    const ids = entry.itemsByBaseName.get(baseName) ?? new Set<string>();
    ids.add(itemId);
    entry.itemsByBaseName.set(baseName, ids);
    this.itemPaths.set(itemId, filePath);
  }

  private scheduleWatchRefresh(itemId: string): void {
    const existing = this.watchTimers.get(itemId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.watchTimers.delete(itemId);
      void this.verifyTrackedItem(itemId, this.itemPaths.get(itemId))
        .then(changed => {
          if (changed) this.onChanged({ reason: 'file_changed', itemIds: [itemId] });
        });
    }, LibraryLimits.WatchDebounceMs);
    this.watchTimers.set(itemId, timer);
  }

  private async verifyTrackedItem(itemId: string, filePath?: string): Promise<boolean> {
    if (!filePath) return false;
    try {
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile()) {
        return this.store.markMissing(itemId);
      }
      return this.store.refreshFile(itemId, {
        sizeBytes: stats.size,
        fileMtimeMs: Math.trunc(stats.mtimeMs),
      });
    } catch (error) {
      if (isPermissionError(error)) return this.store.markPermissionDenied(itemId);
      if (!isMissingError(error)) return this.store.markMissing(itemId);
      await new Promise(resolve => setTimeout(resolve, LibraryLimits.WatchDebounceMs));
      if (this.stopped) return false;
      try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) return this.store.markMissing(itemId);
        return this.store.refreshFile(itemId, {
          sizeBytes: stats.size,
          fileMtimeMs: Math.trunc(stats.mtimeMs),
        });
      } catch (confirmationError) {
        if (isPermissionError(confirmationError)) {
          return this.store.markPermissionDenied(itemId);
        }
        return this.store.markMissing(itemId);
      }
    }
  }

  private async tryRelocateWithinDirectory(directory: string, baseName: string): Promise<void> {
    const nextPath = path.join(directory, baseName);
    let indexed: LibraryIndexedFile | null;
    try {
      indexed = await this.resolveIndexedFile(nextPath, LibraryOrigin.Conversation);
    } catch {
      return;
    }
    if (!indexed?.fileIdentity) return;
    const candidates = this.store.findRelocationCandidates(indexed.fileIdentity)
      .filter(candidate => (
        path.dirname(candidate.filePath) === directory
        && path.normalize(candidate.filePath) !== path.normalize(indexed.filePath)
      ));
    const missingCandidates = [];
    for (const candidate of candidates) {
      try {
        await fs.promises.stat(candidate.filePath);
      } catch (error) {
        if (isMissingError(error)) missingCandidates.push(candidate);
      }
    }
    if (missingCandidates.length !== 1) return;
    const candidate = missingCandidates[0];
    if (!this.store.relocateFile(candidate.itemId, indexed)) return;
    this.unwatchItem(candidate.itemId);
    this.addWatch(candidate.itemId, indexed.filePath);
    this.onChanged({ reason: 'file_changed', itemIds: [candidate.itemId] });
  }

  private scheduleReconcile(delayMs: number): void {
    if (this.stopped) return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile({
        limit: LibraryLimits.ReconcileBatchSize,
        notify: false,
        verifiedBefore: Date.now() - LibraryLimits.RecentVerificationWindowMs,
      }).finally(() => this.scheduleReconcile(LibraryLimits.ReconcileIntervalMs));
    }, delayMs);
  }

  private async reconcile(options: {
    limit?: number;
    notify: boolean;
    verifiedBefore?: number;
  }): Promise<void> {
    if (this.phase !== LibraryIndexPhase.Idle || this.stopped) return;
    this.phase = options.notify ? LibraryIndexPhase.Repair : LibraryIndexPhase.Backfill;
    try {
      const items = this.store.listTracked(options.limit, options.verifiedBefore);
      let nextIndex = 0;
      const changedIds: string[] = [];
      const worker = async () => {
        while (nextIndex < items.length && !this.stopped) {
          const item = items[nextIndex];
          nextIndex += 1;
          if (await this.verifyTrackedItem(item.itemId, item.filePath)) changedIds.push(item.itemId);
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(RECONCILE_CONCURRENCY, items.length) },
        () => worker(),
      ));
      const completedAt = Date.now();
      this.setMetadata(LibraryIndexMetadataKey.LastReconcileAt, completedAt);
      if (options.notify) {
        this.onChanged({ reason: 'repair', itemIds: changedIds });
      }
    } finally {
      this.phase = LibraryIndexPhase.Idle;
    }
  }
}
