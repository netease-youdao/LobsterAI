import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { AgentId } from '@shared/agent';
import { type AgentModelSelectionMode, AgentSource, type SubagentCollaborationMode } from '@shared/agent/constants';
import type { ModelThinkingLevel } from '@shared/providers/modelThinking';

import { resetAccountSessionData } from '../accountSessionBoundary';

interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt?: string;
  identity?: string;
  icon: string;
  iconCustomized?: boolean;
  model: string;
  modelSelectionMode?: AgentModelSelectionMode;
  thinkingLevel: ModelThinkingLevel | '';
  workingDirectory: string;
  enabled: boolean;
  pinned: boolean;
  pinOrder?: number | null;
  sortOrder?: number | null;
  isDefault: boolean;
  source: 'custom' | 'preset';
  presetId?: string;
  presetRevision?: number;
  dismissedPresetRevision?: number;
  skillIds: string[];
  subagentCollaborationMode?: SubagentCollaborationMode;
  subagentAllowAgentIds: string[];
}

interface AgentState {
  agents: AgentSummary[];
  expertRevisions: Record<string, number>;
  currentAgentId: string;
  loading: boolean;
  sidebarRevealAgentId: string | null;
}

const initialState: AgentState = {
  agents: [],
  expertRevisions: {},
  currentAgentId: AgentId.Main,
  loading: false,
  sidebarRevealAgentId: null,
};

const agentSlice = createSlice({
  name: 'agent',
  initialState,
  reducers: {
    setExpertRevisions(state, action: PayloadAction<Record<string, number>>) {
      state.expertRevisions = action.payload;
    },

    setAgents(state, action: PayloadAction<AgentSummary[]>) {
      state.agents = action.payload;
      if (!state.agents.some(agent => agent.id === state.currentAgentId)) {
        state.currentAgentId = AgentId.Main;
      }
    },

    setCurrentAgentId(state, action: PayloadAction<string>) {
      if (action.payload === AgentId.Main || state.agents.some(agent => agent.id === action.payload)) {
        state.currentAgentId = action.payload;
      }
    },

    setSidebarRevealAgentId(state, action: PayloadAction<string | null>) {
      state.sidebarRevealAgentId = action.payload;
    },

    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },

    addAgent(state, action: PayloadAction<AgentSummary>) {
      const index = state.agents.findIndex(agent => agent.id === action.payload.id);
      if (index === -1) {
        state.agents.push(action.payload);
      } else {
        state.agents[index] = action.payload;
      }
    },

    updateAgent(state, action: PayloadAction<{ id: string; updates: Partial<AgentSummary> }>) {
      const index = state.agents.findIndex((a) => a.id === action.payload.id);
      if (index !== -1) {
        state.agents[index] = { ...state.agents[index], ...action.payload.updates };
      }
    },

    removeAgent(state, action: PayloadAction<string>) {
      state.agents = state.agents.filter((a) => a.id !== action.payload);
      if (state.sidebarRevealAgentId === action.payload) {
        state.sidebarRevealAgentId = null;
      }
      if (state.currentAgentId === action.payload) {
        state.currentAgentId = AgentId.Main;
      }
    },
  },
  extraReducers: builder => {
    builder.addCase(resetAccountSessionData, (state, { payload }) => {
      // Preserve only a guest preset's navigation target until the scoped agent list revalidates it.
      const guestPreset = payload?.firstLogin && state.agents.find(agent =>
        agent.id === state.currentAgentId && agent.source === AgentSource.Preset && agent.presetId);
      return { ...initialState, currentAgentId: guestPreset ? guestPreset.id : AgentId.Main };
    });
  },
});

export const {
  setAgents,
  setExpertRevisions,
  setCurrentAgentId,
  setSidebarRevealAgentId,
  setLoading,
  addAgent,
  updateAgent,
  removeAgent,
} = agentSlice.actions;

export default agentSlice.reducer;
