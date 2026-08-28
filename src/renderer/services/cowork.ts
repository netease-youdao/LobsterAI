import { classifyErrorKey } from '../../common/coworkErrorClassify';
import {
  ContextCompactionMode,
  ContextCompactionStatus,
  CoworkSystemMessageKind,
} from '../../common/coworkSystemMessages';
import type { OpenClawSessionPatch } from '../../common/openclawSession';
import {
  type CoworkBtwAbortRequest,
  CoworkBtwStatus,
  type CoworkBtwSubmitRequest,
  normalizeCoworkBtwQuestion,
} from '../../shared/cowork/btw';
import {
  COWORK_MESSAGE_PAGE_SIZE,
  COWORK_SESSION_PAGE_SIZE,
  CoworkContextUsageRefreshMode,
  type CoworkContextUsageRefreshMode as CoworkContextUsageRefreshModeType,
  CoworkContextUsageSource,
} from '../../shared/cowork/constants';
import { normalizeCoworkGoal } from '../../shared/cowork/goal';
import type { CoworkMessageRailIndexItem } from '../../shared/cowork/rail';
import type { CoworkSelectedTextSnippet } from '../../shared/cowork/selectedText';
import {
  type CoworkSteerRequest,
  CoworkSteerStatus,
} from '../../shared/cowork/steer';
import { store } from '../store';
import {
  addMessage,
  addPendingSteer,
  addSession,
  appendBtwEntry,
  appendNewerMessages,
  appendSessions,
  clearCurrentSession,
  clearPendingPermissions,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  dequeuePendingPermission,
  enqueuePendingPermission,
  finishSessionNavigation as finishSessionNavigationAction,
  markCompactionNotified,
  openBtwThread,
  prependMessages,
  setAgentSessions,
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
  settleBtwEntry,
  updateCurrentSessionModelOverride,
  updateMessageContent,
  updateSessionGoal,
  updateSessionPinned,
  updateSessionStatus,
  updateSessionTitle,
  updateSteerStatus,
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
import { CoworkSessionStatusValue } from '../types/cowork';
import { CoworkQueuedFollowUpCoordinator } from './coworkQueuedFollowUpCoordinator';
import {
  getPreservedMessageWindow,
  shouldReloadCurrentSessionForChange,
} from './coworkSessionRefreshPolicy';
import { i18nService } from './i18n';

const STREAM_ERROR_DUPLICATE_WINDOW_MS = 10_000;

interface LoadMessageWindowAroundIndexOptions {
  pageSize?: number;
  expectedMessageId?: string;
  isRequestCurrent?: () => boolean;
}

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
const COWORK_INIT_STAGE_TIMEOUT_MS = 12_000;

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
  // Only the current session can request a history window, so one monotonic
  // generation invalidates stale responses without retaining session ids.
  private messageWindowRequestGeneration = 0;
  private contextUsageRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private contextUsageInFlightBySessionId = new Map<string, Promise<CoworkContextUsage | null>>();
  private contextUsageAutoSuppressedUntilBySessionId = new Map<string, number>();
  private contextUsageBackoffUntil = new Map<string, number>();
  private contextCompactionWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly btwAbortRunIds = new Set<string>();
  private readonly queuedFollowUpCoordinator = new CoworkQueuedFollowUpCoordinator({
    getState: () => store.getState(),
    dispatch: store.dispatch,
    continueSession: options => this.continueSession(options),
    stopSession: sessionId => this.stopSessionRuntime(sessionId),
    log: (level, message, error) => {
      this.logDiagnostic(level, `[CoworkSteer] ${message}`, error);
    },
  });

  private logDiagnostic(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    error?: unknown,
  ): void {
    const formatted = `[CoworkService] ${message}`;
    if (level === 'warn') {
      console.warn(formatted, ...(error === undefined ? [] : [error]));
    } else if (level === 'error') {
      console.error(formatted, ...(error === undefined ? [] : [error]));
    } else if (level === 'debug') {
      console.debug(formatted);
    } else {
      console.log(formatted);
    }
    const persistedMessage = error === undefined
      ? message
      : `${message} error=${error instanceof Error ? error.message : String(error)}`;
    try {
      window.electron?.log?.fromRenderer?.(
        level,
        'CoworkService',
        persistedMessage.replace(/\s+/g, ' ').trim().slice(0, 500),
      );
    } catch {
      // Diagnostics must never interrupt session or queued-follow-up handling.
    }
  }

  private setCurrentSessionStreaming(sessionId: string, isStreaming: boolean, reason: string): void {
    const state = store.getState().cowork;
    const currentSessionId = state.currentSession?.id ?? state.currentSessionId;
    if (currentSessionId !== sessionId) {
      this.logDiagnostic(
        'debug',
        `ignored streaming=${isStreaming} for non-current session ${sessionId}; current=${currentSessionId ?? 'none'}; reason=${reason}.`,
      );
      return;
    }
    store.dispatch(setStreaming(isStreaming));
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Attach listeners before reads so a slow initial snapshot cannot miss
    // real-time events. Each snapshot is isolated and bounded: the Cowork view
    // must never remain on a permanent loading screen because one IPC stalls.
    this.setupStreamListeners();
    this.setupOpenClawEngineListeners();

    const runStage = async (label: string, task: () => Promise<unknown>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          task(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} timed out after ${COWORK_INIT_STAGE_TIMEOUT_MS}ms`)),
              COWORK_INIT_STAGE_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (error) {
        this.logDiagnostic('warn', `initialization stage ${label} failed: ${String(error)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    await Promise.all([
      runStage('loadConfig', () => this.loadConfig()),
      runStage('loadSessions', () => this.loadSessions()),
      runStage('loadOpenClawEngineStatus', () => this.loadOpenClawEngineStatus()),
    ]);

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
        this.queuedFollowUpCoordinator.handleSessionRunning(sessionId);
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
        this.queuedFollowUpCoordinator.handleSessionRunning(sessionId);
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
        this.queuedFollowUpCoordinator.handleSessionRunning(sessionId);
      }
      store.dispatch(updateToolUseMediaStatus({ sessionId, toolCallId, details }));
    });
    if (mediaStatusPollCleanup) {
      this.streamListenerCleanups.push(mediaStatusPollCleanup);
    }

    const sessionStatusCleanup = cowork.onStreamSessionStatus?.(({ sessionId, status }) => {
      const coworkState = store.getState().cowork;
      const previousStatus = coworkState.sessions.find(session => session.id === sessionId)?.status
        ?? (coworkState.currentSession?.id === sessionId ? coworkState.currentSession.status : undefined);
      if (previousStatus !== status) {
        this.logDiagnostic(
          'debug',
          `received session status transition: session=${sessionId}; ${previousStatus ?? 'unknown'} -> ${status}.`,
        );
      }
      store.dispatch(updateSessionStatus({ sessionId, status }));
      this.setCurrentSessionStreaming(sessionId, status === 'running', `stream_status_${status}`);
      if (status === CoworkSessionStatusValue.Running) {
        this.queuedFollowUpCoordinator.handleSessionRunning(sessionId);
      } else if (status === CoworkSessionStatusValue.Completed) {
        this.queuedFollowUpCoordinator.handleSessionCompleted(sessionId);
      } else if (status === CoworkSessionStatusValue.Error) {
        this.queuedFollowUpCoordinator.handleSessionError(sessionId);
      } else if (status === CoworkSessionStatusValue.Idle) {
        this.queuedFollowUpCoordinator.handleSessionIdle(sessionId);
      }
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

    const btwResultCleanup = cowork.onStreamBtwResult?.(({ sessionId, result }) => {
      const existing = store.getState().cowork.btwThreadsBySessionId[sessionId]
        ?.entries.find(entry => entry.runId === result.runId);
      if (
        result.sessionId !== sessionId
        || !existing
        || existing.runId !== result.runId
        || existing.status !== CoworkBtwStatus.Pending
      ) {
        this.logDiagnostic(
          'debug',
          `[CoworkBtw] ignored result ${result.runId} without a matching renderer request `
          + `for session ${sessionId}; resultSession=${result.sessionId}; `
          + `current=${existing?.runId ?? 'none'}; status=${existing?.status ?? 'none'}`,
        );
        return;
      }
      store.dispatch(settleBtwEntry(result));
      this.logDiagnostic(
        'debug',
        `[CoworkBtw] received ${result.status} result for session ${sessionId}; run=${result.runId}`,
      );
    });
    if (btwResultCleanup) {
      this.streamListenerCleanups.push(btwResultCleanup);
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
      this.setCurrentSessionStreaming(sessionId, false, 'stream_complete');
      this.scheduleFinalContextUsageRefresh(sessionId, true);
      this.queuedFollowUpCoordinator.handleSessionCompleted(sessionId);
    });
    this.streamListenerCleanups.push(completeCleanup);

    // Error listener
    const errorCleanup = cowork.onStreamError(({ sessionId, error }) => {
      if (this.isStillRunningError(error)) {
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
        this.setCurrentSessionStreaming(sessionId, true, 'stream_error_still_running');
        this.queuedFollowUpCoordinator.handleSessionRunning(sessionId);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('coworkSessionStillRunning'),
        }));
        return;
      }
      store.dispatch(updateSessionStatus({ sessionId, status: 'error' }));
      this.setCurrentSessionStreaming(sessionId, false, 'stream_error');
      this.queuedFollowUpCoordinator.handleSessionError(sessionId);
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
    const sessionsChangedCleanup = cowork.onSessionsChanged((payload) => {
      const beforeState = store.getState().cowork;
      const changedSessionIds = Array.isArray(payload?.sessionIds) ? payload.sessionIds : [];
      const changeScope = changedSessionIds.length > 0
        ? `${changedSessionIds.slice(0, 5).join(',')}${changedSessionIds.length > 5 ? `,+${changedSessionIds.length - 5}` : ''}`
        : 'unscoped';
      this.logDiagnostic(
        'debug',
        `received sessions change; active=${beforeState.currentSessionId ?? 'none'}; changed=${changeScope}.`,
      );
      void this.loadSessions().then(() => {
        const state = store.getState().cowork;

        // Reload the active conversation only when that session changed.
        // Preserve any older history the user already paged in so a scoped
        // refresh cannot collapse the view back to the default tail window.
        const currentId = state.currentSessionId;
        const shouldReloadCurrent = shouldReloadCurrentSessionForChange(currentId, payload);
        this.logDiagnostic(
          'debug',
          `processed sessions change; active=${currentId ?? 'none'}; changed=${changeScope}; reloadActive=${shouldReloadCurrent}.`,
        );
        if (currentId && shouldReloadCurrent) {
          void this.loadSession(currentId, { preserveLoadedRange: true }).catch((error: unknown) => {
            this.logDiagnostic(
              'error',
              `failed to refresh changed active session ${currentId}.`,
              error,
            );
          });
        }
      }).catch((err) => {
        this.logDiagnostic('error', 'failed to refresh the session list after a sessions change.', err);
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
    this.messageWindowRequestGeneration += 1;
    this.btwAbortRunIds.clear();
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
      store.dispatch(agentId ? setAgentSessions(result.sessions) : setSessions(result.sessions));
      store.dispatch(setHasMoreSessions(result.hasMore ?? false));
      result.sessions.forEach((session) => {
        if (
          session.status === CoworkSessionStatusValue.Completed
          && (store.getState().cowork.pendingSteers[session.id]?.length ?? 0) > 0
        ) {
          this.queuedFollowUpCoordinator.handleSessionCompleted(session.id);
        }
      });
    }
  }

  async listSessionsForAgentPreview(
    agentId: string,
    limit: number,
    offset: number,
  ): Promise<CoworkSessionListResult> {
    try {
      const result = await window.electron?.cowork?.listSessions({ limit, offset, agentId });
      const resolved = result ?? { success: false, error: 'Cowork IPC is unavailable' };
      if (!resolved.success) {
        this.logDiagnostic(
          'warn',
          `agent sidebar session page request failed; agent=${agentId}; offset=${offset}; limit=${limit}; error=${resolved.error ?? 'unknown'}.`,
        );
      }
      return resolved;
    } catch (error) {
      this.logDiagnostic(
        'warn',
        `agent sidebar session page request threw; agent=${agentId}; offset=${offset}; limit=${limit}.`,
        error,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load agent task sessions',
      };
    }
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

    this.setCurrentSessionStreaming(options.sessionId, true, 'continue_session_requested');
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
      browserAnnotations: options.browserAnnotations,
    });
    if (!result.success) {
      this.setCurrentSessionStreaming(options.sessionId, false, 'continue_session_failed');
      if (result.engineStatus) {
        this.notifyOpenClawStatus(result.engineStatus);
      }
      if (result.code !== 'ENGINE_NOT_READY') {
        store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'error' }));
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

  async submitSteer(options: CoworkSteerRequest): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.submitSteer) {
      console.error('Cowork steer API not available');
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkSteerUnavailable'),
      }));
      return false;
    }

    const text = options.text.trim();
    if (!text) {
      return false;
    }

    const now = Date.now();
    const authStateAtStart = store.getState().auth;
    store.dispatch(addPendingSteer({
      id: options.clientSteerId,
      sessionId: options.sessionId,
      ownerAccountKey: authStateAtStart.ownerAccountKey,
      accountGeneration: authStateAtStart.accountGeneration,
      text,
      status: CoworkSteerStatus.Pending,
      createdAt: now,
      updatedAt: now,
    }));

    this.logDiagnostic(
      'debug',
      `submitting steer ${options.clientSteerId} for session ${options.sessionId}; chars=${text.length}`,
    );

    try {
      const result = await cowork.submitSteer({
        ...options,
        text,
      });
      const currentAuthState = store.getState().auth;
      if (
        currentAuthState.ownerAccountKey !== authStateAtStart.ownerAccountKey
        || currentAuthState.accountGeneration !== authStateAtStart.accountGeneration
      ) {
        this.logDiagnostic(
          'warn',
          `discarded steer ${options.clientSteerId} response after the account changed`,
        );
        return false;
      }
      if (result?.success && result.status === CoworkSteerStatus.Accepted) {
        store.dispatch(updateSteerStatus({
          sessionId: options.sessionId,
          steerId: options.clientSteerId,
          status: CoworkSteerStatus.Accepted,
        }));
        this.logDiagnostic(
          'debug',
          `steer ${options.clientSteerId} accepted for session ${options.sessionId}`,
        );
        return true;
      }

      const error = result?.error || i18nService.t('coworkSteerRejected');
      store.dispatch(updateSteerStatus({
        sessionId: options.sessionId,
        steerId: options.clientSteerId,
        status: CoworkSteerStatus.Rejected,
        error,
        reason: result?.reason,
      }));
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: error }));
      this.logDiagnostic(
        'warn',
        `steer ${options.clientSteerId} rejected for session ${options.sessionId}; `
        + `reason=${result?.reason ?? 'unknown'}; error=${error}`,
      );
      return false;
    } catch (error) {
      const currentAuthState = store.getState().auth;
      if (
        currentAuthState.ownerAccountKey !== authStateAtStart.ownerAccountKey
        || currentAuthState.accountGeneration !== authStateAtStart.accountGeneration
      ) {
        return false;
      }
      const message = error instanceof Error ? error.message : 'Failed to submit steer input';
      store.dispatch(updateSteerStatus({
        sessionId: options.sessionId,
        steerId: options.clientSteerId,
        status: CoworkSteerStatus.Rejected,
        error: message,
      }));
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
      this.logDiagnostic(
        'error',
        `steer ${options.clientSteerId} failed for session ${options.sessionId}; error=${message}`,
      );
      return false;
    }
  }

  async submitBtw(
    options: CoworkBtwSubmitRequest & {
      displayQuestion?: string;
      selectedTextSnippets?: CoworkSelectedTextSnippet[];
    },
  ): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.submitBtw || !cowork.onStreamBtwResult) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkBtwUnavailable'),
      }));
      this.logDiagnostic(
        'warn',
        `[CoworkBtw] API unavailable for session ${options.sessionId}`,
      );
      return false;
    }

    const question = normalizeCoworkBtwQuestion(options.question);
    const selectedTextSnippets = (options.selectedTextSnippets ?? []).map(
      snippet => ({ ...snippet }),
    );
    const normalizedDisplayQuestion = normalizeCoworkBtwQuestion(
      options.displayQuestion ?? options.question,
    );
    const displayQuestion = normalizedDisplayQuestion
      || (selectedTextSnippets.length > 0 ? '' : question);
    if (!question) {
      return false;
    }
    const existing = store.getState().cowork.btwThreadsBySessionId[options.sessionId]
      ?.entries.find(entry => entry.status === CoworkBtwStatus.Pending);
    if (existing) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkBtwAlreadyPending'),
      }));
      this.logDiagnostic(
        'debug',
        `[CoworkBtw] ignored duplicate submission for session ${options.sessionId}; pending=${existing.runId}`,
      );
      return false;
    }

    const createdAt = Date.now();
    store.dispatch(openBtwThread({ sessionId: options.sessionId }));
    store.dispatch(appendBtwEntry({
      runId: options.runId,
      sessionId: options.sessionId,
      question: displayQuestion,
      ...(selectedTextSnippets.length > 0 ? { selectedTextSnippets } : {}),
      status: CoworkBtwStatus.Pending,
      createdAt,
    }));
    this.logDiagnostic(
      'debug',
      `[CoworkBtw] submitting run ${options.runId} for session ${options.sessionId}; chars=${question.length}`,
    );

    try {
      const result = await cowork.submitBtw({
        sessionId: options.sessionId,
        runId: options.runId,
        question,
      });
      if (result.success) {
        return true;
      }
      const current = store.getState().cowork.btwThreadsBySessionId[options.sessionId]
        ?.entries.find(entry => entry.runId === options.runId);
      const error = result.error
        ? classifyError(result.error)
        : i18nService.t('coworkBtwFailed');
      if (current?.runId === options.runId && current.status === CoworkBtwStatus.Pending) {
        store.dispatch(settleBtwEntry({
          ...current,
          status: CoworkBtwStatus.Failed,
          error,
          completedAt: Date.now(),
        }));
      }
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: error }));
      this.logDiagnostic(
        'warn',
        `[CoworkBtw] rejected run ${options.runId} for session ${options.sessionId}; errorChars=${error.length}`,
      );
      return false;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : i18nService.t('coworkBtwFailed');
      const current = store.getState().cowork.btwThreadsBySessionId[options.sessionId]
        ?.entries.find(entry => entry.runId === options.runId);
      if (current?.runId === options.runId && current.status === CoworkBtwStatus.Pending) {
        store.dispatch(settleBtwEntry({
          ...current,
          status: CoworkBtwStatus.Failed,
          error: message,
          completedAt: Date.now(),
        }));
      }
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
      this.logDiagnostic(
        'error',
        `[CoworkBtw] transport failed for run ${options.runId} in session ${options.sessionId}; `
        + `errorType=${error instanceof Error ? error.name : typeof error}; `
        + `errorChars=${message.length}`,
      );
      return false;
    }
  }

  async abortBtw(options: CoworkBtwAbortRequest): Promise<boolean> {
    const abortKey = JSON.stringify([options.sessionId, options.runId]);
    const current = store.getState().cowork.btwThreadsBySessionId[options.sessionId]
      ?.entries.find(entry => entry.runId === options.runId);
    if (!current || current.status !== CoworkBtwStatus.Pending) {
      this.logDiagnostic(
        'debug',
        `[CoworkBtw] ignored stop without a matching pending renderer request; `
        + `session=${options.sessionId}; run=${options.runId}`,
      );
      return false;
    }
    if (this.btwAbortRunIds.has(abortKey)) {
      this.logDiagnostic(
        'debug',
        `[CoworkBtw] ignored duplicate stop; session=${options.sessionId}; run=${options.runId}`,
      );
      return false;
    }

    const cowork = window.electron?.cowork;
    if (!cowork?.abortBtw) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkBtwUnavailable'),
      }));
      this.logDiagnostic(
        'warn',
        `[CoworkBtw] stop API unavailable for session ${options.sessionId}`,
      );
      return false;
    }

    this.btwAbortRunIds.add(abortKey);
    this.logDiagnostic(
      'debug',
      `[CoworkBtw] stopping run ${options.runId} for session ${options.sessionId}`,
    );
    try {
      const result = await cowork.abortBtw(options);
      if (!result.success) {
        const message = result.error
          ? classifyError(result.error)
          : i18nService.t('coworkBtwStopFailed');
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
        this.logDiagnostic(
          'warn',
          `[CoworkBtw] stop rejected for run ${options.runId} in session ${options.sessionId}; `
          + `errorChars=${message.length}`,
        );
        return false;
      }

      const pending = store.getState().cowork.btwThreadsBySessionId[options.sessionId]
        ?.entries.find(entry => entry.runId === options.runId);
      if (result.aborted && pending?.status === CoworkBtwStatus.Pending) {
        store.dispatch(settleBtwEntry({
          ...pending,
          status: CoworkBtwStatus.Stopped,
          completedAt: Date.now(),
        }));
      }
      this.logDiagnostic(
        'debug',
        `[CoworkBtw] stop completed for run ${options.runId} in session ${options.sessionId}; `
        + `aborted=${result.aborted ? 'yes' : 'no'}`,
      );
      return true;
    } catch (error) {
      const message = i18nService.t('coworkBtwStopFailed');
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
      this.logDiagnostic(
        'error',
        `[CoworkBtw] stop transport failed for run ${options.runId} in session ${options.sessionId}; `
        + `errorType=${error instanceof Error ? error.name : typeof error}`,
      );
      return false;
    } finally {
      this.btwAbortRunIds.delete(abortKey);
    }
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
      this.setCurrentSessionStreaming(options.sessionId, true, 'goal_command_requested');
      store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'running' }));
    }
    const result = await cowork.runGoalCommand({
      sessionId: options.sessionId,
      command,
    });
    if (!result.success) {
      if (mayStartRun) {
        this.setCurrentSessionStreaming(options.sessionId, false, 'goal_command_failed');
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
    return this.stopSessionRuntime(sessionId);
  }

  async submitQueuedFollowUp(sessionId: string, steerId: string): Promise<boolean> {
    return this.queuedFollowUpCoordinator.submitSelected(sessionId, steerId);
  }

  async interruptForQueuedFollowUp(sessionId: string, steerId: string): Promise<boolean> {
    return this.queuedFollowUpCoordinator.interruptAndSubmit(sessionId, steerId);
  }

  private async stopSessionRuntime(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    this.logDiagnostic('info', `stop requested for session ${sessionId}.`);
    const result = await cowork.stopSession(sessionId);
    if (result.success) {
      this.setCurrentSessionStreaming(sessionId, false, 'stop_session_completed');
      store.dispatch(updateSessionStatus({ sessionId, status: 'idle' }));
      this.queuedFollowUpCoordinator.handleSessionIdle(sessionId);
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
      this.queuedFollowUpCoordinator.clearSession(sessionId);
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
      sessionIds.forEach(sessionId => this.queuedFollowUpCoordinator.clearSession(sessionId));
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
        this.setCurrentSessionStreaming(result.session.id, false, 'fork_session_created');
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

  async loadSession(
    sessionId: string,
    options: { preserveLoadedRange?: boolean } = {},
  ): Promise<CoworkSession | null> {
    try {
      const cowork = window.electron?.cowork;
      if (!cowork) return null;
      const requestId = ++this.latestLoadSessionRequestId;
      const previouslyLoadedSession = store.getState().cowork.currentSession;

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
        let session = result.session;
        if (
          options.preserveLoadedRange
          && previouslyLoadedSession?.id === sessionId
          && cowork.getSessionMessages
        ) {
          const preservedWindow = getPreservedMessageWindow(
            previouslyLoadedSession.messagesOffset,
            session.messagesOffset,
            session.totalMessages,
          );
          if (preservedWindow) {
            let pageResult;
            try {
              pageResult = await cowork.getSessionMessages({
                sessionId,
                ...preservedWindow,
              });
            } catch (error) {
              this.logDiagnostic(
                'warn',
                `failed to preserve loaded history for session ${sessionId}; keeping the existing view.`,
                error,
              );
              return previouslyLoadedSession;
            }
            if (requestId !== this.latestLoadSessionRequestId) {
              this.logDiagnostic('debug', `ignored stale preserved session load result for session ${sessionId}.`);
              return session;
            }
            if (pageResult.success && pageResult.messages && pageResult.messages.length > 0) {
              const returnedOffset = pageResult.offset ?? preservedWindow.offset;
              const returnedEnd = returnedOffset + pageResult.messages.length;
              const latestLoadedSession = store.getState().cowork.currentSession;
              const latestLoadedEnd = latestLoadedSession
                ? latestLoadedSession.messagesOffset + latestLoadedSession.messages.length
                : 0;
              if (
                latestLoadedSession?.id === sessionId
                && (
                  latestLoadedSession.messagesOffset < returnedOffset
                  || latestLoadedEnd > returnedEnd
                )
              ) {
                this.logDiagnostic(
                  'debug',
                  `kept a newer in-memory history window for session ${sessionId}; loaded offset=${latestLoadedSession.messagesOffset}, count=${latestLoadedSession.messages.length}; refresh offset=${returnedOffset}, count=${pageResult.messages.length}.`,
                );
                return latestLoadedSession;
              }
              session = {
                ...session,
                messages: pageResult.messages,
                messagesOffset: returnedOffset,
                totalMessages: pageResult.total ?? session.totalMessages,
              };
              this.logDiagnostic(
                'debug',
                `preserved loaded history for session ${sessionId}; returned ${session.messages.length} of ${session.totalMessages} messages from offset ${session.messagesOffset}.`,
              );
            } else {
              this.logDiagnostic(
                'warn',
                `failed to preserve loaded history for session ${sessionId}: ${pageResult.error ?? 'empty result'}; keeping the existing view.`,
              );
              return previouslyLoadedSession;
            }
          }
        }
        store.dispatch(setCurrentSession(session));
        this.setCurrentSessionStreaming(sessionId, session.status === 'running', 'load_session_completed');
        void this.loadSessionMessageRailIndex(sessionId);
        void cowork.markSessionViewed?.(sessionId).catch((error: unknown) => {
          console.warn('[CoworkService] failed to mark session viewed:', error);
        });

        const imResult = await cowork.remoteManaged(sessionId);
        if (requestId === this.latestLoadSessionRequestId) {
          store.dispatch(setRemoteManaged(imResult?.remoteManaged ?? false));
        }

        return session;
      }

      console.error('Failed to load session:', result.error);
      return null;
    } finally {
      this.finishSessionNavigation(sessionId);
    }
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

  async loadMessageWindowAroundIndex(
    sessionId: string,
    absoluteIndex: number,
    optionsOrPageSize: LoadMessageWindowAroundIndexOptions | number = {},
  ): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionMessages) return false;

    const state = store.getState().cowork;
    if (state.currentSession?.id !== sessionId) return false;
    const options = typeof optionsOrPageSize === 'number'
      ? { pageSize: optionsOrPageSize }
      : optionsOrPageSize;
    const requestGeneration = ++this.messageWindowRequestGeneration;

    const totalMessages = state.currentSession.totalMessages;
    const safeAbsoluteIndex = Number.isFinite(absoluteIndex) ? Math.max(0, Math.floor(absoluteIndex)) : 0;
    const requestedPageSize = options.pageSize ?? 50;
    const safePageSize = Number.isFinite(requestedPageSize) ? Math.floor(requestedPageSize) : 50;
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
      if (
        store.getState().cowork.currentSession?.id !== sessionId
        || this.messageWindowRequestGeneration !== requestGeneration
        || (options.isRequestCurrent && !options.isRequestCurrent())
      ) {
        this.logDiagnostic(
          'debug',
          `ignored stale message window for session ${sessionId}; absoluteIndex=${safeAbsoluteIndex}.`,
        );
        return false;
      }
      if (
        options.expectedMessageId
        && !result.messages.some(message => message.id === options.expectedMessageId)
      ) {
        this.logDiagnostic(
          'warn',
          `message window for session ${sessionId} did not include the expected target; absoluteIndex=${safeAbsoluteIndex}.`,
        );
        return false;
      }
      store.dispatch(setMessageWindow({
        sessionId,
        messages: result.messages,
        messagesOffset: result.offset ?? offset,
        totalMessages: result.total ?? totalMessages,
        preserveCurrentTotal: store.getState().cowork.currentSession!.totalMessages > totalMessages,
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
    const expectedFirstMessageId = state.currentSession.messages[0]?.id ?? null;

    this.logDiagnostic(
      'info',
      `loading older messages for session ${sessionId}; current view has ${currentMessageCount} of ${totalMessages} messages from offset ${currentOffset}.`,
    );

    const result = await cowork.getSessionMessages({ sessionId, limit, offset: newOffset });
    if (result.success && result.messages && result.messages.length > 0) {
      const latestSession = store.getState().cowork.currentSession;
      const latestFirstMessageId = latestSession?.messages[0]?.id ?? null;
      if (
        latestSession?.id !== sessionId
        || latestSession.messagesOffset !== currentOffset
        || latestSession.messages.length !== currentMessageCount
        || latestFirstMessageId !== expectedFirstMessageId
      ) {
        this.logDiagnostic(
          'debug',
          `ignored stale older message page for session ${sessionId}; requested offset=${newOffset}.`,
        );
        return false;
      }
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

  /** Load the page immediately after the active message window. */
  async loadNewerMessages(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionMessages) return false;

    const state = store.getState().cowork;
    if (state.currentSession?.id !== sessionId) return false;

    const currentOffset = state.currentSession.messagesOffset;
    const currentMessageCount = state.currentSession.messages.length;
    const totalMessages = state.currentSession.totalMessages;
    const nextOffset = currentOffset + currentMessageCount;
    if (nextOffset >= totalMessages) return false;

    const limit = Math.min(50, totalMessages - nextOffset);
    const expectedLastMessageId = state.currentSession.messages[currentMessageCount - 1]?.id ?? null;
    this.logDiagnostic(
      'info',
      `loading newer messages for session ${sessionId}; current view has ${currentMessageCount} of ${totalMessages} messages from offset ${currentOffset}.`,
    );

    const result = await cowork.getSessionMessages({ sessionId, limit, offset: nextOffset });
    if (result.success && result.messages && result.messages.length > 0) {
      const latestSession = store.getState().cowork.currentSession;
      const latestLastMessageId = latestSession
        ? latestSession.messages[latestSession.messages.length - 1]?.id ?? null
        : null;
      if (
        latestSession?.id !== sessionId
        || latestSession.messagesOffset !== currentOffset
        || latestSession.messages.length !== currentMessageCount
        || latestLastMessageId !== expectedLastMessageId
      ) {
        this.logDiagnostic(
          'debug',
          `ignored stale newer message page for session ${sessionId}; requested offset=${nextOffset}.`,
        );
        return false;
      }
      store.dispatch(appendNewerMessages({
        sessionId,
        messages: result.messages,
        totalMessages: result.total ?? totalMessages,
        preserveCurrentTotal: latestSession.totalMessages > totalMessages,
      }));
      const nextCount = store.getState().cowork.currentSession?.messages.length ?? currentMessageCount;
      const appendedCount = Math.max(0, nextCount - currentMessageCount);
      if (appendedCount === 0) {
        this.logDiagnostic(
          'warn',
          `newer message page made no progress for session ${sessionId} at offset ${nextOffset}; ignored ${result.messages.length} duplicate messages.`,
        );
        return false;
      }
      this.logDiagnostic(
        'info',
        `appended newer messages for session ${sessionId}; added ${appendedCount} messages from offset ${nextOffset}, and the view now has ${nextCount} of ${result.total ?? totalMessages} messages.`,
      );
      return true;
    }
    if (result.success) {
      const latestSession = store.getState().cowork.currentSession;
      const latestLastMessageId = latestSession
        ? latestSession.messages[latestSession.messages.length - 1]?.id ?? null
        : null;
      if (
        result.messages
        && latestSession?.id === sessionId
        && latestSession.messagesOffset === currentOffset
        && latestSession.messages.length === currentMessageCount
        && latestLastMessageId === expectedLastMessageId
      ) {
        store.dispatch(appendNewerMessages({
          sessionId,
          messages: [],
          totalMessages: result.total ?? totalMessages,
          preserveCurrentTotal: latestSession.totalMessages > totalMessages,
        }));
      }
      this.logDiagnostic('info', `newer message page for session ${sessionId} was empty at offset ${nextOffset}.`);
    } else {
      this.logDiagnostic('warn', `failed to load newer messages for session ${sessionId}: ${result.error ?? 'unknown error'}`);
    }
    return false;
  }

  /**
   * Load the entire message history of the current session into the active
   * window (both older and newer pages), e.g. before exporting the whole
   * conversation as an image. Returns false when the history could not be
   * fully loaded (session switched away, aborted, or a page kept failing).
   */
  async loadFullSessionHistory(
    sessionId: string,
    options?: {
      onProgress?: (loadedCount: number, totalCount: number) => void;
      shouldAbort?: () => boolean;
    },
  ): Promise<boolean> {
    const readWindow = () => {
      const session = store.getState().cowork.currentSession;
      if (!session || session.id !== sessionId) return null;
      return {
        offset: session.messagesOffset ?? 0,
        loaded: session.messages.length,
        total: Math.max(session.totalMessages ?? 0, session.messages.length),
      };
    };

    const MAX_PAGE_LOADS = 500;
    const MAX_STALLED_ATTEMPTS = 3;
    let pageLoads = 0;

    for (const direction of ['older', 'newer'] as const) {
      let stalledAttempts = 0;
      for (;;) {
        if (options?.shouldAbort?.()) return false;
        const view = readWindow();
        if (!view) return false;
        const hasMore = direction === 'older'
          ? view.offset > 0
          : view.offset + view.loaded < view.total;
        if (!hasMore) break;
        if (++pageLoads > MAX_PAGE_LOADS) {
          this.logDiagnostic('warn', `aborted full history load for session ${sessionId} after ${MAX_PAGE_LOADS} page loads.`);
          return false;
        }
        const progressed = direction === 'older'
          ? await this.loadMoreMessages(sessionId)
          : await this.loadNewerMessages(sessionId);
        const next = readWindow();
        if (!next) return false;
        const madeProgress = progressed
          || next.offset < view.offset
          || next.loaded > view.loaded;
        if (madeProgress) {
          stalledAttempts = 0;
          options?.onProgress?.(next.loaded, next.total);
          continue;
        }
        if (++stalledAttempts >= MAX_STALLED_ATTEMPTS) {
          this.logDiagnostic(
            'warn',
            `full history load stalled for session ${sessionId} while paging ${direction}; offset=${next.offset}, loaded=${next.loaded}, total=${next.total}.`,
          );
          return false;
        }
      }
    }

    const finalView = readWindow();
    return Boolean(finalView && finalView.offset <= 0 && finalView.loaded >= finalView.total);
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
        this.setCurrentSessionStreaming(sessionId, result.session.status === 'running', 'patch_session_completed');
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

  async readBootstrapFile(filename: string, options?: { agentId?: string }): Promise<string> {
    const api = window.electron?.cowork?.readBootstrapFile;
    if (!api) return '';
    const result = await api(filename, options);
    if (!result?.success) {
      console.warn(`[CoworkService] readBootstrapFile: failed to read ${filename}`, result?.error);
      return '';
    }
    return result.content || '';
  }

  async writeBootstrapFile(filename: string, content: string, options?: { agentId?: string }): Promise<boolean> {
    const api = window.electron?.cowork?.writeBootstrapFile;
    if (!api) return false;
    const result = await api(filename, content, options);
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
    // Invalidate an in-flight load so an old history/IM session cannot replace
    // the new-task view after the user has explicitly left that session.
    this.latestLoadSessionRequestId += 1;
    store.dispatch(clearCurrentSession());
    if (options.restoreAgentSkills) {
      restoreCurrentAgentDefaultSkills();
    }
  }

  finishSessionNavigation(sessionId: string): void {
    store.dispatch(finishSessionNavigationAction(sessionId));
  }

  destroy(): void {
    this.cleanupListeners();
    this.openClawStatusListeners.clear();
    this.initialized = false;
  }
}

export const coworkService = new CoworkService();
