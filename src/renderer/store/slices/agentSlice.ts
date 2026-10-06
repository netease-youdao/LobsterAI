import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { ModelThinkingLevel } from '@shared/providers/modelThinking';

interface AgentSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  model: string;
  thinkingLevel: ModelThinkingLevel | '';
  workingDirectory: string;
  enabled: boolean;
  pinned: boolean;
  pinOrder?: number | null;
  sortOrder?: number | null;
  isDefault: boolean;
  source: 'custom' | 'preset';
  skillIds: string[];
  subagentAllowAgentIds: string[];
}

interface AgentState {
  agents: AgentSummary[];
  currentAgentId: string;
  loading: boolean;
}

const initialState: AgentState = {
  agents: [],
  currentAgentId: 'main',
  loading: false,
};

const agentSlice = createSlice({
  name: 'agent',
  initialState,
  reducers: {
    setAgents(state, action: PayloadAction<AgentSummary[]>) {
      state.agents = action.payload;
    },

    setCurrentAgentId(state, action: PayloadAction<string>) {
      state.currentAgentId = action.payload;
    },

    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },

    addAgent(state, action: PayloadAction<AgentSummary>) {
      state.agents.push(action.payload);
    },

    updateAgent(state, action: PayloadAction<{ id: string; updates: Partial<AgentSummary> }>) {
      const index = state.agents.findIndex((a) => a.id === action.payload.id);
      if (index !== -1) {
        state.agents[index] = { ...state.agents[index], ...action.payload.updates };
      }
    },

    removeAgent(state, action: PayloadAction<string>) {
      state.agents = state.agents.filter((a) => a.id !== action.payload);
      if (state.currentAgentId === action.payload) {
        state.currentAgentId = 'main';
      }
    },
  },
});

export const {
  setAgents,
  setCurrentAgentId,
  setLoading,
  addAgent,
  updateAgent,
  removeAgent,
} = agentSlice.actions;

export default agentSlice.reducer;
