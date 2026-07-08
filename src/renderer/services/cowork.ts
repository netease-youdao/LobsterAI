import { classifyErrorKey } from '../../common/coworkErrorClassify';
import {
  ContextCompactionMode,
  ContextCompactionStatus,
  CoworkSystemMessageKind,
} from '../../common/coworkSystemMessages';
import type { OpenClawSessionPatch } from '../../common/openclawSession';
import {
  COWORK_MESSAGE_PAGE_SIZE,
  COWORK_SESSION_PAGE_SIZE,
  CoworkContextUsageRefreshMode,
  type CoworkContextUsageRefreshMode as CoworkContextUsageRefreshModeType,
  CoworkContextUsageSource,
} from '../../shared/cowork/constants';
import { normalizeCoworkGoal } from '../../shared/cowork/goal';
import type { CoworkMessageRailIndexItem } from '../../shared/cowork/rail';
import { store } from '../store';
import {
  addMessage,
  addSession,
  appendSessions,
  clearCurrentSession,
  clearPendingPermissions,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  dequeuePendingPermission,
  enqueuePendingPermission,
  markCompactionNotified,
  prependMessages,
  setConfig,
  setContextCompacting,
  setContextMaintenance,
  setContextUsage,
  setCurrentSession,
  setHasMoreSessions,
  setMessageRailIndex,
  setMessageRailIndexLoading,
  setMessageWindow,
  setRemoteManaged,
  setSessions,
  setStreaming,
  updateCurrentSessionModelOverride,
  updateMessageContent,
  updateSessionGoal,
  updateSessionPinned,
  updateSessionStatus,
  updateSessionTitle,
  updateToolUseMediaStatus,
} from '../store/slices/coworkSlice';
import { clearActiveSkills, setActiveSkillIds } from '../store/slices/skillSlice';
import type {
  CoworkApiConfig,
  CoworkConfigUpdate,
  CoworkContextUsage,
  CoworkContinueOptions,
  CoworkForkSessionOptions,
  CoworkMemoryStats,
  CoworkPermissionResult,
  CoworkSession,
  CoworkSessionListResult,
  CoworkStartOptions,
  CoworkUserMemoryEntry,
  OpenClawEngineStatus,
  OpenClawGatewayRepairResult,
  OpenClawSessionPolicyConfig,
} from '../types/cowork';
import { i18nService } from './i18n';

const STREAM_ERROR_DUPLICATE_WINDOW_MS = 10_000;

const classifyError = (error: string): string => {
  const key = classifyErrorKey(error);
  return key ? i18nService.t(key) : error;
};

const normalizeErrorText = (text: string): string => text.trim();

const hasRecentMatchingErrorMessage = (
  session: CoworkSession | null | undefined,
  rawError: string,
  displayError: string,
): boolean => {
  if (!session) return false;

  const expectedTexts = new Set(
    [rawError, displayError]
      .map(normalizeErrorText)
      .filter(Boolean),
  );
  if (expectedTexts.size === 0) return false;

  const duplicateAfter = Date.now() - STREAM_ERROR_DUPLICATE_WINDOW_MS;
  return session.messages.some((message) => {
    if (message.type !== 'system' || message.timestamp < duplicateAfter) {
      return false;
    }

    const messageTexts = [
      message.content,
      typeof message.metadata?.error === 'string' ? message.metadata.error : '',
    ].map(normalizeErrorText);

    return messageTexts.some((text) => expectedTexts.has(text));
  });
};

const CONTEXT_USAGE_REFRESH_DELAY_MS = 800;
const FINAL_CONTEXT_USAGE_REFRESH_DELAYS_MS = [800, 2500, 6000, 12000] as const;
const CONTEXT_USAGE_AUTO_SUPPRESSION_MS = 5 * 60 * 1000;
const CONTEXT_USAGE_REFRESH_BACKOFF_MS = 30_000;
const MANUAL_CONTEXT_COMPACTION_WATCHDOG_MS = 130_000;

const restoreCurrentAgentDefaultSkills = (): void => {
  const state = store.getState();
  const currentAgent = state.agent.agents.find((agent) => agent.id === state.agent.currentAgentId);
  if (currentAgent?.skillIds?.length) {
    store.dispatch(setActiveSkillIds(currentAgent.skillIds));
  } else {
    store.dispatch(clearActiveSkills());
  }
};

class CoworkService {
  private streamListenerCleanups: Array<() => void> = [];
  private initialized = false;
  private openClawStatus: OpenClawEngineStatus | null = null;
  private openClawStatusListeners = new Set<(status: OpenClawEngineStatus) => void>();
  private openClawEngineListenerAttached = false;
  private latestLoadSessionsRequestId = 0;
  private latestLoadSessionRequestId = 0;
  private contextUsageRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private contextUsageInFlightBySessionId = new Map<string, Promise<CoworkContextUsage | null>>();
  private contextUsageAutoSuppressedUntilBySessionId = new Map<string, number>();
  private contextUsageBackoffUntil = new Map<string, number>();
  private contextCompactionWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  private logDiagnostic(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    const formatted = `[CoworkService] ${message}`;
    if (level === 'warn') {
      console.warn(formatted);
    } else if (level === 'error') {
      console.error(formatted);
    } else if (level === 'debug') {
      console.debug(formatted);
    } else {
      console.log(formatted);
    }
    window.electron?.log?.fromRenderer?.(level, 'CoworkService', message);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Load initial config
    await this.loadConfig();

    // Load sessions list
    await this.loadSessions();

    // Set up stream listeners
    this.setupStreamListeners();
    this.setupOpenClawEngineListeners();

    // Load OpenClaw status
    await this.loadOpenClawEngineStatus();

    this.initialized = true;
  }

  private setupStreamListeners(): void {
    const cowork = window.electron?.cowork;
    if (!cowork) return;

    // Clean up any existing listeners
    this.cleanupListeners();

    // Message listener - also check if session exists (for IM-created sessions)
    const messageCleanup = cowork.onStreamMessage(async ({ sessionId, message, beforeMessageId }) => {
      // Debug: log user messages to check if imageAttachments are preserved
      if (message.type === 'user') {
        const meta = message.metadata as Record<string, unknown> | undefined;
        console.log('[CoworkService] onStreamMessage received user message', {
          sessionId,
          messageId: message.id,
          hasMetadata: !!meta,
          metadataKeys: meta ? Object.keys(meta) : [],
          hasImageAttachments: !!(meta?.imageAttachments),
          imageAttachmentsCount: Array.isArray(meta?.imageAttachments) ? (meta.imageAttachments as unknown[]).length : 0,
        });
      }
      // Check if session exists in current list
      const state = store.getState().cowork;
      const sessionExists = state.sessions.some(s => s.id === sessionId);

      console.log('[CoworkService] onStreamMessage: sessionId=', sessionId, 'type=', message.type, 'sessionExists=', sessionExists, 'totalSessions=', state.sessions.length);
      if (!sessionExists) {
        // Session was created by IM or another source, refresh the session list
        console.log('[CoworkService] onStreamMessage: session NOT found in Redux, calling loadSessions...');
        await this.loadSessions();
        const newState = store.getState().cowork;
        const nowExists = newState.sessions.some(s => s.id === sessionId);
        console.log('[CoworkService] onStreamMessage: after loadSessions, sessionExists=', nowExists, 'totalSessions=', newState.sessions.length);
      }

      // A new user turn means this session is actively running again
      // (especially important for IM-triggered turns that do not call continueSession from renderer).
      if (message.type === 'user' || message.type === 'assistant' || message.type === 'tool_use' || message.type === 'tool_result') {
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
      }
      if (beforeMessageId) {
        console.log('[ThinkingOrder] renderer received message with beforeMessageId=', beforeMessageId, 'messageId=', message.id, 'isThinking=', !!(message.metadata as any)?.isThinking);
      }
      store.dispatch(addMessage({ sessionId, message, beforeMessageId }));
    });
    this.streamListenerCleanups.push(messageCleanup);

    // Message update listener (for streaming content updates)
    const messageUpdateCleanup = cowork.onStreamMessageUpdate(({ sessionId, messageId, content, metadata }) => {
      const session = store.getState().cowork.sessions.find(s => s.id === sessionId);
      if (metadata?.isFinal !== true && session?.status !== 'completed') {
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
      }
      if (metadata?.isFinal === true && typeof metadata.model === 'string' && metadata.model.trim()) {
        this.logDiagnostic(
          'debug',
          `received final message metadata for session ${sessionId}, message ${messageId}, model ${metadata.model}`,
        );
      }
      store.dispatch(updateMessageContent({ sessionId, messageId, content, metadata }));
    });
    this.streamListenerCleanups.push(messageUpdateCleanup);

    const mediaStatusPollCleanup = cowork.onMediaStatusPollUpdate?.(({ sessionId, toolCallId, details }) => {
      const session = store.getState().cowork.sessions.find(s => s.id === sessionId);
      if (session?.status !== 'completed') {
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
      }
      store.dispatch(updateToolUseMediaStatus({ sessionId, toolCallId, details }));
    });
    if (mediaStatusPollCleanup) {
      this.streamListenerCleanups.push(mediaStatusPollCleanup);
    }

    const sessionStatusCleanup = cowork.onStreamSessionStatus?.(({ sessionId, status }) => {
      store.dispatch(updateSessionStatus({ sessionId, status }));
    });
    if (sessionStatusCleanup) {
      this.streamListenerCleanups.push(sessionStatusCleanup);
    }

    const contextUsageCleanup = cowork.onStreamContextUsage?.(({ usage }) => {
      if (usage) {
        this.handleContextUsageUpdate(usage, true);
      }
    });
    if (contextUsageCleanup) {
      this.streamListenerCleanups.push(contextUsageCleanup);
    }

    const goalCleanup = cowork.onStreamGoal?.(({ sessionId, goal }) => {
      const normalizedGoal = normalizeCoworkGoal(goal);
      console.debug(
        `[CoworkGoal] stream update received for session ${sessionId}: status=${normalizedGoal?.status ?? 'none'}, hasGoal=${normalizedGoal ? 'yes' : 'no'}.`,
      );
      store.dispatch(updateSessionGoal({ sessionId, goal: normalizedGoal }));
    });
    if (goalCleanup) {
      this.streamListenerCleanups.push(goalCleanup);
    }

    const contextMaintenanceCleanup = cowork.onStreamContextMaintenance?.(({ sessionId, active }) => {
      console.log(`[CoworkService] received context maintenance ${active ? 'start' : 'end'} for session ${sessionId}.`);
      store.dispatch(setContextMaintenance({ sessionId, active }));
    });
    if (contextMaintenanceCleanup) {
      this.streamListenerCleanups.push(contextMaintenanceCleanup);
    }

    // Permission request listener
    const permissionCleanup = cowork.onStreamPermission(({ sessionId, request }) => {
      store.dispatch(enqueuePendingPermission({
        sessionId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        requestId: request.requestId,
        toolUseId: request.toolUseId ?? null,
      }));
    });
    this.streamListenerCleanups.push(permissionCleanup);

    // Permission dismiss listener (timeout or server-side resolution)
    const permissionDismissCleanup = cowork.onStreamPermissionDismiss(({ requestId }) => {
      store.dispatch(dequeuePendingPermission({ requestId }));
    });
    this.streamListenerCleanups.push(permissionDismissCleanup);

    // Complete listener
    const completeCleanup = cowork.onStreamComplete(({ sessionId }) => {
      store.dispatch(updateSessionStatus({ sessionId, status: 'completed' }));
      this.scheduleFinalContextUsageRefresh(sessionId, true);
    });
    this.streamListenerCleanups.push(completeCleanup);

    // Error listener
    const errorCleanup = cowork.onStreamError(({ sessionId, error }) => {
      if (this.isStillRunningError(error)) {
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('coworkSessionStillRunning'),
        }));
        return;
      }
      store.dispatch(updateSessionStatus({ sessionId, status: 'error' }));
      // Surface the error as a visible message so the user knows what happened.
      if (error) {
        const displayError = classifyError(error);
        const currentSession = store.getState().cowork.currentSession;
        const session = currentSession?.id === sessionId ? currentSession : null;
        if (hasRecentMatchingErrorMessage(session, error, displayError)) {
          return;
        }
        store.dispatch(addMessage({
          sessionId,
          message: {
            id: `error-${Date.now()}`,
            type: 'system',
            content: displayError,
            timestamp: Date.now(),
          },
        }));
      }
    });
    this.streamListenerCleanups.push(errorCleanup);

    const sessionModelOverrideCleanup = cowork.onSessionModelOverrideChanged?.((data) => {
      store.dispatch(updateCurrentSessionModelOverride(data));
    });
    if (sessionModelOverrideCleanup) {
      this.streamListenerCleanups.push(sessionModelOverrideCleanup);
    }

    // Sessions changed listener (new channel sessions discovered by polling,
    // or reconcileWithHistory replaced messages for a channel session)
    const sessionsChangedCleanup = cowork.onSessionsChanged(() => {
      const beforeState = store.getState().cowork;
      console.log('[CoworkService] onSessionsChanged: received IPC event, before sessions:', beforeState.sessions.length, 'sessionIds:', beforeState.sessions.map(s => s.id).slice(0, 5));
      void this.loadSessions().then(() => {
        const state = store.getState().cowork;
        console.log('[CoworkService] onSessionsChanged: loadSessions complete, total sessions:', state.sessions.length, 'sessionIds:', state.sessions.map(s => s.id).slice(0, 5));

        // Reload the active session's full message list so that messages
        // replaced by reconcileWithHistory (bulk SQLite replace) are reflected
        // in the conversation view, not just the sidebar.  Without this,
        // user messages synced from gateway history would only appear after
        // the user manually re-enters the conversation.
        const currentId = state.currentSessionId;
        if (currentId) {
          void this.loadSession(currentId);
        }
      }).catch((err) => {
        console.error('[CoworkService] onSessionsChanged: loadSessions FAILED:', err);
      });
    });
    this.streamListenerCleanups.push(sessionsChangedCleanup);
  }

  private isStillRunningError(error: string): boolean {
    return /session .* is still running/i.test(error);
  }

  private scheduleContextUsageRefresh(
    sessionId: string,
    notifyCompaction: boolean,
    delayMs = CONTEXT_USAGE_REFRESH_DELAY_MS,
    mode: CoworkContextUsageRefreshModeType = CoworkContextUsageRefreshMode.Auto,
  ): void {
    const backoffUntil = this.contextUsageBackoffUntil.get(sessionId) ?? 0;
    if (backoffUntil > Date.now()) {
      return;
    }
    const timerKey = `${sessionId}:${delayMs}:${mode}`;
    const existing = this.contextUsageRefreshTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.contextUsageRefreshTimers.delete(timerKey);
      void this.refreshContextUsage(sessionId, { notifyCompaction, mode });
    }, delayMs);
    this.contextUsageRefreshTimers.set(timerKey, timer);
  }

  private clearContextUsageRefreshTimers(sessionId: string): void {
    for (const [timerKey, timer] of this.contextUsageRefreshTimers.entries()) {
      if (!timerKey.startsWith(`${sessionId}:`)) {
        continue;
      }
      clearTimeout(timer);
      this.contextUsageRefreshTimers.delete(timerKey);
    }
  }

  private scheduleFinalContextUsageRefresh(sessionId: string, notifyCompaction: boolean): void {
    for (const delayMs of FINAL_CONTEXT_USAGE_REFRESH_DELAYS_MS) {
      this.scheduleContextUsageRefresh(sessionId, notifyCompaction, delayMs, CoworkContextUsageRefreshMode.PostRun);
    }
  }

  private handleContextUsageUpdate(usage: CoworkContextUsage, notifyCompaction: boolean): void {
    const state = store.getState().cowork;
    const previous = state.contextUsageBySessionId[usage.sessionId];
    store.dispatch(setContextUsage(usage));

    const nextCount = usage.compactionCount;
    const previousCount = previous?.compactionCount;
    const alreadyNotified = state.notifiedCompactionBySessionId[usage.sessionId] ?? 0;
    if (
      notifyCompaction &&
      typeof nextCount === 'number' &&
      nextCount > 0 &&
      typeof previousCount === 'number' &&
      nextCount > previousCount &&
      nextCount > alreadyNotified
    ) {
      store.dispatch(markCompactionNotified({
        sessionId: usage.sessionId,
        compactionCount: nextCount,
      }));
    }
  }

  private suppressAutomaticContextUsage(sessionId: string): void {
    this.contextUsageAutoSuppressedUntilBySessionId.set(
      sessionId,
      Date.now() + CONTEXT_USAGE_AUTO_SUPPRESSION_MS,
    );
  }

  private clearAutomaticContextUsageSuppression(sessionId: string): void {
    this.contextUsageAutoSuppressedUntilBySessionId.delete(sessionId);
  }

  private enterContextUsageBackoff(sessionId: string): void {
    this.contextUsageBackoffUntil.set(sessionId, Date.now() + CONTEXT_USAGE_REFRESH_BACKOFF_MS);
    this.clearContextUsageRefreshTimers(sessionId);
  }

  async refreshContextUsage(
    sessionId: string,
    options: {
      notifyCompaction?: boolean;
      mode?: CoworkContextUsageRefreshModeType;
    } = {},
  ): Promise<CoworkContextUsage | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getContextUsage) return null;
    const mode = options.mode ?? CoworkContextUsageRefreshMode.Manual;
    const notifyCompaction = options.notifyCompaction === true;

    if (mode === CoworkContextUsageRefreshMode.PostRun) {
      this.clearAutomaticContextUsageSuppression(sessionId);
    }

    const backoffUntil = this.contextUsageBackoffUntil.get(sessionId) ?? 0;
    if (mode !== CoworkContextUsageRefreshMode.Manual && backoffUntil > Date.now()) {
      return null;
    }

    if (mode === CoworkContextUsageRefreshMode.Auto) {
      const suppressedUntil = this.contextUsageAutoSuppressedUntilBySessionId.get(sessionId) ?? 0;
      if (Date.now() < suppressedUntil) {
        console.debug(`[CoworkService] automatic context usage refresh skipped for session ${sessionId}.`);
        return null;
      }
    }

    const existing = this.contextUsageInFlightBySessionId.get(sessionId);
    if (existing) {
      const usage = await existing;
      if (usage && options.notifyCompaction === true) {
        this.handleContextUsageUpdate(usage, true);
      }
      return usage;
    }

    let request: Promise<CoworkContextUsage | null>;
    request = (async (): Promise<CoworkContextUsage | null> => {
      try {
        const result = await cowork.getContextUsage(sessionId);
        if (result?.success && result.usage) {
          this.contextUsageBackoffUntil.delete(sessionId);
          this.clearAutomaticContextUsageSuppression(sessionId);
          this.handleContextUsageUpdate(result.usage, notifyCompaction);
          return result.usage;
        }

        if (result?.source === CoworkContextUsageSource.Unavailable) {
          if (mode === CoworkContextUsageRefreshMode.Auto) {
            this.suppressAutomaticContextUsage(sessionId);
          }
          return null;
        }

        if (result && !result.success) {
          this.suppressAutomaticContextUsage(sessionId);
          this.enterContextUsageBackoff(sessionId);
        }
        return null;
      } catch (error) {
        this.suppressAutomaticContextUsage(sessionId);
        console.warn('[CoworkService] context usage refresh failed:', error);
        this.enterContextUsageBackoff(sessionId);
        return null;
      }
    })().finally(() => {
      if (this.contextUsageInFlightBySessionId.get(sessionId) === request) {
        this.contextUsageInFlightBySessionId.delete(sessionId);
      }
    });

    this.contextUsageInFlightBySessionId.set(sessionId, request);
    return request;
  }

  async compactContext(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.compactContext) {
      console.warn('[CoworkService] manual context compaction is unavailable.');
      return false;
    }

    console.log(`[CoworkService] manual context compaction started for session ${sessionId}.`);
    store.dispatch(setContextCompacting({ sessionId, compacting: true }));
    this.clearContextCompactionWatchdog(sessionId);
    this.contextCompactionWatchdogs.set(sessionId, setTimeout(() => {
      console.warn(`[CoworkService] manual context compaction watchdog cleared stale state for session ${sessionId}.`);
      store.dispatch(setContextCompacting({ sessionId, compacting: false }));
      this.contextCompactionWatchdogs.delete(sessionId);
    }, MANUAL_CONTEXT_COMPACTION_WATCHDOG_MS));
    try {
      const result = await cowork.compactContext(sessionId);
      if (result.success) {
        console.log(`[CoworkService] manual context compaction completed for session ${sessionId}, compacted=${result.compacted === true}.`);
        if (result.usage) {
          this.handleContextUsageUpdate(result.usage, false);
        } else {
          await this.refreshContextUsage(sessionId);
        }
        store.dispatch(addMessage({
          sessionId,
          message: {
            id: `context-compaction-manual-${sessionId}-${Date.now()}`,
            type: 'system',
            content: result.compacted
              ? i18nService.t('coworkContextManualCompacted')
              : i18nService.t('coworkContextManualCompactNoop'),
            timestamp: Date.now(),
            metadata: {
              kind: CoworkSystemMessageKind.ContextCompaction,
              mode: ContextCompactionMode.Manual,
              status: result.compacted
                ? ContextCompactionStatus.Completed
                : ContextCompactionStatus.Failed,
              compacted: result.compacted === true,
            },
          },
        }));
        return true;
      }
      console.warn(`[CoworkService] manual context compaction failed for session ${sessionId}: ${result.error ?? 'Unknown error'}`);
      if (result.error) {
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: result.error,
        }));
      }
      return false;
    } catch (error) {
      console.warn(`[CoworkService] manual context compaction failed for session ${sessionId}:`, error);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: error instanceof Error ? error.message : 'Failed to compact context',
      }));
      return false;
    } finally {
      this.clearContextCompactionWatchdog(sessionId);
      store.dispatch(setContextCompacting({ sessionId, compacting: false }));
    }
  }

  private clearContextCompactionWatchdog(sessionId: string): void {
    const timer = this.contextCompactionWatchdogs.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.contextCompactionWatchdogs.delete(sessionId);
  }

  private setupOpenClawEngineListeners(): void {
    if (this.openClawEngineListenerAttached) return;
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.onProgress) return;

    const statusCleanup = engineApi.onProgress((status) => {
      this.notifyOpenClawStatus(status);
    });
    this.streamListenerCleanups.push(statusCleanup);
    this.openClawEngineListenerAttached = true;
  }

  private notifyOpenClawStatus(status: OpenClawEngineStatus): void {
    this.openClawStatus = status;
    this.openClawStatusListeners.forEach((listener) => {
      listener(status);
    });
  }

  private cleanupListeners(): void {
    this.streamListenerCleanups.forEach(cleanup => cleanup());
    this.streamListenerCleanups = [];
    this.openClawEngineListenerAttached = false;
    this.contextUsageRefreshTimers.forEach(timer => clearTimeout(timer));
    this.contextUsageRefreshTimers.clear();
    this.contextUsageInFlightBySessionId.clear();
    this.contextUsageAutoSuppressedUntilBySessionId.clear();
    this.contextUsageBackoffUntil.clear();
  }

  async loadSessions(agentId?: string): Promise<void> {
    const requestId = ++this.latestLoadSessionsRequestId;
    const result = await window.electron?.cowork?.listSessions({ limit: COWORK_SESSION_PAGE_SIZE, offset: 0, agentId });
    if (result?.success && result.sessions) {
      // High-frequency IM traffic can trigger overlapping list refreshes.
      // Ignore stale responses so an older snapshot does not hide newer sessions.
      if (requestId !== this.latestLoadSessionsRequestId) {
        return;
      }
      store.dispatch(setSessions(result.sessions));
      store.dispatch(setHasMoreSessions(result.hasMore ?? false));
    }
  }

  async listSessionsForAgentPreview(
    agentId: string,
    limit: number,
    offset: number,
  ): Promise<CoworkSessionListResult> {
    const result = await window.electron?.cowork?.listSessions({ limit, offset, agentId });
    return result ?? { success: false, error: 'Cowork IPC is unavailable' };
  }

  async listSessionsForSearch(
    limit: number,
    offset: number,
    searchQuery?: string,
  ): Promise<CoworkSessionListResult> {
    const trimmedQuery = searchQuery?.trim();
    const startedAt = performance.now();
    console.debug('[CoworkSearch] requesting task sessions for the search modal', {
      hasQuery: !!trimmedQuery,
      queryLength: trimmedQuery?.length ?? 0,
      limit,
      offset,
    });

    try {
      const result = await window.electron?.cowork?.listSessions({
        limit,
        offset,
        ...(trimmedQuery ? { searchQuery: trimmedQuery } : {}),
      });
      const resolved = result ?? { success: false, error: 'Cowork IPC is unavailable' };
      console.debug('[CoworkSearch] task session request finished', {
        success: resolved.success,
        resultCount: resolved.sessions?.length ?? 0,
        hasMore: resolved.hasMore ?? false,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return resolved;
    } catch (error) {
      console.warn('[CoworkSearch] task session request failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to search sessions',
      };
    }
  }

  async loadMoreSessions(): Promise<boolean> {
    const state = store.getState().cowork;
    if (!state.hasMoreSessions) return false;

    const offset = state.sessions.length;
    const result = await window.electron?.cowork?.listSessions({ limit: COWORK_SESSION_PAGE_SIZE, offset });
    if (result?.success && result.sessions) {
      store.dispatch(appendSessions({ sessions: result.sessions, hasMore: result.hasMore ?? false }));
      return true;
    }
    return false;
  }

  async loadConfig(): Promise<void> {
    const [coworkResult, sessionPolicyResult] = await Promise.all([
      window.electron?.cowork?.getConfig(),
      window.electron?.openclaw?.sessionPolicy?.get?.(),
    ]);

    if (coworkResult?.success && coworkResult.config) {
      const cfg = coworkResult.config as unknown as Record<string, unknown>;
      store.dispatch(setConfig({
        ...coworkResult.config,
        dreamingEnabled: (cfg.dreamingEnabled as boolean) ?? false,
        dreamingFrequency: (cfg.dreamingFrequency as string) ?? '0 3 * * *',
        dreamingModel: (cfg.dreamingModel as string) ?? '',
        dreamingTimezone: (cfg.dreamingTimezone as string) ?? '',
        openClawSessionPolicy: sessionPolicyResult?.success && sessionPolicyResult.config
          ? sessionPolicyResult.config
          : { keepAlive: '30d' },
      }));
    }
  }

  async loadOpenClawEngineStatus(): Promise<OpenClawEngineStatus | null> {
    this.setupOpenClawEngineListeners();
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.getStatus) {
      return null;
    }
    const result = await engineApi.getStatus();
    if (result?.success && result.status) {
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
  }

  async startSession(options: CoworkStartOptions): Promise<{ session: CoworkSession | null; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return { session: null, error: 'Cowork API not available' };
    }

    store.dispatch(setStreaming(true));

    const result = await cowork.startSession(options);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      if (result.session.status !== 'running') {
        store.dispatch(setStreaming(false));
      }
      return { session: result.session };
    }

    if (result.engineStatus) {
      this.notifyOpenClawStatus(result.engineStatus);
    }

    // Show a user-visible error when session start fails
    if (result.error) {
      const errorContent = result.code === 'ENGINE_NOT_READY'
        ? i18nService.t('coworkErrorEngineNotReady')
        : classifyError(result.error);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: errorContent }));
    }

    store.dispatch(setStreaming(false));
    console.error('Failed to start session:', result.error);
    return { session: null, error: result.error };
  }

  async continueSession(options: CoworkContinueOptions): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return false;
    }

    const state = store.getState().cowork;
    if (state.compactingSessionIds.includes(options.sessionId)) {
      console.debug(`[CoworkService] continue was ignored because manual context compaction is running for session ${options.sessionId}.`);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkContextCompactingSendBlocked'),
      }));
      return false;
    }

    store.dispatch(setStreaming(true));
    store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'running' }));

    const result = await cowork.continueSession({
      sessionId: options.sessionId,
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      activeSkillIds: options.activeSkillIds,
      runtimeSkillIds: options.runtimeSkillIds,
      kitIds: options.kitIds,
      kitReferences: options.kitReferences,
      resolvedKitCapabilities: options.resolvedKitCapabilities,
      imageAttachments: options.imageAttachments,
      mediaSelection: options.mediaSelection,
      mediaReferences: options.mediaReferences,
      selectedTextSnippets: options.selectedTextSnippets,
    });
    if (!result.success) {
      store.dispatch(setStreaming(false));
      if (result.engineStatus) {
        this.notifyOpenClawStatus(result.engineStatus);
      }
      if (result.code !== 'ENGINE_NOT_READY') {
        store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'error' }));
        if (result.error) {
          store.dispatch(addMessage({
            sessionId: options.sessionId,
            message: {
              id: `error-${Date.now()}`,
              type: 'system',
              content: i18nService.t('coworkErrorSessionContinueFailed').replace('{error}', result.error),
              timestamp: Date.now(),
            },
          }));
        }
      }
      // Show a user-visible error message in the session
      if (result.error) {
        const errorContent = result.code === 'ENGINE_NOT_READY'
          ? i18nService.t('coworkErrorEngineNotReady')
          : classifyError(result.error);
        store.dispatch(addMessage({
          sessionId: options.sessionId,
          message: {
            id: `error-${Date.now()}`,
            type: 'system',
            content: errorContent,
            timestamp: Date.now(),
          },
        }));
      }
      console.error('Failed to continue session:', result.error);
      return false;
    }

    return true;
  }

  async runGoalCommand(options: { sessionId: string; command: string }): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.runGoalCommand) {
      console.error('Cowork goal command API not available');
      return false;
    }

    const command = options.command.trim();
    const action = command.split(/\s+/, 2)[1] ?? 'status';
    const normalizedAction = action.toLowerCase();
    const mayStartRun =
      normalizedAction === 'start'
      || normalizedAction === 'create'
      || normalizedAction === 'set'
      || normalizedAction === 'resume';
    this.logDiagnostic(
      'debug',
      `running goal command for session ${options.sessionId}, action ${action}`,
    );
    const stateBeforeGoalCommand = store.getState();
    const currentSessionBeforeGoalCommand = stateBeforeGoalCommand.cowork.currentSession?.id === options.sessionId
      ? stateBeforeGoalCommand.cowork.currentSession
      : undefined;
    const listedSessionBeforeGoalCommand = stateBeforeGoalCommand.cowork.sessions.find(
      session => session.id === options.sessionId,
    );
    const previousStatus = currentSessionBeforeGoalCommand?.status ?? listedSessionBeforeGoalCommand?.status;
    if (mayStartRun) {
      store.dispatch(setStreaming(true));
      store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'running' }));
    }
    const result = await cowork.runGoalCommand({
      sessionId: options.sessionId,
      command,
    });
    if (!result.success) {
      if (mayStartRun) {
        store.dispatch(setStreaming(false));
        if (previousStatus && previousStatus !== 'running') {
          store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: previousStatus }));
        }
      }
      if (result.engineStatus) {
        this.notifyOpenClawStatus(result.engineStatus);
      }
      const errorContent = result.code === 'ENGINE_NOT_READY'
        ? i18nService.t('coworkErrorEngineNotReady')
        : classifyError(result.error || 'Failed to run goal command');
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: errorContent }));
      console.error('[CoworkGoal] goal command failed:', result.error);
      return false;
    }

    store.dispatch(updateSessionGoal({ sessionId: options.sessionId, goal: result.goal ?? null }));
    return true;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    this.logDiagnostic('info', `stop requested for session ${sessionId}.`);
    const result = await cowork.stopSession(sessionId);
    if (result.success) {
      store.dispatch(setStreaming(false));
      store.dispatch(updateSessionStatus({ sessionId, status: 'idle' }));
      this.logDiagnostic('info', `stop completed for session ${sessionId}.`);
      return true;
    }

    this.logDiagnostic('warn', `stop failed for session ${sessionId}: ${result.error ?? 'Unknown error'}.`);
    return false;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.deleteSession(sessionId);
    if (result.success) {
      store.dispatch(deleteSessionAction(sessionId));
      return true;
    }

    console.error('Failed to delete session:', result.error);
    return false;
  }

  async deleteSessions(sessionIds: string[]): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.deleteSessions(sessionIds);
    if (result.success) {
      store.dispatch(deleteSessionsAction(sessionIds));
      return true;
    }

    console.error('Failed to batch delete sessions:', result.error);
    return false;
  }

  async deleteSubagentSession(parentSessionId: string, runId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.deleteSubagentSession) return false;

    const result = await cowork.deleteSubagentSession({ parentSessionId, runId });
    if (result.success) {
      return result.deleted ?? true;
    }

    console.error('Failed to delete subagent session:', result.error);
    return false;
  }

  async setSessionPinned(sessionId: string, pinned: boolean): Promise<{ success: boolean; pinOrder: number | null }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionPinned) return { success: false, pinOrder: null };

    const result = await cowork.setSessionPinned({ sessionId, pinned });
    if (result.success) {
      const pinOrder = result.pinOrder ?? null;
      store.dispatch(updateSessionPinned({ sessionId, pinned, pinOrder }));
      return { success: true, pinOrder };
    }

    console.error('Failed to update session pin:', result.error);
    return { success: false, pinOrder: null };
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.renameSession) return false;

    const normalizedTitle = title.trim();
    if (!normalizedTitle) return false;

    const result = await cowork.renameSession({ sessionId, title: normalizedTitle });
    if (result.success) {
      store.dispatch(updateSessionTitle({ sessionId, title: normalizedTitle }));
      return true;
    }

    console.error('Failed to rename session:', result.error);
    return false;
  }

  async forkSession(options: CoworkForkSessionOptions): Promise<{ session: CoworkSession | null; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.forkSession) {
      console.warn('[CoworkFork] fork API is unavailable in the renderer bridge');
      return { session: null, error: 'Cowork fork API is unavailable' };
    }

    console.log(`[CoworkFork] requesting a local conversation fork for session ${options.sessionId}`);
    try {
      const result = await cowork.forkSession(options);
      if (result.success && result.session) {
        store.dispatch(addSession(result.session));
        store.dispatch(setStreaming(false));
        console.log(`[CoworkFork] renderer received forked session ${result.session.id} successfully`);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('coworkForkCreated'),
        }));
        return { session: result.session };
      }

      const error = result.error || i18nService.t('coworkForkFailed');
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: error }));
      console.warn(`[CoworkFork] renderer fork request for session ${options.sessionId} was rejected`);
      return { session: null, error };
    } catch (error) {
      const message = error instanceof Error ? error.message : i18nService.t('coworkForkFailed');
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
      console.error('[CoworkFork] renderer fork request failed:', error);
      return { session: null, error: message };
    }
  }

  async exportSessionResultImage(options: {
    rect: { x: number; y: number; width: number; height: number };
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.exportResultImage) {
      return { success: false, error: 'Cowork export API not available' };
    }

    try {
      const result = await cowork.exportResultImage(options);
      return result ?? { success: false, error: 'Failed to export session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session image',
      };
    }
  }

  async captureSessionImageChunk(options: {
    rect: { x: number; y: number; width: number; height: number };
  }): Promise<{ success: boolean; width?: number; height?: number; pngBase64?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.captureImageChunk) {
      return { success: false, error: 'Cowork capture API not available' };
    }

    try {
      const result = await cowork.captureImageChunk(options);
      return result ?? { success: false, error: 'Failed to capture session image chunk' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
      };
    }
  }

  async saveSessionResultImage(options: {
    pngBase64: string;
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.saveResultImage) {
      return { success: false, error: 'Cowork save image API not available' };
    }

    try {
      const result = await cowork.saveResultImage(options);
      return result ?? { success: false, error: 'Failed to save session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save session image',
      };
    }
  }

  async exportSessionDiagnostics(options: {
    sessionId: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.exportSessionDiagnostics) {
      return { success: false, error: 'Cowork diagnostics export API not available' };
    }

    try {
      const result = await cowork.exportSessionDiagnostics(options);
      return result ?? { success: false, error: 'Failed to export session diagnostics' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session diagnostics',
      };
    }
  }

  async loadSession(sessionId: string): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork) return null;
    const requestId = ++this.latestLoadSessionRequestId;

    const result = await cowork.getSession(sessionId);
    if (result.success && result.session) {
      this.logDiagnostic(
        'info',
        `received session ${sessionId}; returned ${result.session.messages.length} of ${result.session.totalMessages} messages from offset ${result.session.messagesOffset}.`,
      );
      // Keep only the latest session load result to avoid stale async overwrites.
      if (requestId !== this.latestLoadSessionRequestId) {
        this.logDiagnostic('debug', `ignored stale session load result for session ${sessionId}.`);
        return result.session;
      }
      store.dispatch(setCurrentSession(result.session));
      store.dispatch(setStreaming(result.session.status === 'running'));
      void this.loadSessionMessageRailIndex(sessionId);
      void cowork.markSessionViewed?.(sessionId).catch((error: unknown) => {
        console.warn('[CoworkService] failed to mark session viewed:', error);
      });

      const imResult = await cowork.remoteManaged(sessionId);
      if (requestId === this.latestLoadSessionRequestId) {
        store.dispatch(setRemoteManaged(imResult?.remoteManaged ?? false));
      }

      return result.session;
    }

    console.error('Failed to load session:', result.error);
    return null;
  }

  async loadSessionMessageRailIndex(sessionId: string): Promise<CoworkMessageRailIndexItem[]> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionMessageRailIndex) return [];

    const state = store.getState().cowork;
    if (state.messageRailIndexLoadingBySessionId[sessionId]) {
      return state.messageRailIndexBySessionId[sessionId] ?? [];
    }

    store.dispatch(setMessageRailIndexLoading({ sessionId, loading: true }));
    try {
      const result = await cowork.getSessionMessageRailIndex(sessionId);
      if (result.success && result.items) {
        store.dispatch(setMessageRailIndex({ sessionId, items: result.items }));
        this.logDiagnostic(
          'info',
          `loaded message rail index for session ${sessionId}; received ${result.items.length} items.`,
        );
        return result.items;
      }
      this.logDiagnostic('warn', `failed to load message rail index for session ${sessionId}: ${result.error ?? 'unknown error'}`);
    } catch (error) {
      this.logDiagnostic(
        'warn',
        `failed to load message rail index for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      store.dispatch(setMessageRailIndexLoading({ sessionId, loading: false }));
    }
    return [];
  }

  async loadMessageWindowAroundIndex(sessionId: string, absoluteIndex: number, pageSize = 50): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionMessages) return false;

    const state = store.getState().cowork;
    if (state.currentSession?.id !== sessionId) return false;

    const totalMessages = state.currentSession.totalMessages;
    const safeAbsoluteIndex = Number.isFinite(absoluteIndex) ? Math.max(0, Math.floor(absoluteIndex)) : 0;
    const safePageSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : 50;
    const boundedPageSize = Math.max(COWORK_MESSAGE_PAGE_SIZE, Math.min(100, safePageSize));
    const offset = Math.max(0, Math.min(
      Math.max(0, totalMessages - boundedPageSize),
      safeAbsoluteIndex - Math.floor(boundedPageSize / 2),
    ));

    this.logDiagnostic(
      'info',
      `loading message window for session ${sessionId}; absoluteIndex=${safeAbsoluteIndex}, offset=${offset}, limit=${boundedPageSize}.`,
    );

    const result = await cowork.getSessionMessages({ sessionId, limit: boundedPageSize, offset });
    if (result.success && result.messages && result.messages.length > 0) {
      store.dispatch(setMessageWindow({
        sessionId,
        messages: result.messages,
        messagesOffset: result.offset ?? offset,
        totalMessages: result.total ?? totalMessages,
      }));
      return true;
    }

    this.logDiagnostic(
      result.success ? 'info' : 'warn',
      `message window load for session ${sessionId} returned no messages at offset ${offset}: ${result.error ?? 'empty result'}.`,
    );
    return false;
  }

  /** Load older messages for the current session (for scroll-up history). */
  async loadMoreMessages(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionMessages) return false;

    const state = store.getState().cowork;
    if (state.currentSession?.id !== sessionId) return false;

    const currentOffset = state.currentSession.messagesOffset;
    if (currentOffset <= 0) return false;

    const PAGE_SIZE = 50;
    const newOffset = Math.max(0, currentOffset - PAGE_SIZE);
    const limit = currentOffset - newOffset;
    const currentMessageCount = state.currentSession.messages.length;
    const totalMessages = state.currentSession.totalMessages;

    this.logDiagnostic(
      'info',
      `loading older messages for session ${sessionId}; current view has ${currentMessageCount} of ${totalMessages} messages from offset ${currentOffset}.`,
    );

    const result = await cowork.getSessionMessages({ sessionId, limit, offset: newOffset });
    if (result.success && result.messages && result.messages.length > 0) {
      store.dispatch(prependMessages({ sessionId, messages: result.messages, newOffset }));
      const nextCount = store.getState().cowork.currentSession?.messages.length ?? currentMessageCount;
      this.logDiagnostic(
        'info',
        `prepended older messages for session ${sessionId}; added ${result.messages.length} messages from offset ${newOffset}, and the view now has ${nextCount} of ${result.total ?? totalMessages} messages.`,
      );
      return true;
    }
    if (result.success) {
      this.logDiagnostic('info', `older message page for session ${sessionId} was empty at offset ${newOffset}.`);
    } else {
      this.logDiagnostic('warn', `failed to load older messages for session ${sessionId}: ${result.error ?? 'unknown error'}`);
    }
    return false;
  }

  async patchSession(sessionId: string, patch: OpenClawSessionPatch): Promise<CoworkSession | null> {
    const sessionApi = window.electron?.openclaw?.session;
    if (!sessionApi?.patch) {
      console.error('OpenClaw session patch API not available');
      return null;
    }

    const result = await sessionApi.patch({ sessionId, patch });
    if (result.success && result.session) {
      const currentSessionId = store.getState().cowork.currentSessionId;
      if (currentSessionId === sessionId) {
        store.dispatch(setCurrentSession(result.session));
        store.dispatch(setStreaming(result.session.status === 'running'));
        void this.refreshContextUsage(sessionId, { notifyCompaction: false });
      }
      return result.session;
    }

    console.error('Failed to patch session:', result.error);
    return null;
  }

  async respondToPermission(requestId: string, result: CoworkPermissionResult): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const response = await cowork.respondToPermission({ requestId, result });
    if (response.success) {
      store.dispatch(dequeuePendingPermission({ requestId }));
      return true;
    }

    console.error('Failed to respond to permission:', response.error);
    return false;
  }

  async updateConfig(config: CoworkConfigUpdate): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const currentConfig = store.getState().cowork.config;
    const engineChanged = config.agentEngine !== undefined
      && config.agentEngine !== currentConfig.agentEngine;
    const result = await cowork.setConfig(config);
    if (result.success) {
      store.dispatch(setConfig({ ...currentConfig, ...config }));
      if (engineChanged) {
        store.dispatch(clearPendingPermissions());
        store.dispatch(setStreaming(false));
      }
      return true;
    }

    console.error('Failed to update config:', result.error);
    return false;
  }

  async updateSessionPolicy(config: OpenClawSessionPolicyConfig): Promise<boolean> {
    const sessionPolicyApi = window.electron?.openclaw?.sessionPolicy;
    if (!sessionPolicyApi) return false;

    const currentConfig = store.getState().cowork.config;
    const result = await sessionPolicyApi.set(config);
    if (result.success) {
      store.dispatch(setConfig({
        ...currentConfig,
        openClawSessionPolicy: result.config ?? config,
      }));
      return true;
    }

    console.error('Failed to update OpenClaw session policy:', result.error);
    return false;
  }

  async getApiConfig(): Promise<CoworkApiConfig | null> {
    if (!window.electron?.getApiConfig) {
      return null;
    }
    return window.electron.getApiConfig();
  }

  async checkApiConfig(options?: { probeModel?: boolean }): Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string } | null> {
    if (!window.electron?.checkApiConfig) {
      return null;
    }
    return window.electron.checkApiConfig(options);
  }

  async saveApiConfig(config: CoworkApiConfig): Promise<{ success: boolean; error?: string } | null> {
    if (!window.electron?.saveApiConfig) {
      return null;
    }
    return window.electron.saveApiConfig(config);
  }

  async listMemoryEntries(input: {
    query?: string;
    limit?: number;
    offset?: number;
  }): Promise<CoworkUserMemoryEntry[]> {
    const api = window.electron?.cowork?.listMemoryEntries;
    if (!api) return [];
    const result = await api(input);
    if (!result?.success || !result.entries) return [];
    return result.entries;
  }

  async createMemoryEntry(input: {
    text: string;
  }): Promise<CoworkUserMemoryEntry | null> {
    const api = window.electron?.cowork?.createMemoryEntry;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  async updateMemoryEntry(input: {
    id: string;
    text: string;
  }): Promise<CoworkUserMemoryEntry | null> {
    const api = window.electron?.cowork?.updateMemoryEntry;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  async deleteMemoryEntry(input: { id: string }): Promise<boolean> {
    const api = window.electron?.cowork?.deleteMemoryEntry;
    if (!api) return false;
    const result = await api(input);
    return Boolean(result?.success);
  }

  async getMemoryStats(): Promise<CoworkMemoryStats | null> {
    const api = window.electron?.cowork?.getMemoryStats;
    if (!api) return null;
    const result = await api();
    if (!result?.success || !result.stats) return null;
    return result.stats;
  }

  async readMemoryFileRaw(): Promise<string | null> {
    const api = window.electron?.cowork?.readMemoryFileRaw;
    if (!api) return null;
    const result = await api();
    if (!result?.success) return null;
    return result.content ?? '';
  }

  async writeMemoryFileRaw(content: string): Promise<{ success: boolean; error?: string }> {
    const api = window.electron?.cowork?.writeMemoryFileRaw;
    if (!api) return { success: false, error: 'Memory raw API unavailable' };
    const result = await api({ content });
    return result ?? { success: false };
  }

  async readBootstrapFile(filename: string): Promise<string> {
    const api = window.electron?.cowork?.readBootstrapFile;
    if (!api) return '';
    const result = await api(filename);
    if (!result?.success) {
      console.warn(`[CoworkService] readBootstrapFile: failed to read ${filename}`, result?.error);
      return '';
    }
    return result.content || '';
  }

  async writeBootstrapFile(filename: string, content: string): Promise<boolean> {
    const api = window.electron?.cowork?.writeBootstrapFile;
    if (!api) return false;
    const result = await api(filename, content);
    return Boolean(result?.success);
  }

  onOpenClawEngineStatus(callback: (status: OpenClawEngineStatus) => void): () => void {
    this.setupOpenClawEngineListeners();
    this.openClawStatusListeners.add(callback);
    if (this.openClawStatus) {
      callback(this.openClawStatus);
    }
    return () => {
      this.openClawStatusListeners.delete(callback);
    };
  }

  async getOpenClawEngineStatus(): Promise<OpenClawEngineStatus | null> {
    return this.loadOpenClawEngineStatus();
  }

  /** Last known engine status without an IPC round-trip (may be stale/null). */
  getOpenClawEngineStatusSnapshot(): OpenClawEngineStatus | null {
    return this.openClawStatus;
  }

  async installOpenClawEngine(): Promise<OpenClawEngineStatus | null> {
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.install) {
      return null;
    }
    const result = await engineApi.install();
    if (result?.status) {
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
  }

  async retryOpenClawInstall(): Promise<OpenClawEngineStatus | null> {
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.retryInstall) {
      return null;
    }
    const result = await engineApi.retryInstall();
    if (result?.status) {
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
  }

  async restartOpenClawGateway(): Promise<OpenClawEngineStatus | null> {
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.restartGateway) {
      return null;
    }
    const result = await engineApi.restartGateway();
    if (result?.status) {
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
  }

  async repairOpenClawGatewayState(): Promise<OpenClawGatewayRepairResult> {
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.repairGatewayState) {
      return {
        success: false,
        error: i18nService.t('openClawRepairApiUnavailable'),
      };
    }
    const result = await engineApi.repairGatewayState();
    if (result?.status) {
      this.notifyOpenClawStatus(result.status);
    }
    return result ?? {
      success: false,
      error: i18nService.t('openClawRepairFailed'),
    };
  }

  async generateSessionTitle(prompt: string | null): Promise<string | null> {
    if (!window.electron?.generateSessionTitle) {
      return null;
    }
    return window.electron.generateSessionTitle(prompt);
  }

  async getRecentCwds(limit?: number): Promise<string[]> {
    if (!window.electron?.getRecentCwds) {
      return [];
    }
    return window.electron.getRecentCwds(limit);
  }

  clearSession(options: { restoreAgentSkills?: boolean } = {}): void {
    store.dispatch(clearCurrentSession());
    if (options.restoreAgentSkills) {
      restoreCurrentAgentDefaultSkills();
    }
  }

  destroy(): void {
    this.cleanupListeners();
    this.openClawStatusListeners.clear();
    this.initialized = false;
  }
}

export const coworkService = new CoworkService();
