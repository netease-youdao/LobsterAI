import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import {
  type CoworkConfig,
  type CoworkContextUsage,
  type CoworkMessage,
  type CoworkPermissionRequest,
  type CoworkSession,
  type CoworkSessionStatus,
  CoworkSessionStatusValue,
  type CoworkSessionSummary,
} from '../../types/cowork';
import { removeSessionFromState, removeSessionsFromState } from './coworkDeleteState';

export interface DraftAttachment {
  path: string;
  name: string;
  isImage?: boolean;
  dataUrl?: string;
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
  unreadSessionIds: string[];
  isCoworkActive: boolean;
  isStreaming: boolean;
  contextUsageBySessionId: Record<string, CoworkContextUsage>;
  compactingSessionIds: string[];
  contextMaintenanceSessionIds: string[];
  notifiedCompactionBySessionId: Record<string, number>;
  remoteManaged: boolean;
  pendingPermissions: CoworkPermissionRequest[];
  config: CoworkConfig;
}

const initialState: CoworkState = {
  sessions: [],
  hasMoreSessions: false,
  currentSessionId: null,
  currentSession: null,
  draftPrompts: {},
  draftAttachments: {},
  unreadSessionIds: [],
  isCoworkActive: false,
  isStreaming: false,
  contextUsageBySessionId: {},
  compactingSessionIds: [],
  contextMaintenanceSessionIds: [],
  notifiedCompactionBySessionId: {},
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

const toSessionSummary = (session: CoworkSession): CoworkSessionSummary => ({
  id: session.id,
  title: session.title,
  status: session.status,
  pinned: session.pinned ?? false,
  pinOrder: session.pinOrder ?? null,
  agentId: session.agentId,
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

      // Update in sessions list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].status = status;
        state.sessions[sessionIndex].updatedAt = Date.now();
      }

      // Update current session if applicable
      if (state.currentSession?.id === sessionId) {
        state.currentSession.status = status;
        state.currentSession.updatedAt = Date.now();
        // Streaming state is tied to the currently opened session only
        state.isStreaming = status === CoworkSessionStatusValue.Running;
      }

      if (status === CoworkSessionStatusValue.Completed) {
        markSessionUnread(state, sessionId);
      }
    },

    deleteSession(state, action: PayloadAction<string>) {
      removeSessionFromState(state, action.payload);
    },

    deleteSessions(state, action: PayloadAction<string[]>) {
      removeSessionsFromState(state, action.payload);
    },

    addMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage }>) {
      const { sessionId, message } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const exists = state.currentSession.messages.some((item) => item.id === message.id);
        if (!exists) {
          state.currentSession.messages.push(message);
          state.currentSession.updatedAt = message.timestamp;
          state.currentSession.totalMessages += 1;
        }
      }

      // Update session in list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
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
    },

    updateMessageContent(state, action: PayloadAction<{ sessionId: string; messageId: string; content: string; metadata?: Record<string, unknown> }>) {
      const { sessionId, messageId, content, metadata } = action.payload;
      const updatedAt = Date.now();

      if (state.currentSession?.id === sessionId) {
        const messageIndex = state.currentSession.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          state.currentSession.messages[messageIndex].content = content;
          if (metadata) {
            state.currentSession.messages[messageIndex].metadata = {
              ...state.currentSession.messages[messageIndex].metadata,
              ...metadata,
            };
          }
          state.currentSession.updatedAt = updatedAt;
        }
      }

      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].updatedAt = updatedAt;
      }

      markSessionUnread(state, sessionId);
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

    updateCurrentSessionThinkingLevel(state, action: PayloadAction<{ sessionId: string; thinkingLevel: string }>) {
      const { sessionId, thinkingLevel } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      state.currentSession.thinkingLevel = thinkingLevel;
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
  addSession,
  updateSessionStatus,
  deleteSession,
  deleteSessions,
  addMessage,
  prependMessages,
  updateMessageContent,
  setStreaming,
  setContextUsage,
  setContextCompacting,
  setContextMaintenance,
  markCompactionNotified,
  setRemoteManaged,
  updateSessionPinned,
  updateSessionTitle,
  updateCurrentSessionModelOverride,
  updateCurrentSessionThinkingLevel,
  enqueuePendingPermission,
  dequeuePendingPermission,
  clearPendingPermissions,
  setConfig,
  updateConfig,
  clearCurrentSession,
} = coworkSlice.actions;

export default coworkSlice.reducer;
