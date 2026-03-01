import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { WorkflowState, WorkflowAgent, WorkflowConnection, Skill } from '../../components/workflow/workflowTypes';

const STORAGE_KEY = 'lobsterai-workflow';

// Helper to generate UUID
const generateId = () => crypto.randomUUID();

const loadFromStorage = (): Partial<WorkflowState> => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load workflow from storage:', e);
  }
  return {};
};

const saveToStorage = (state: WorkflowState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      agents: state.agents,
      connections: state.connections,
      skills: state.skills,
    }));
  } catch (e) {
    console.error('Failed to save workflow to storage:', e);
  }
};

const initialState: WorkflowState = {
  agents: [],
  connections: [],
  skills: [],
  isRunning: false,
  currentRunningAgentId: null,
  ...loadFromStorage(),
};

const workflowSlice = createSlice({
  name: 'workflow',
  initialState,
  reducers: {
    // Add a new agent with given name and optional soul prompt
    addAgent: (state, action: PayloadAction<{ name: string; soulPrompt?: string; skills?: Skill[] }>) => {
      const newAgent: WorkflowAgent = {
        id: generateId(),
        name: action.payload.name,
        skills: action.payload.skills || [],
        status: 'idle',
        position: { x: 100 + state.agents.length * 250, y: 100 },
        soulPrompt: action.payload.soulPrompt,
      };
      state.agents.push(newAgent);
      saveToStorage(state);
    },

    // Remove agent by id
    removeAgent: (state, action: PayloadAction<string>) => {
      state.agents = state.agents.filter((a: WorkflowAgent) => a.id !== action.payload);
      state.connections = state.connections.filter(
        (c: WorkflowConnection) => c.sourceAgentId !== action.payload && c.targetAgentId !== action.payload
      );
      saveToStorage(state);
    },

    // Update agent position
    updateAgentPosition: (state, action: PayloadAction<{ id: string; position: { x: number; y: number } }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.id);
      if (agent) {
        agent.position = action.payload.position;
        saveToStorage(state);
      }
    },

    // Update agent size
    updateAgentSize: (state, action: PayloadAction<{ id: string; width: number; height: number }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.id);
      if (agent) {
        agent.width = action.payload.width;
        agent.height = action.payload.height;
        saveToStorage(state);
      }
    },

    // Rename agent
    renameAgent: (state, action: PayloadAction<{ id: string; name: string }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.id);
      if (agent) {
        agent.name = action.payload.name;
        saveToStorage(state);
      }
    },

    // Update agent's soul (system prompt)
    updateAgentSoul: (state, action: PayloadAction<{ id: string; soulPrompt: string }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.id);
      if (agent) {
        agent.soulPrompt = action.payload.soulPrompt;
        saveToStorage(state);
      }
    },

    // Update full agent (for any other updates)
    updateAgent: (state, action: PayloadAction<{ id: string; updates: Partial<WorkflowAgent> }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.id);
      if (agent) {
        Object.assign(agent, action.payload.updates);
        saveToStorage(state);
      }
    },

    // Add skill to agent
    addSkillToAgent: (state, action: PayloadAction<{ agentId: string; skill: Skill }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.agentId);
      if (agent && !agent.skills.find((s: Skill) => s.id === action.payload.skill.id)) {
        agent.skills.push(action.payload.skill);
        saveToStorage(state);
      }
    },

    // Remove skill from agent
    removeSkillFromAgent: (state, action: PayloadAction<{ agentId: string; skillId: string }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.agentId);
      if (agent) {
        agent.skills = agent.skills.filter((s: Skill) => s.id !== action.payload.skillId);
        saveToStorage(state);
      }
    },

    // Add connection between agents
    addConnection: (state, action: PayloadAction<{
      sourceAgentId: string;
      targetAgentId: string;
      sourceHandle?: string | null;
      targetHandle?: string | null;
      condition?: string;
    }>) => {
      const newConnection: WorkflowConnection = {
        id: generateId(),
        sourceAgentId: action.payload.sourceAgentId,
        targetAgentId: action.payload.targetAgentId,
        sourceHandle: action.payload.sourceHandle || undefined,
        targetHandle: action.payload.targetHandle || undefined,
        condition: action.payload.condition || 'Always', // Default to "Always"
      };
      // Avoid duplicate connections to the same handle
      const isDuplicate = state.connections.some(c =>
        c.sourceAgentId === newConnection.sourceAgentId &&
        c.targetAgentId === newConnection.targetAgentId &&
        c.sourceHandle === newConnection.sourceHandle &&
        c.targetHandle === newConnection.targetHandle
      );

      if (!isDuplicate) {
        state.connections.push(newConnection);
        saveToStorage(state);
      }
    },

    // Remove connection by id
    removeConnection: (state, action: PayloadAction<string>) => {
      state.connections = state.connections.filter((c: WorkflowConnection) => c.id !== action.payload);
      saveToStorage(state);
    },

    // Update connection trigger condition (legacy - for backward compatibility)
    updateConnectionTrigger: (state, action: PayloadAction<{ id: string; trigger: string }>) => {
      const conn = state.connections.find((c: WorkflowConnection) => c.id === action.payload.id);
      if (conn) {
        // Map old trigger values to new condition strings
        const triggerToCondition: Record<string, string> = {
          'onComplete': 'On Complete',
          'onError': 'On Error',
          'always': 'Always',
        };
        conn.condition = triggerToCondition[action.payload.trigger] || action.payload.trigger;
        saveToStorage(state);
      }
    },

    // Update connection condition (natural language)
    updateConnectionCondition: (state, action: PayloadAction<{ id: string; condition: string }>) => {
      const conn = state.connections.find((c: WorkflowConnection) => c.id === action.payload.id);
      if (conn) {
        conn.condition = action.payload.condition;
        saveToStorage(state);
      }
    },

    // Set agent status
    setAgentStatus: (state, action: PayloadAction<{ id: string; status: WorkflowAgent['status'] }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.id);
      if (agent) {
        agent.status = action.payload.status;
      }
    },

    // Set overall running state
    setRunningState: (state, action: PayloadAction<{ isRunning: boolean; currentAgentId: string | null }>) => {
      state.isRunning = action.payload.isRunning;
      state.currentRunningAgentId = action.payload.currentAgentId;
    },

    // Start workflow execution
    startWorkflow: (state) => {
      state.isRunning = true;
      state.currentRunningAgentId = state.agents.length > 0 ? state.agents[0].id : null;
      // Reset all agent statuses
      state.agents.forEach((agent: WorkflowAgent) => {
        agent.status = 'idle';
      });
    },

    // Stop workflow execution
    stopWorkflow: (state) => {
      state.isRunning = false;
      if (state.currentRunningAgentId) {
        const agent = state.agents.find((a: WorkflowAgent) => a.id === state.currentRunningAgentId);
        if (agent && agent.status === 'running') {
          agent.status = 'idle';
        }
      }
      state.currentRunningAgentId = null;
    },

    // Reset workflow - clear all statuses and stop
    resetWorkflow: (state) => {
      state.isRunning = false;
      state.currentRunningAgentId = null;
      state.agents.forEach((agent: WorkflowAgent) => {
        agent.status = 'idle';
      });
    },

    // Clear all workflow data
    clearWorkflow: (state) => {
      state.agents = [];
      state.connections = [];
      state.isRunning = false;
      state.currentRunningAgentId = null;
      saveToStorage(state);
    },

    // Add a global skill (for SkillPalette)
    addSkill: (state, action: PayloadAction<Skill>) => {
      state.skills.push(action.payload);
      saveToStorage(state);
    },

    // Update a custom or predefined skill's details (e.g. its prompt override)
    updateCustomSkill: (state, action: PayloadAction<Skill>) => {
      const index = state.skills.findIndex(s => s.id === action.payload.id);
      if (index !== -1) {
        state.skills[index] = { ...state.skills[index], ...action.payload };
      } else {
        // If it's a predefined skill being edited for the first time, add it to custom skills as an override
        state.skills.push(action.payload);
      }
      saveToStorage(state);
    },

    // Remove a global skill
    removeSkill: (state, action: PayloadAction<string>) => {
      state.skills = state.skills.filter((s: Skill) => s.id !== action.payload);
      // Remove skill from all agents
      state.agents.forEach((agent: WorkflowAgent) => {
        agent.skills = agent.skills.filter((s: Skill) => s.id !== action.payload);
      });
      saveToStorage(state);
    },
  },
});

export const {
  addAgent,
  removeAgent,
  updateAgentPosition,
  updateAgentSize,
  renameAgent,
  updateAgentSoul,
  updateAgent,
  addSkillToAgent,
  removeSkillFromAgent,
  addConnection,
  removeConnection,
  updateConnectionTrigger,
  updateConnectionCondition,
  setAgentStatus,
  setRunningState,
  startWorkflow,
  stopWorkflow,
  resetWorkflow,
  clearWorkflow,
  addSkill,
  updateCustomSkill,
  removeSkill,
} = workflowSlice.actions;

export default workflowSlice.reducer;
