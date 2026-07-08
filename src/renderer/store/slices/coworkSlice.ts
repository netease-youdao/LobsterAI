import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type { CoworkGoal } from '../../../shared/cowork/goal';
import {
  COWORK_RAIL_TOOLTIP_PREVIEW_MAX_LENGTH,
  type CoworkMessageRailIndexItem,
  getCoworkRailPreview,
} from '../../../shared/cowork/rail';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import {
  CoworkCollaborationMode,
  type CoworkCollaborationMode as CoworkCollaborationModeType,
  type CoworkConfig,
  type CoworkContextUsage,
  type CoworkMessage,
  type CoworkPermissionRequest,
  type CoworkSession,
  type CoworkSessionStatus,
  CoworkSessionStatusValue,
  type CoworkSessionSummary,
} from '../../types/cowork';
import type { MediaGenerationSelection, MediaModel } from '../../types/mediaGeneration';
import { removeSessionFromState, removeSessionsFromState } from './coworkDeleteState';

export interface DraftAttachment {
  path: string;
  name: string;
  isImage?: boolean;
  dataUrl?: string;
}

export const PlanConfirmationState = {
  Awaiting: 'awaiting',
  Handled: 'handled',
} as const;
export type PlanConfirmationState = typeof PlanConfirmationState[keyof typeof PlanConfirmationState];

export interface PlanConfirmationStatus {
  sessionId: string;
  messageId: string;
  planTextHash: string;
  state: PlanConfirmationState;
  updatedAt: number;
}

interface CoworkState {
  sessions: CoworkSessionSummary[];
  /** Whether more sessions exist on the server beyond what is currently loaded. */
  hasMoreSessions: boolean;
  currentSessionId: string | null;
  currentSession: CoworkSession | null;
  draftPrompts: Record<string, string>;
  /** Keyed by draftKey (sessionId or '__home__'), stores pending attachments */
  draftAttachments: Record<string, DraftAttachment[]>;
  /** Keyed by draftKey, stores selected assistant text excerpts for the next user turn. */
  draftSelectedTextSnippets: Record<string, CoworkSelectedTextSnippet[]>;
  /** Keyed by draftKey, stores active kit IDs per draft so they survive view switches */
  draftKitIds: Record<string, string[]>;
  /** Keyed by draftKey, stores active skill IDs per draft so they survive view switches */
  draftSkillIds: Record<string, string[]>;
  /** Keyed by draftKey, stores the active collaboration mode for the draft/session. */
  draftCollaborationModes: Record<string, CoworkCollaborationModeType>;
  /** Keyed by sessionId, stores the latest proposed plan confirmation UI state. */
  planConfirmations: Record<string, PlanConfirmationStatus>;
  unreadSessionIds: string[];
  isCoworkActive: boolean;
  isStreaming: boolean;
  contextUsageBySessionId: Record<string, CoworkContextUsage>;
  compactingSessionIds: string[];
  contextMaintenanceSessionIds: string[];
  notifiedCompactionBySessionId: Record<string, number>;
  messageRailIndexBySessionId: Record<string, CoworkMessageRailIndexItem[]>;
  messageRailIndexLoadingBySessionId: Record<string, boolean>;
  remoteManaged: boolean;
  pendingPermissions: CoworkPermissionRequest[];
  config: CoworkConfig;
  /** Media generation models fetched from server */
  mediaModels: { image: MediaModel[]; video: MediaModel[] };
  /** Media generation mode selection per draft key */
  mediaSelection: Record<string, MediaGenerationSelection>;
  pendingMediaStatusUpdates: Record<string, Array<{ toolCallId: string; details: Record<string, unknown> }>>;
}

const initialState: CoworkState = {
  sessions: [],
  hasMoreSessions: false,
  currentSessionId: null,
  currentSession: null,
  draftPrompts: {},
  draftAttachments: {},
  draftSelectedTextSnippets: {},
  draftKitIds: {},
  draftSkillIds: {},
  draftCollaborationModes: {},
  planConfirmations: {},
  unreadSessionIds: [],
  isCoworkActive: false,
  isStreaming: false,
  contextUsageBySessionId: {},
  compactingSessionIds: [],
  contextMaintenanceSessionIds: [],
  notifiedCompactionBySessionId: {},
  messageRailIndexBySessionId: {},
  messageRailIndexLoadingBySessionId: {},
  remoteManaged: false,
  pendingPermissions: [],
  config: {
    workingDirectory: '',
    systemPrompt: '',
    executionMode: 'local',
    agentEngine: 'openclaw',
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: false,
    memoryGuardLevel: 'strict',
    memoryUserMemoriesMaxItems: 12,
    skipMissedJobs: true,
    openClawHeartbeatEnabled: true,
    embeddingEnabled: false,
    embeddingProvider: 'openai',
    embeddingModel: '',
    embeddingLocalModelPath: '',
    embeddingVectorWeight: 0.7,
    embeddingRemoteBaseUrl: '',
    embeddingRemoteApiKey: '',
    dreamingEnabled: false,
    dreamingFrequency: '0 3 * * *',
    dreamingModel: '',
    dreamingTimezone: '',
    openClawSessionPolicy: {
      keepAlive: '30d',
    },
  },
  mediaModels: { image: [], video: [] },
  mediaSelection: {},
  pendingMediaStatusUpdates: {},
};

const markSessionRead = (state: CoworkState, sessionId: string | null) => {
  if (!sessionId) return;
  state.unreadSessionIds = state.unreadSessionIds.filter((id) => id !== sessionId);
};

const markSessionUnread = (state: CoworkState, sessionId: string) => {
  if (state.currentSessionId === sessionId) return;
  if (state.unreadSessionIds.includes(sessionId)) return;
  state.unreadSessionIds.push(sessionId);
};

const buildRailIndexItemFromMessage = (
  message: CoworkMessage,
  messageOffset: number,
  fallbackLabelIndex: number,
): CoworkMessageRailIndexItem | null => {
  if ((message.type !== 'user' && message.type !== 'assistant') || !message.content.trim()) {
    return null;
  }

  return {
    messageId: message.id,
    type: message.type,
    sequence: null,
    messageOffset,
    timestamp: message.timestamp,
    preview: getCoworkRailPreview(
      message.content,
      message.type === 'user' ? `Turn ${fallbackLabelIndex + 1}` : 'LobsterAI',
      COWORK_RAIL_TOOLTIP_PREVIEW_MAX_LENGTH,
    ),
    contentLen: message.content.length,
  };
};

const resolveRailMessageOffset = (
  state: CoworkState,
  sessionId: string,
  message: CoworkMessage,
  fallbackOffset: number,
): number => {
  if (state.currentSession?.id !== sessionId) {
    return fallbackOffset;
  }
  const messageIndex = state.currentSession.messages.findIndex(item => item.id === message.id);
  return messageIndex >= 0
    ? state.currentSession.messagesOffset + messageIndex
    : fallbackOffset;
};

const upsertRailIndexItem = (
  state: CoworkState,
  sessionId: string,
  message: CoworkMessage,
): void => {
  const existingItems = state.messageRailIndexBySessionId[sessionId];
  if (!existingItems) return;

  const existingIndex = existingItems.findIndex(item => item.messageId === message.id);
  const existingItem = existingIndex >= 0 ? existingItems[existingIndex] : null;
  const fallbackOffset = existingItem?.messageOffset ?? existingItems.length;
  const messageOffset = resolveRailMessageOffset(state, sessionId, message, fallbackOffset);
  const item = buildRailIndexItemFromMessage(
    message,
    messageOffset,
    existingIndex >= 0 ? existingIndex : existingItems.length,
  );
  if (!item) {
    if (existingIndex >= 0) {
      existingItems.splice(existingIndex, 1);
    }
    return;
  }

  if (existingIndex >= 0) {
    existingItems[existingIndex] = {
      ...existingItems[existingIndex],
      ...item,
      sequence: existingItems[existingIndex].sequence,
      messageOffset: existingItems[existingIndex].messageOffset,
    };
    return;
  }

  existingItems.push(item);
};

const MediaGenerationToolName = {
  Image: 'lobsterai_image_generate',
  Video: 'lobsterai_video_generate',
} as const;

const MediaGenerationActionName = {
  Status: 'status',
} as const;

const readMediaPollCount = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 1
    ? Math.floor(value)
    : undefined
);

const mergeMediaDetails = (
  existingDetails: Record<string, unknown> | undefined,
  nextDetails: Record<string, unknown>,
): Record<string, unknown> => {
  const existingPollCount = readMediaPollCount(existingDetails?.pollCount);
  const nextPollCount = readMediaPollCount(nextDetails.pollCount);
  const pollCount = existingPollCount == null
    ? nextPollCount
    : nextPollCount == null
      ? existingPollCount
      : Math.max(existingPollCount, nextPollCount);
  const merged = {
    ...(existingDetails ?? {}),
    ...nextDetails,
  };
  delete merged.pollCount;
  if (pollCount != null) {
    merged.pollCount = pollCount;
  }
  return merged;
};

const getMediaDetailTaskIds = (details: Record<string, unknown>): Set<string> => new Set(
  [details.taskId, details.upstreamTaskId]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim()),
);

const isSameRetainedMediaStatusUpdate = (
  existing: { toolCallId: string; details: Record<string, unknown> },
  toolCallId: string,
  details: Record<string, unknown>,
): boolean => {
  if (existing.toolCallId === toolCallId) return true;

  const existingTaskIds = getMediaDetailTaskIds(existing.details);
  if (existingTaskIds.size === 0) return false;

  for (const taskId of getMediaDetailTaskIds(details)) {
    if (existingTaskIds.has(taskId)) return true;
  }
  return false;
};

const retainMediaStatusUpdate = (
  state: CoworkState,
  sessionId: string,
  toolCallId: string,
  details: Record<string, unknown>,
): Record<string, unknown> => {
  const pending = state.pendingMediaStatusUpdates[sessionId] ?? [];
  const existingIndex = pending.findIndex(update => (
    isSameRetainedMediaStatusUpdate(update, toolCallId, details)
  ));

  if (existingIndex >= 0) {
    const mergedDetails = mergeMediaDetails(pending[existingIndex].details, details);
    pending[existingIndex] = { toolCallId, details: mergedDetails };
    state.pendingMediaStatusUpdates[sessionId] = pending;
    return mergedDetails;
  }

  pending.push({ toolCallId, details: mergeMediaDetails(undefined, details) });
  state.pendingMediaStatusUpdates[sessionId] = pending;
  return pending[pending.length - 1].details;
};

const isMediaStatusToolUseMessage = (
  message: CoworkMessage,
  toolCallId: string,
  details: Record<string, unknown>,
): boolean => {
  if (message.type !== 'tool_use') return false;
  if (message.metadata?.toolUseId === toolCallId) return true;

  const toolName = message.metadata?.toolName;
  if (toolName !== MediaGenerationToolName.Image && toolName !== MediaGenerationToolName.Video) {
    return false;
  }

  const input = message.metadata?.toolInput as Record<string, unknown> | undefined;
  if (input?.action !== MediaGenerationActionName.Status || typeof input.taskId !== 'string') {
    return false;
  }

  const inputTaskId = input.taskId.trim();
  const detailTaskIds = new Set(
    [details.taskId, details.upstreamTaskId]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim()),
  );
  return detailTaskIds.has(inputTaskId);
};

const mergeMediaStatusDetailsIntoMessage = (
  message: CoworkMessage,
  details: Record<string, unknown>,
): void => {
  const existingDetails = message.metadata?.mediaStatusDetails as Record<string, unknown> | undefined;
  message.metadata = {
    ...message.metadata,
    mediaStatusDetails: mergeMediaDetails(existingDetails, details),
  };
};

const applyPendingMediaStatusUpdates = (
  state: CoworkState,
  sessionId: string,
  message: CoworkMessage,
): boolean => {
  const pending = state.pendingMediaStatusUpdates[sessionId];
  if (!pending || pending.length === 0) return false;

  let applied = false;
  for (const update of pending) {
    if (!isMediaStatusToolUseMessage(message, update.toolCallId, update.details)) {
      continue;
    }
    mergeMediaStatusDetailsIntoMessage(message, update.details);
    applied = true;
  }
  return applied;
};

const toSessionSummary = (session: CoworkSession): CoworkSessionSummary => ({
  id: session.id,
  title: session.title,
  status: session.status,
  pinned: session.pinned ?? false,
  pinOrder: session.pinOrder ?? null,
  agentId: session.agentId,
  parentSessionId: session.parentSessionId ?? null,
  forkedAt: session.forkedAt ?? null,
  forkMode: session.forkMode,
  goal: session.goal ?? null,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

const coworkSlice = createSlice({
  name: 'cowork',
  initialState,
  reducers: {
    setCoworkActive(state, action: PayloadAction<boolean>) {
      state.isCoworkActive = action.payload;
    },

    setSessions(state, action: PayloadAction<CoworkSessionSummary[]>) {
      state.sessions = action.payload;
      const validSessionIds = new Set(action.payload.map((session) => session.id));
      state.unreadSessionIds = state.unreadSessionIds.filter((id) => {
        return validSessionIds.has(id) && id !== state.currentSessionId;
      });
    },

    setHasMoreSessions(state, action: PayloadAction<boolean>) {
      state.hasMoreSessions = action.payload;
    },

    appendSessions(state, action: PayloadAction<{ sessions: CoworkSessionSummary[]; hasMore: boolean }>) {
      const { sessions, hasMore } = action.payload;
      const existingIds = new Set(state.sessions.map(s => s.id));
      const newSessions = sessions.filter(s => !existingIds.has(s.id));
      state.sessions = [...state.sessions, ...newSessions];
      state.hasMoreSessions = hasMore;
    },

    setCurrentSessionId(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload;
      markSessionRead(state, action.payload);
    },

    setCurrentSession(state, action: PayloadAction<CoworkSession | null>) {
      if (action.payload) {
        const session = action.payload;
        // Ensure pagination fields are always present (guard against stale IPC data).
        state.currentSession = {
          ...session,
          messagesOffset: session.messagesOffset ?? 0,
          totalMessages: session.totalMessages ?? session.messages.length,
        };
        for (const message of state.currentSession.messages) {
          applyPendingMediaStatusUpdates(state, session.id, message);
        }
      } else {
        state.currentSession = null;
      }
      if (action.payload) {
        state.currentSessionId = action.payload.id;
        if (!action.payload.id.startsWith('temp-')) {
          const summary = toSessionSummary(action.payload);
          const sessionIndex = state.sessions.findIndex((session) => session.id === summary.id);
          if (sessionIndex !== -1) {
            state.sessions[sessionIndex] = {
              ...state.sessions[sessionIndex],
              ...summary,
            };
          } else {
            state.sessions.unshift(summary);
          }
        }
        markSessionRead(state, action.payload.id);
      }
    },

    setDraftPrompt(state, action: PayloadAction<{ sessionId: string; draft: string }>) {
      const { sessionId, draft } = action.payload;
      if (draft) {
        state.draftPrompts[sessionId] = draft;
      } else {
        delete state.draftPrompts[sessionId];
      }
    },

    addSession(state, action: PayloadAction<CoworkSession>) {
      const summary = toSessionSummary(action.payload);
      state.sessions.unshift(summary);
      state.currentSession = {
        ...action.payload,
        messagesOffset: action.payload.messagesOffset ?? 0,
        totalMessages: action.payload.totalMessages ?? action.payload.messages.length,
      };
      state.currentSessionId = action.payload.id;
      markSessionRead(state, action.payload.id);
    },

    updateSessionStatus(state, action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>) {
      const { sessionId, status } = action.payload;

      // updatedAt drives session list ordering and only moves on a real
      // transition: stream handlers re-dispatch 'running' on every event, and
      // those no-op writes must not make concurrent runs fight over the top.
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        if (state.sessions[sessionIndex].status !== status) {
          state.sessions[sessionIndex].updatedAt = Date.now();
        }
        state.sessions[sessionIndex].status = status;
      }

      // Update current session if applicable
      if (state.currentSession?.id === sessionId) {
        if (state.currentSession.status !== status) {
          state.currentSession.updatedAt = Date.now();
        }
        state.currentSession.status = status;
        // Streaming state is tied to the currently opened session only
        state.isStreaming = status === CoworkSessionStatusValue.Running;
      }

      if (status === CoworkSessionStatusValue.Completed) {
        markSessionUnread(state, sessionId);
      }
    },

    updateSessionGoal(state, action: PayloadAction<{ sessionId: string; goal: CoworkGoal | null }>) {
      const { sessionId, goal } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].goal = goal;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.goal = goal;
      }
    },

    deleteSession(state, action: PayloadAction<string>) {
      removeSessionFromState(state, action.payload);
      delete state.planConfirmations[action.payload];
      delete state.messageRailIndexBySessionId[action.payload];
      delete state.messageRailIndexLoadingBySessionId[action.payload];
    },

    deleteSessions(state, action: PayloadAction<string[]>) {
      removeSessionsFromState(state, action.payload);
      for (const sessionId of action.payload) {
        delete state.planConfirmations[sessionId];
        delete state.messageRailIndexBySessionId[sessionId];
        delete state.messageRailIndexLoadingBySessionId[sessionId];
      }
    },

    setMessageRailIndexLoading(state, action: PayloadAction<{ sessionId: string; loading: boolean }>) {
      const { sessionId, loading } = action.payload;
      if (loading) {
        state.messageRailIndexLoadingBySessionId[sessionId] = true;
      } else {
        delete state.messageRailIndexLoadingBySessionId[sessionId];
      }
    },

    setMessageRailIndex(state, action: PayloadAction<{ sessionId: string; items: CoworkMessageRailIndexItem[] }>) {
      const { sessionId, items } = action.payload;
      state.messageRailIndexBySessionId[sessionId] = items;
      delete state.messageRailIndexLoadingBySessionId[sessionId];
    },

    setMessageWindow(
      state,
      action: PayloadAction<{
        sessionId: string;
        messages: CoworkMessage[];
        messagesOffset: number;
        totalMessages: number;
      }>,
    ) {
      const { sessionId, messages, messagesOffset, totalMessages } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      state.currentSession.messages = messages;
      state.currentSession.messagesOffset = messagesOffset;
      state.currentSession.totalMessages = totalMessages;
      for (const message of state.currentSession.messages) {
        applyPendingMediaStatusUpdates(state, sessionId, message);
      }
    },

    addMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage; beforeMessageId?: string }>) {
      const { sessionId, message, beforeMessageId } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const exists = state.currentSession.messages.some((item) => item.id === message.id);
        if (!exists) {
          // If beforeMessageId is specified, insert before that message to maintain correct order
          // (e.g. thinking block should appear before the assistant text)
          let inserted = false;
          if (beforeMessageId) {
            const targetIndex = state.currentSession.messages.findIndex((item) => item.id === beforeMessageId);
            console.log('[ThinkingOrder] Redux addMessage: beforeMessageId=', beforeMessageId, 'targetIndex=', targetIndex, 'messageId=', message.id, 'totalMessages=', state.currentSession.messages.length);
            if (targetIndex !== -1) {
              state.currentSession.messages.splice(targetIndex, 0, message);
              inserted = true;
            }
          }
          if (!inserted) {
            state.currentSession.messages.push(message);
          }
          applyPendingMediaStatusUpdates(state, sessionId, message);
          if (message.type === 'user') {
            state.currentSession.updatedAt = message.timestamp;
          }
          state.currentSession.totalMessages += 1;
        }
      }
      upsertRailIndexItem(state, sessionId, message);

      // List ordering follows user activity: streamed assistant/tool messages
      // must not move updatedAt or concurrent runs keep swapping positions.
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1 && message.type === 'user') {
        state.sessions[sessionIndex].updatedAt = message.timestamp;
      }

      markSessionUnread(state, sessionId);
    },

    /** Prepend older messages when user scrolls up to load more history. */
    prependMessages(state, action: PayloadAction<{ sessionId: string; messages: CoworkMessage[]; newOffset: number }>) {
      const { sessionId, messages, newOffset } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      if (messages.length === 0) return;
      const existingIds = new Set(state.currentSession.messages.map(m => m.id));
      const toInsert = messages.filter(m => !existingIds.has(m.id));
      state.currentSession.messages = [...toInsert, ...state.currentSession.messages];
      state.currentSession.messagesOffset = newOffset;
      for (const message of toInsert) {
        applyPendingMediaStatusUpdates(state, sessionId, message);
      }
    },

    // Runs on every streaming delta, so it intentionally leaves session
    // updatedAt untouched to keep the list order stable during runs.
    updateMessageContent(state, action: PayloadAction<{ sessionId: string; messageId: string; content: string; metadata?: Record<string, unknown> }>) {
      const { sessionId, messageId, content, metadata } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const messageIndex = state.currentSession.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          state.currentSession.messages[messageIndex].content = content;
          if (metadata) {
            const existingMetadata = state.currentSession.messages[messageIndex].metadata;
            const existingToolResultDetails = existingMetadata?.toolResultDetails as Record<string, unknown> | undefined;
            const nextToolResultDetails = metadata.toolResultDetails as Record<string, unknown> | undefined;
            state.currentSession.messages[messageIndex].metadata = {
              ...existingMetadata,
              ...metadata,
              ...(nextToolResultDetails
                ? { toolResultDetails: mergeMediaDetails(existingToolResultDetails, nextToolResultDetails) }
                : {}),
            };
          }
          upsertRailIndexItem(state, sessionId, state.currentSession.messages[messageIndex]);
        }
      }

      markSessionUnread(state, sessionId);
    },

    // High-frequency media polling updates; must not move session updatedAt.
    updateToolUseMediaStatus(state, action: PayloadAction<{ sessionId: string; toolCallId: string; details: Record<string, unknown> }>) {
      const { sessionId, toolCallId, details } = action.payload;
      const retainedDetails = retainMediaStatusUpdate(state, sessionId, toolCallId, details);

      if (state.currentSession?.id === sessionId) {
        const message = state.currentSession.messages.find(item => (
          isMediaStatusToolUseMessage(item, toolCallId, retainedDetails)
        ));
        if (message) {
          mergeMediaStatusDetailsIntoMessage(message, retainedDetails);
        }
      }
    },

    setStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },

    setContextUsage(state, action: PayloadAction<CoworkContextUsage>) {
      state.contextUsageBySessionId[action.payload.sessionId] = action.payload;
    },

    setContextCompacting(state, action: PayloadAction<{ sessionId: string; compacting: boolean }>) {
      const { sessionId, compacting } = action.payload;
      const existing = state.compactingSessionIds.includes(sessionId);
      if (compacting && !existing) {
        state.compactingSessionIds.push(sessionId);
      } else if (!compacting && existing) {
        state.compactingSessionIds = state.compactingSessionIds.filter(id => id !== sessionId);
      }
    },

    setContextMaintenance(state, action: PayloadAction<{ sessionId: string; active: boolean }>) {
      const { sessionId, active } = action.payload;
      const existing = state.contextMaintenanceSessionIds.includes(sessionId);
      if (active && !existing) {
        state.contextMaintenanceSessionIds.push(sessionId);
      } else if (!active && existing) {
        state.contextMaintenanceSessionIds = state.contextMaintenanceSessionIds.filter(id => id !== sessionId);
      }
    },

    markCompactionNotified(state, action: PayloadAction<{ sessionId: string; compactionCount: number }>) {
      state.notifiedCompactionBySessionId[action.payload.sessionId] = action.payload.compactionCount;
    },

    setRemoteManaged(state, action: PayloadAction<boolean>) {
      state.remoteManaged = action.payload;
    },

    updateSessionPinned(state, action: PayloadAction<{ sessionId: string; pinned: boolean; pinOrder?: number | null }>) {
      const { sessionId, pinned, pinOrder } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].pinned = pinned;
        state.sessions[sessionIndex].pinOrder = pinned ? (pinOrder ?? state.sessions[sessionIndex].pinOrder ?? null) : null;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.pinned = pinned;
        state.currentSession.pinOrder = pinned ? (pinOrder ?? state.currentSession.pinOrder ?? null) : null;
      }
    },

    updateSessionTitle(state, action: PayloadAction<{ sessionId: string; title: string }>) {
      const { sessionId, title } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].title = title;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.title = title;
      }
    },

    updateCurrentSessionModelOverride(state, action: PayloadAction<{ sessionId: string; modelOverride: string }>) {
      const { sessionId, modelOverride } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      state.currentSession.modelOverride = modelOverride;
    },

    enqueuePendingPermission(state, action: PayloadAction<CoworkPermissionRequest>) {
      const alreadyQueued = state.pendingPermissions.some(
        (permission) => permission.requestId === action.payload.requestId
      );
      if (alreadyQueued) return;
      state.pendingPermissions.push(action.payload);
    },

    dequeuePendingPermission(state, action: PayloadAction<{ requestId?: string } | undefined>) {
      const requestId = action.payload?.requestId;
      if (!requestId) {
        state.pendingPermissions.shift();
        return;
      }
      state.pendingPermissions = state.pendingPermissions.filter(
        (permission) => permission.requestId !== requestId
      );
    },

    clearPendingPermissions(state) {
      state.pendingPermissions = [];
    },

    setConfig(state, action: PayloadAction<CoworkConfig>) {
      state.config = action.payload;
    },

    updateConfig(state, action: PayloadAction<Partial<CoworkConfig>>) {
      state.config = { ...state.config, ...action.payload };
    },

    clearCurrentSession(state) {
      state.currentSessionId = null;
      state.currentSession = null;
      state.isStreaming = false;
      state.remoteManaged = false;
    },

    setPlanConfirmationAwaiting(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; planTextHash: string }>,
    ) {
      const { sessionId, messageId, planTextHash } = action.payload;
      const existing = state.planConfirmations[sessionId];
      if (
        existing?.messageId === messageId
        && existing.planTextHash === planTextHash
        && existing.state === PlanConfirmationState.Awaiting
      ) {
        return;
      }
      state.planConfirmations[sessionId] = {
        sessionId,
        messageId,
        planTextHash,
        state: PlanConfirmationState.Awaiting,
        updatedAt: Date.now(),
      };
    },

    setPlanConfirmationHandled(
      state,
      action: PayloadAction<{ sessionId: string; messageId?: string; planTextHash?: string }>,
    ) {
      const { sessionId, messageId, planTextHash } = action.payload;
      const existing = state.planConfirmations[sessionId];
      if (!existing) return;
      if (messageId && existing.messageId !== messageId) return;
      state.planConfirmations[sessionId] = {
        ...existing,
        ...(planTextHash ? { planTextHash } : {}),
        state: PlanConfirmationState.Handled,
        updatedAt: Date.now(),
      };
    },

    clearPlanConfirmation(state, action: PayloadAction<string>) {
      delete state.planConfirmations[action.payload];
    },

    setDraftAttachments(state, action: PayloadAction<{ draftKey: string; attachments: DraftAttachment[] }>) {
      const { draftKey, attachments } = action.payload;
      if (attachments.length === 0) {
        delete state.draftAttachments[draftKey];
      } else {
        state.draftAttachments[draftKey] = attachments;
      }
    },

    addDraftAttachment(state, action: PayloadAction<{ draftKey: string; attachment: DraftAttachment }>) {
      const { draftKey, attachment } = action.payload;
      const existing = state.draftAttachments[draftKey] || [];
      if (existing.some(a => a.path === attachment.path)) return;
      state.draftAttachments[draftKey] = [...existing, attachment];
    },

    clearDraftAttachments(state, action: PayloadAction<string>) {
      delete state.draftAttachments[action.payload];
    },

    setDraftSelectedTextSnippets(state, action: PayloadAction<{ draftKey: string; snippets: CoworkSelectedTextSnippet[] }>) {
      const { draftKey, snippets } = action.payload;
      if (snippets.length === 0) {
        delete state.draftSelectedTextSnippets[draftKey];
      } else {
        state.draftSelectedTextSnippets[draftKey] = snippets;
      }
    },

    addDraftSelectedTextSnippet(state, action: PayloadAction<{ draftKey: string; snippet: CoworkSelectedTextSnippet }>) {
      const { draftKey, snippet } = action.payload;
      const existing = state.draftSelectedTextSnippets[draftKey] || [];
      state.draftSelectedTextSnippets[draftKey] = [...existing, snippet];
    },

    removeDraftSelectedTextSnippet(state, action: PayloadAction<{ draftKey: string; snippetId: string }>) {
      const { draftKey, snippetId } = action.payload;
      const snippets = (state.draftSelectedTextSnippets[draftKey] || [])
        .filter(snippet => snippet.id !== snippetId);
      if (snippets.length === 0) {
        delete state.draftSelectedTextSnippets[draftKey];
      } else {
        state.draftSelectedTextSnippets[draftKey] = snippets;
      }
    },

    clearDraftSelectedTextSnippets(state, action: PayloadAction<string>) {
      delete state.draftSelectedTextSnippets[action.payload];
    },

    setDraftKitIds(state, action: PayloadAction<{ draftKey: string; kitIds: string[] }>) {
      const { draftKey, kitIds } = action.payload;
      if (kitIds.length === 0) {
        delete state.draftKitIds[draftKey];
      } else {
        state.draftKitIds[draftKey] = kitIds;
      }
    },

    setDraftSkillIds(state, action: PayloadAction<{ draftKey: string; skillIds: string[] }>) {
      const { draftKey, skillIds } = action.payload;
      if (skillIds.length === 0) {
        delete state.draftSkillIds[draftKey];
      } else {
        state.draftSkillIds[draftKey] = skillIds;
      }
    },

    setDraftCollaborationMode(state, action: PayloadAction<{ draftKey: string; mode: CoworkCollaborationModeType }>) {
      const { draftKey, mode } = action.payload;
      if (mode === CoworkCollaborationMode.Default) {
        delete state.draftCollaborationModes[draftKey];
      } else {
        state.draftCollaborationModes[draftKey] = mode;
      }
    },

    setMediaModels(state, action: PayloadAction<{ image: MediaModel[]; video: MediaModel[] }>) {
      state.mediaModels = action.payload;
    },

    setMediaSelection(state, action: PayloadAction<{ draftKey: string; selection: MediaGenerationSelection }>) {
      const { draftKey, selection } = action.payload;
      if (selection.mode === 'none') {
        delete state.mediaSelection[draftKey];
      } else {
        state.mediaSelection[draftKey] = selection;
      }
    },
  },
});

export const {
  setCoworkActive,
  setSessions,
  setHasMoreSessions,
  appendSessions,
  setCurrentSessionId,
  setCurrentSession,
  setDraftPrompt,
  setDraftAttachments,
  addDraftAttachment,
  clearDraftAttachments,
  setDraftSelectedTextSnippets,
  addDraftSelectedTextSnippet,
  removeDraftSelectedTextSnippet,
  clearDraftSelectedTextSnippets,
  addSession,
  updateSessionStatus,
  updateSessionGoal,
  deleteSession,
  deleteSessions,
  setMessageRailIndexLoading,
  setMessageRailIndex,
  setMessageWindow,
  addMessage,
  prependMessages,
  updateMessageContent,
  updateToolUseMediaStatus,
  setStreaming,
  setContextUsage,
  setContextCompacting,
  setContextMaintenance,
  markCompactionNotified,
  setRemoteManaged,
  updateSessionPinned,
  updateSessionTitle,
  updateCurrentSessionModelOverride,
  enqueuePendingPermission,
  dequeuePendingPermission,
  clearPendingPermissions,
  setConfig,
  updateConfig,
  clearCurrentSession,
  setPlanConfirmationAwaiting,
  setPlanConfirmationHandled,
  clearPlanConfirmation,
  setDraftKitIds,
  setDraftSkillIds,
  setDraftCollaborationMode,
  setMediaModels,
  setMediaSelection,
} = coworkSlice.actions;

export default coworkSlice.reducer;
