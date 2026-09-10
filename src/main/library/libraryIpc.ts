import crypto from 'crypto';
import { ipcMain, shell } from 'electron';

import { AgentAccessErrorCode } from '../../shared/agent/constants';
import {
  isLibraryArtifactType,
  isLibraryCategory,
  isLibraryCloudAvailabilityFilter,
  isLibraryItemKind,
  isLibraryRelationKind,
  isLibrarySharedStatusFilter,
  LibraryChangeReason,
  LibraryCloudKind,
  LibraryErrorCode,
  LibraryFavoriteScope,
  LibraryIpc,
  LibraryItemKind,
  LibraryLimits,
  LibraryLocalSort,
  LibraryOrigin,
  LibrarySort,
} from '../../shared/library/constants';
import { isLibraryIdentifier, LibraryLocalDataError } from '../../shared/library/localOrdering';
import type {
  LibraryArtifactCandidate,
  LibraryBackfillState,
  LibraryCloudListOptions,
  LibraryFavoriteInput,
  LibraryGetLocalItemsInput,
  LibraryLocalListOptions,
  LibraryResult,
} from '../../shared/library/types';
import type { RemoteOwner } from '../../shared/remote/constants';
import { AgentAccessError, sameAgentOwner } from '../agentOwnership';
import { listLibraryCloudItems } from './libraryCloudClient';
import { LibraryIndexService } from './libraryIndexService';
import { decodeLibraryLocalCursor, LibraryLocalStore } from './libraryLocalStore';
import { normalizeLibraryTaskGroupsOptions, normalizeLibraryTaskItemsOptions } from './libraryLocalTaskQuery';

export interface LibraryIpcDependencies {
  getOwner: () => RemoteOwner | null;
  localStore: LibraryLocalStore;
  indexService: LibraryIndexService;
  getServerApiBaseUrl: () => string;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
}

const success = <T>(data: T): LibraryResult<T> => ({ success: true, data });

const failure = <T>(code: LibraryErrorCode, error: string): LibraryResult<T> => ({
  success: false,
  code,
  error,
});

const normalizeCloudOwnerScope = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) return null;
  const digest = crypto.createHash('sha256').update(value.trim()).digest('hex');
  return `${LibraryFavoriteScope.CloudPrefix}${digest}`;
};

const requireItemId = (value: unknown): string => {
  if (!isLibraryIdentifier(value)) {
    throw new Error('Invalid library item identifier.');
  }
  return value;
};

export const normalizeLibraryTargetItemIds = (value: unknown): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid library item request.');
  }
  const input = value as Partial<LibraryGetLocalItemsInput>;
  if (
    !Array.isArray(input.itemIds)
    || input.itemIds.length < 1
    || input.itemIds.length > LibraryLimits.MaxTargetItemIds
  ) {
    throw new Error('Invalid library item identifiers.');
  }
  return [...new Set(input.itemIds.map(requireItemId))];
};

export const normalizeLocalListOptions = (value: unknown): LibraryLocalListOptions => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid list options.');
  const input = value as Record<string, unknown>;
  if (input.category !== undefined && !isLibraryCategory(input.category)) {
    throw new Error('Invalid library category.');
  }
  if (input.sort !== undefined && input.sort !== LibraryLocalSort.RecentTask) {
    throw new Error('Invalid library sort.');
  }
  const cursor = input.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || !decodeLibraryLocalCursor(cursor))) {
    throw new LibraryLocalDataError(LibraryErrorCode.InvalidCursor, 'Invalid library cursor.');
  }
  return {
    ...(input.category ? { category: input.category as LibraryLocalListOptions['category'] } : {}),
    ...(typeof input.keyword === 'string'
      ? { keyword: input.keyword.slice(0, LibraryLimits.MaxKeywordLength) }
      : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
    ...(typeof input.pageSize === 'number' && Number.isInteger(input.pageSize)
      ? { pageSize: input.pageSize }
      : {}),
    ...(input.sort ? { sort: LibraryLocalSort.RecentTask } : {}),
    ...(typeof input.favoritesOnly === 'boolean'
      ? { favoritesOnly: input.favoritesOnly }
      : {}),
  };
};

const normalizeCloudListOptions = (value: unknown): LibraryCloudListOptions => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cloud list options.');
  const input = value as Record<string, unknown>;
  if (
    input.kind !== undefined
    && !Object.values(LibraryCloudKind).includes(input.kind as LibraryCloudKind)
  ) {
    throw new Error('Invalid cloud library kind.');
  }
  if (input.category !== undefined && !isLibraryCategory(input.category)) {
    throw new Error('Invalid library category.');
  }
  if (input.sort !== undefined && input.sort !== LibrarySort.RecentlyUpdated) {
    throw new Error('Invalid library sort.');
  }
  if (
    input.availability !== undefined
    && !isLibraryCloudAvailabilityFilter(input.availability)
  ) {
    throw new Error('Invalid cloud availability filter.');
  }
  if (
    input.sharedStatus !== undefined
    && !isLibrarySharedStatusFilter(input.sharedStatus)
  ) {
    throw new Error('Invalid shared file status.');
  }
  return {
    ...(input.kind ? { kind: input.kind as LibraryCloudListOptions['kind'] } : {}),
    ...(input.category ? { category: input.category as LibraryCloudListOptions['category'] } : {}),
    ...(typeof input.keyword === 'string'
      ? { keyword: input.keyword.slice(0, LibraryLimits.MaxKeywordLength) }
      : {}),
    ...(typeof input.cursor === 'string' && input.cursor.trim()
      ? { cursor: input.cursor.trim().slice(0, 2_000) }
      : {}),
    ...(typeof input.pageSize === 'number' && Number.isInteger(input.pageSize)
      ? { pageSize: input.pageSize }
      : {}),
    ...(input.sort ? { sort: LibrarySort.RecentlyUpdated } : {}),
    ...(typeof input.favoriteOwnerScope === 'string'
      ? { favoriteOwnerScope: input.favoriteOwnerScope }
      : {}),
    ...(typeof input.favoritesOnly === 'boolean'
      ? { favoritesOnly: input.favoritesOnly }
      : {}),
    ...(input.availability
      ? { availability: input.availability as LibraryCloudListOptions['availability'] }
      : {}),
    ...(input.sharedStatus
      ? { sharedStatus: input.sharedStatus as LibraryCloudListOptions['sharedStatus'] }
      : {}),
  };
};

const normalizeCandidates = (value: unknown): LibraryArtifactCandidate[] => {
  if (!Array.isArray(value) || value.length > LibraryLimits.MaxCandidateBatchSize) {
    throw new Error('Invalid artifact candidate batch.');
  }
  let totalStringLength = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid artifact candidate.');
    }
    const input = item as Record<string, unknown>;
    const sessionId = requireItemId(input.sessionId);
    const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';
    if (!filePath || filePath.length > LibraryLimits.MaxCandidateStringLength) {
      throw new Error('Invalid artifact candidate path.');
    }
    if (!isLibraryArtifactType(input.detectedType)) {
      throw new Error('Invalid artifact candidate type.');
    }
    if (!isLibraryRelationKind(input.relationKind)) {
      throw new Error('Invalid artifact candidate relation.');
    }
    if (!Number.isSafeInteger(input.relatedAt) || (input.relatedAt as number) <= 0) {
      throw new Error('Invalid artifact candidate timestamp.');
    }
    const messageId = typeof input.messageId === 'string'
      ? input.messageId.trim().slice(0, 200)
      : undefined;
    const sessionArtifactId = typeof input.sessionArtifactId === 'string'
      ? input.sessionArtifactId.trim().slice(0, 200)
      : undefined;
    const allowedOrigins: readonly LibraryOrigin[] = [
      LibraryOrigin.Conversation,
      LibraryOrigin.Backfill,
      LibraryOrigin.Share,
    ];
    const origin = allowedOrigins.includes(input.origin as LibraryOrigin)
      ? input.origin as LibraryOrigin
      : LibraryOrigin.Conversation;
    totalStringLength += sessionId.length + filePath.length
      + (messageId?.length ?? 0) + (sessionArtifactId?.length ?? 0);
    if (totalStringLength > LibraryLimits.MaxCandidateBatchStringLength) {
      throw new Error('Artifact candidate batch is too large.');
    }
    return {
      sessionId,
      filePath,
      detectedType: input.detectedType,
      relationKind: input.relationKind,
      relatedAt: input.relatedAt as number,
      origin,
      ...(messageId ? { messageId } : {}),
      ...(sessionArtifactId ? { sessionArtifactId } : {}),
    };
  });
};

export const registerLibraryIpcHandlers = ({
  localStore,
  indexService,
  getServerApiBaseUrl,
  fetchWithAuth,
  getOwner = () => null,
}: LibraryIpcDependencies): void => {
  const captureAccess = () => {
    const owner = getOwner();
    const actor = owner ? { ...owner } : null;
    return { actor, assertCurrentOwner: () => {
      if (!sameAgentOwner(actor, getOwner())) throw new AgentAccessError(AgentAccessErrorCode.AccountChanged);
    } };
  };
  ipcMain.handle(LibraryIpc.ListLocalTaskGroups, (_event, input: unknown) => {
    try {
      return success(localStore.listTaskGroups(normalizeLibraryTaskGroupsOptions(input), getOwner()));
    } catch (error) {
      return failure(
        error instanceof LibraryLocalDataError ? error.code : LibraryErrorCode.Internal,
        error instanceof Error ? error.message : 'Invalid local task groups request.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.ListLocalTaskItems, (_event, input: unknown) => {
    try {
      return success(localStore.listTaskItems(normalizeLibraryTaskItemsOptions(input), getOwner()));
    } catch (error) {
      return failure(
        error instanceof LibraryLocalDataError ? error.code : LibraryErrorCode.Internal,
        error instanceof Error ? error.message : 'Invalid local task items request.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.ListLocal, (_event, input: unknown) => {
    try {
      return success(localStore.list(normalizeLocalListOptions(input), getOwner()));
    } catch (error) {
      return failure(
        error instanceof LibraryLocalDataError ? error.code : LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid local library request.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.ListCloud, async (_event, input: unknown) => {
    try {
      const options = normalizeCloudListOptions(input);
      const ownerScope = normalizeCloudOwnerScope(options.favoriteOwnerScope);
      if (!ownerScope) {
        return failure(LibraryErrorCode.NotAuthenticated, 'Sign in to view cloud library items.');
      }
      const access = captureAccess();
      const result = await listLibraryCloudItems(
        getServerApiBaseUrl(),
        fetchWithAuth,
        localStore,
        ownerScope,
        options,
        access.actor,
      );
      access.assertCurrentOwner();
      return result;
    } catch (error) {
      return failure(
        LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid cloud library request.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.GetLocalItems, (_event, input: unknown) => {
    try {
      return success(localStore.getVisibleItems(normalizeLibraryTargetItemIds(input), getOwner()));
    } catch (error) {
      return failure(
        error instanceof LibraryLocalDataError ? error.code : LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid library item request.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.GetLocalDetail, (_event, itemId: unknown) => {
    try {
      const detail = localStore.getDetail(requireItemId(itemId), getOwner());
      return detail
        ? success(detail)
        : failure(LibraryErrorCode.NotFound, 'Library item was not found.');
    } catch (error) {
      return failure(
        error instanceof LibraryLocalDataError ? error.code : LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid library item.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.RecordCandidates, async (_event, input: unknown) => {
    try {
      const access = captureAccess();
      const candidates = normalizeCandidates(input);
      if (candidates.some(candidate => !localStore.sessionExists(candidate.sessionId, access.actor))) {
        return failure(LibraryErrorCode.NotFound, 'Library task was not found.');
      }
      const result = await indexService.recordCandidates(candidates, access.actor, access.assertCurrentOwner);
      access.assertCurrentOwner();
      return success(result);
    } catch (error) {
      return failure(
        LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid artifact candidate batch.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.AddLocalFiles, async (_event, input: unknown) => {
    try {
      if (!Array.isArray(input) || input.length > LibraryLimits.MaxCandidateBatchSize) {
        throw new Error('Invalid local file selection.');
      }
      const paths = input.map(value => {
        if (
          typeof value !== 'string'
          || !value.trim()
          || value.length > LibraryLimits.MaxCandidateStringLength
        ) {
          throw new Error('Invalid local file path.');
        }
        return value.trim();
      });
      const access = captureAccess();
      const result = await indexService.addLocalFiles(paths, access.actor, access.assertCurrentOwner);
      access.assertCurrentOwner();
      return success(result);
    } catch (error) {
      return failure(
        LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid local file selection.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.SetFavorite, (_event, value: unknown) => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid favorite request.');
      }
      const input = value as Partial<LibraryFavoriteInput>;
      if (!isLibraryItemKind(input.itemKind) || typeof input.favorite !== 'boolean') {
        throw new Error('Invalid favorite request.');
      }
      const itemId = requireItemId(input.itemId);
      const ownerScope = input.itemKind === LibraryItemKind.LocalArtifact
        ? LibraryFavoriteScope.LocalDevice
        : normalizeCloudOwnerScope(input.ownerScope);
      if (!ownerScope) throw new Error('Cloud favorite requires an account scope.');
      if (input.itemKind === LibraryItemKind.LocalArtifact && !localStore.getVisibleItem(itemId, getOwner())) {
        return failure(LibraryErrorCode.NotFound, 'Library item was not found.');
      }
      localStore.setFavorite({
        ownerScope,
        itemKind: input.itemKind,
        itemId,
        favorite: input.favorite,
      });
      indexService.notifyChange({
        reason: LibraryChangeReason.Favorite,
        itemKind: input.itemKind,
        itemIds: [itemId],
      });
      return success({ favorite: input.favorite });
    } catch (error) {
      return failure(
        LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid favorite request.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.OpenLocal, async (_event, value: unknown) => {
    try {
      const filePath = localStore.resolvePath(requireItemId(value), getOwner());
      if (!filePath) return failure(LibraryErrorCode.NotFound, 'Library item was not found.');
      const error = await shell.openPath(filePath);
      return error ? failure(LibraryErrorCode.NotAvailable, error) : success(null);
    } catch (error) {
      return failure(
        LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid library item.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.RevealLocal, (_event, value: unknown) => {
    try {
      const filePath = localStore.resolvePath(requireItemId(value), getOwner());
      if (!filePath) return failure(LibraryErrorCode.NotFound, 'Library item was not found.');
      shell.showItemInFolder(filePath);
      return success(null);
    } catch (error) {
      return failure(
        LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid library item.',
      );
    }
  });

  ipcMain.handle(LibraryIpc.RepairIndex, async () => {
    try {
      return success(await indexService.repair());
    } catch (error) {
      console.error('[Library] Index repair failed.', error);
      return failure(LibraryErrorCode.Internal, 'Library index repair failed.');
    }
  });

  ipcMain.handle(LibraryIpc.GetIndexStatus, () => success(indexService.getStatus()));
  ipcMain.handle(LibraryIpc.GetBackfillState, () => success(indexService.getBackfillState()));
  ipcMain.handle(LibraryIpc.SetBackfillState, (_event, value: unknown) => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid backfill state.');
      }
      const input = value as Partial<LibraryBackfillState>;
      if (!Number.isSafeInteger(input.policyVersion) || (input.policyVersion ?? 0) < 1) {
        throw new Error('Invalid backfill policy version.');
      }
      const state: LibraryBackfillState = {
        policyVersion: input.policyVersion as number,
        ...(typeof input.cursor === 'string' && input.cursor.length <= 500
          ? { cursor: input.cursor }
          : {}),
        ...(Number.isSafeInteger(input.completedAt) && (input.completedAt ?? 0) > 0
          ? { completedAt: input.completedAt }
          : {}),
      };
      indexService.setBackfillState(state);
      return success(state);
    } catch (error) {
      return failure(
        LibraryErrorCode.InvalidInput,
        error instanceof Error ? error.message : 'Invalid backfill state.',
      );
    }
  });
};
