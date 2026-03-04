import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { WorkflowState, WorkflowAgent, WorkflowConnection, Skill, WorkflowRun, WorkflowRunAgentEntry, OutputRoute, RouteCondition } from '../../components/workflow/workflowTypes';

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
      workflowRuns: state.workflowRuns,
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
  currentRunId: null,
  currentRunDirectory: null,
  workflowRuns: [],
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
        outputRoutes: [],
      };
      state.agents.push(newAgent);
      saveToStorage(state);
    },

    // Remove agent by id
    removeAgent: (state, action: PayloadAction<string>) => {
      const removedId = action.payload;
      state.agents = state.agents.filter((a: WorkflowAgent) => a.id !== removedId);
      state.connections = state.connections.filter(
        (c: WorkflowConnection) => c.sourceAgentId !== removedId && c.targetAgentId !== removedId
      );
      // Clean up outputRoutes and inputFrom in remaining agents
      state.agents.forEach((a: WorkflowAgent) => {
        if (a.inputFrom === removedId) a.inputFrom = null;
        if (a.outputRoutes) {
          a.outputRoutes = a.outputRoutes.filter((r: OutputRoute) => r.targetAgentId !== removedId);
        }
      });
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

    // Update agent's model override
    updateAgentModel: (state, action: PayloadAction<{ id: string; model?: WorkflowAgentModel }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.id);
      if (agent) {
        if (action.payload.model) {
          agent.model = action.payload.model;
        } else {
          delete agent.model;
        }
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
      condition?: string;
    }>) => {
      const newConnection: WorkflowConnection = {
        id: generateId(),
        sourceAgentId: action.payload.sourceAgentId,
        targetAgentId: action.payload.targetAgentId,
        condition: action.payload.condition || 'Always', // Default to "Always"
      };
      // Avoid duplicate connections
      const isDuplicate = state.connections.some(c =>
        c.sourceAgentId === newConnection.sourceAgentId &&
        c.targetAgentId === newConnection.targetAgentId
      );

      if (!isDuplicate) {
        state.connections.push(newConnection);
        saveToStorage(state);
      }
    },

    // Set agent's inputFrom (upstream node)
    setAgentInputFrom: (state, action: PayloadAction<{ agentId: string; fromAgentId: string | null }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.agentId);
      if (!agent) return;

      const oldFromId = agent.inputFrom;
      agent.inputFrom = action.payload.fromAgentId;

      // Remove old connection if exists
      if (oldFromId) {
        state.connections = state.connections.filter(
          (c: WorkflowConnection) => !(c.sourceAgentId === oldFromId && c.targetAgentId === agent.id)
        );
        // Also remove old upstream node's outputRoute pointing to this agent
        const oldUpstream = state.agents.find((a: WorkflowAgent) => a.id === oldFromId);
        if (oldUpstream) {
          oldUpstream.outputRoutes = (oldUpstream.outputRoutes || []).filter(
            (r: OutputRoute) => r.targetAgentId !== agent.id
          );
        }
      }

      // Add new connection if not null
      if (action.payload.fromAgentId) {
        const exists = state.connections.some(
          (c: WorkflowConnection) => c.sourceAgentId === action.payload.fromAgentId && c.targetAgentId === agent.id
        );
        if (!exists) {
          state.connections.push({
            id: generateId(),
            sourceAgentId: action.payload.fromAgentId,
            targetAgentId: agent.id,
            condition: 'On Complete',
          });
        }
        // Also add a default onComplete outputRoute on the upstream node
        const newUpstream = state.agents.find((a: WorkflowAgent) => a.id === action.payload.fromAgentId);
        if (newUpstream) {
          if (!newUpstream.outputRoutes) newUpstream.outputRoutes = [];
          const alreadyRouted = newUpstream.outputRoutes.some(
            (r: OutputRoute) => r.targetAgentId === agent.id
          );
          if (!alreadyRouted) {
            newUpstream.outputRoutes.push({
              id: generateId(),
              condition: 'onComplete',
              targetAgentId: agent.id,
            });
          }
        }
      }

      saveToStorage(state);
    },

    // Add an output route to an agent
    addOutputRoute: (state, action: PayloadAction<{ agentId: string; route: { condition: RouteCondition; keyword?: string; targetAgentId: string } }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.agentId);
      if (!agent) return;
      if (!agent.outputRoutes) agent.outputRoutes = [];

      const { condition, keyword, targetAgentId } = action.payload.route;
      const newRoute: OutputRoute = {
        id: generateId(),
        condition,
        keyword,
        targetAgentId,
      };
      agent.outputRoutes.push(newRoute);

      // Sync connections array for edge rendering
      const conditionLabel = condition === 'onComplete' ? 'On Complete'
        : condition === 'onError' ? 'On Error'
          : condition === 'outputContains' ? `Contains: ${keyword || ''}`
            : 'Always';
      state.connections.push({
        id: newRoute.id,
        sourceAgentId: agent.id,
        targetAgentId,
        condition: conditionLabel,
      });

      // Also set downstream node's inputFrom
      const downstream = state.agents.find((a: WorkflowAgent) => a.id === targetAgentId);
      if (downstream && !downstream.inputFrom) {
        downstream.inputFrom = agent.id;
      }

      saveToStorage(state);
    },

    // Remove an output route from an agent
    removeOutputRoute: (state, action: PayloadAction<{ agentId: string; routeId: string }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.agentId);
      if (!agent) return;

      const route = (agent.outputRoutes || []).find((r: OutputRoute) => r.id === action.payload.routeId);
      if (route) {
        // Remove from outputRoutes
        agent.outputRoutes = (agent.outputRoutes || []).filter((r: OutputRoute) => r.id !== action.payload.routeId);

        // Remove from connections
        state.connections = state.connections.filter(
          (c: WorkflowConnection) => c.id !== action.payload.routeId
        );

        // If no more routes point to the downstream agent, clear its inputFrom
        const stillConnected = (agent.outputRoutes || []).some(
          (r: OutputRoute) => r.targetAgentId === route.targetAgentId
        );
        if (!stillConnected) {
          const downstream = state.agents.find((a: WorkflowAgent) => a.id === route.targetAgentId);
          if (downstream && downstream.inputFrom === agent.id) {
            downstream.inputFrom = null;
          }
        }
      }

      saveToStorage(state);
    },

    // Update an output route (condition, keyword, or target)
    updateOutputRoute: (state, action: PayloadAction<{ agentId: string; routeId: string; updates: Partial<Pick<OutputRoute, 'condition' | 'keyword' | 'targetAgentId'>> }>) => {
      const agent = state.agents.find((a: WorkflowAgent) => a.id === action.payload.agentId);
      if (!agent) return;

      const route = (agent.outputRoutes || []).find((r: OutputRoute) => r.id === action.payload.routeId);
      if (!route) return;

      const { condition, keyword, targetAgentId } = action.payload.updates;

      // If target changed, update downstream inputFrom
      if (targetAgentId && targetAgentId !== route.targetAgentId) {
        // Clear old downstream
        const stillConnectedToOld = (agent.outputRoutes || []).some(
          (r: OutputRoute) => r.id !== route.id && r.targetAgentId === route.targetAgentId
        );
        if (!stillConnectedToOld) {
          const oldDown = state.agents.find((a: WorkflowAgent) => a.id === route.targetAgentId);
          if (oldDown && oldDown.inputFrom === agent.id) {
            oldDown.inputFrom = null;
          }
        }
        // Set new downstream
        const newDown = state.agents.find((a: WorkflowAgent) => a.id === targetAgentId);
        if (newDown && !newDown.inputFrom) {
          newDown.inputFrom = agent.id;
        }
        route.targetAgentId = targetAgentId;
      }

      if (condition !== undefined) route.condition = condition;
      if (keyword !== undefined) route.keyword = keyword;

      // Sync connection label
      const conn = state.connections.find((c: WorkflowConnection) => c.id === route.id);
      if (conn) {
        conn.targetAgentId = route.targetAgentId;
        const cond = route.condition;
        conn.condition = cond === 'onComplete' ? 'On Complete'
          : cond === 'onError' ? 'On Error'
            : cond === 'outputContains' ? `Contains: ${route.keyword || ''}`
              : 'Always';
      }

      saveToStorage(state);
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
      state.currentRunId = null;
      state.currentRunDirectory = null;
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
      state.currentRunId = null;
      state.currentRunDirectory = null;
      saveToStorage(state);
    },

    // Set workflow run directory for workspace isolation
    setWorkflowRunDirectory: (state, action: PayloadAction<{ runId: string; directory: string }>) => {
      state.currentRunId = action.payload.runId;
      state.currentRunDirectory = action.payload.directory;
    },

    // Add a new workflow run
    addWorkflowRun: (state, action: PayloadAction<WorkflowRun>) => {
      state.workflowRuns.unshift(action.payload);
      // Keep only last 50 runs
      if (state.workflowRuns.length > 50) {
        state.workflowRuns = state.workflowRuns.slice(0, 50);
      }
      saveToStorage(state);
    },

    // Update workflow run status
    updateWorkflowRun: (state, action: PayloadAction<{ id: string; updates: Partial<WorkflowRun> }>) => {
      const run = state.workflowRuns.find(r => r.id === action.payload.id);
      if (run) {
        Object.assign(run, action.payload.updates);
        saveToStorage(state);
      }
    },

    // Update a specific agent entry in a workflow run
    updateWorkflowRunAgent: (state, action: PayloadAction<{ runId: string; agentId: string; updates: Partial<WorkflowRunAgentEntry> }>) => {
      const run = state.workflowRuns.find(r => r.id === action.payload.runId);
      if (run) {
        const agentEntry = run.agents.find(a => a.agentId === action.payload.agentId);
        if (agentEntry) {
          Object.assign(agentEntry, action.payload.updates);
          saveToStorage(state);
        }
      }
    },

    // Remove a workflow run
    removeWorkflowRun: (state, action: PayloadAction<string>) => {
      state.workflowRuns = state.workflowRuns.filter(r => r.id !== action.payload);
      saveToStorage(state);
    },

    // Clear all workflow runs
    clearWorkflowRuns: (state) => {
      state.workflowRuns = [];
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
  updateAgentModel,
  updateAgent,
  addSkillToAgent,
  removeSkillFromAgent,
  addConnection,
  removeConnection,
  updateConnectionTrigger,
  updateConnectionCondition,
  setAgentInputFrom,
  addOutputRoute,
  removeOutputRoute,
  updateOutputRoute,
  setAgentStatus,
  setRunningState,
  startWorkflow,
  stopWorkflow,
  resetWorkflow,
  clearWorkflow,
  setWorkflowRunDirectory,
  addSkill,
  updateCustomSkill,
  removeSkill,
  addWorkflowRun,
  updateWorkflowRun,
  updateWorkflowRunAgent,
  removeWorkflowRun,
  clearWorkflowRuns,
} = workflowSlice.actions;

export default workflowSlice.reducer;
