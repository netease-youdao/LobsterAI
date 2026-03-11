import React, { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  Panel,
  useNodesState,
  useEdgesState,
  Edge,
  Node,
  BackgroundVariant,
  MarkerType,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import {
  renameAgent,
  removeAgent,
  removeSkillFromAgent,
  addSkillToAgent,
  updateAgentPosition,
  updateAgentSize,
  clearWorkflow,
  setAgentInputFrom,
  addOutputRoute,
  removeOutputRoute,
  updateOutputRoute,
} from '../../store/slices/workflowSlice';
import AgentNode from './AgentNode';
import CustomEdge from './CustomEdge';
import AgentConfigPanel from './AgentConfigPanel';
import type { Skill, WorkflowAgent as WorkflowAgentType, WorkflowConnection as WorkflowConnectionType } from './workflowTypes';
import { i18nService } from '../../services/i18n';
import { workflowEngine } from '../../services/workflowEngine';
import {
  ArrowsPointingOutIcon,
  TrashIcon,
  ExclamationTriangleIcon,
  RocketLaunchIcon,
  CogIcon,
  StopIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';

// Custom node types — defined OUTSIDE component to avoid re-creation
const nodeTypes = {
  agent: AgentNode,
};

const edgeTypes = {
  custom: CustomEdge,
};

interface WorkflowCanvasProps {
  focusAgentId?: string | null;
  onShowSkills?: (skillId: string) => void;
}

const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({ focusAgentId, onShowSkills }) => {
  const dispatch = useDispatch();
  const workflow = useSelector((state: RootState) => state.workflow);
  const { agents, connections, isRunning } = workflow;

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [taskInput, setTaskInput] = useState('');

  const selectedAgent = selectedAgentId
    ? agents.find((a: WorkflowAgentType) => a.id === selectedAgentId) || null
    : null;

  // Convert workflow agents to React Flow nodes
  const initialNodes: Node[] = useMemo(() => {
    return agents.map((agent: WorkflowAgentType) => ({
      id: agent.id,
      type: 'agent',
      position: agent.position,
      style: {
        width: agent.width ?? 200,
        height: agent.height,
      },
      data: {
        agent,
        allAgents: agents,
        onRemove: (id: string) => dispatch(removeAgent(id)),
        onRemoveSkill: (agentId: string, skillId: string) =>
          dispatch(removeSkillFromAgent({ agentId, skillId })),
        onAddSkill: (agentId: string, skill: Skill) =>
          dispatch(addSkillToAgent({ agentId, skill })),
        onUpdateName: (id: string, name: string) =>
          dispatch(renameAgent({ id, name })),
        onUpdateSize: (id: string, width: number, height: number) =>
          dispatch(updateAgentSize({ id, width, height })),
        onSelect: (id: string) => setSelectedAgentId(id),
        onSetInputFrom: (agentId: string, fromId: string | null) =>
          dispatch(setAgentInputFrom({ agentId, fromAgentId: fromId })),
        onAddRoute: (agentId: string, condition: any, targetAgentId: string, keyword?: string) =>
          dispatch(addOutputRoute({ agentId, route: { condition, targetAgentId, keyword } })),
        onRemoveRoute: (agentId: string, routeId: string) =>
          dispatch(removeOutputRoute({ agentId, routeId })),
        onUpdateRoute: (agentId: string, routeId: string, updates: any) =>
          dispatch(updateOutputRoute({ agentId, routeId, updates })),
      },
      selected: agent.id === selectedAgentId,
    }));
  }, [agents, dispatch, selectedAgentId]);

  const initialEdges: Edge[] = useMemo(() => {
    // Track processed directed pairs to detect reverse/bidirectional edges
    const processedPairs = new Set<string>();

    return connections
      .map((conn: WorkflowConnectionType) => {
        const getLineColor = () => {
          const lower = (conn.condition || '').toLowerCase();
          if (lower.includes('error') || lower.includes('fail')) return '#EF4444';
          if (lower.includes('complete') || lower.includes('success')) return '#8B5CF6';
          return '#3B82F6';
        };

        const sourceAgent = agents.find((a: WorkflowAgentType) => a.id === conn.sourceAgentId);
        const targetAgent = agents.find((a: WorkflowAgentType) => a.id === conn.targetAgentId);

        let sourceHandle = 'source-bottom';
        let targetHandle = 'target-top';

        if (sourceAgent && targetAgent) {
          const sourceW = sourceAgent.width ?? 200;
          const targetW = targetAgent.width ?? 200;
          const sourceCX = sourceAgent.position.x + sourceW / 2;
          const sourceCY = sourceAgent.position.y + 100;
          const targetCX = targetAgent.position.x + targetW / 2;
          const targetCY = targetAgent.position.y + 100;

          const dx = targetCX - sourceCX;
          const dy = targetCY - sourceCY;
          const primaryIsHorizontal = Math.abs(dx) > Math.abs(dy);

          // Check if the reverse pair was already processed (i.e., this is the second edge between these two nodes)
          const pairKey = `${conn.sourceAgentId}<->${conn.targetAgentId}`;
          const reversePairKey = `${conn.targetAgentId}<->${conn.sourceAgentId}`;
          const isReverseEdge = processedPairs.has(reversePairKey);

          if (!isReverseEdge) {
            // FORWARD EDGE: use the natural axis based on node positions
            if (primaryIsHorizontal) {
              if (dx > 0) {
                sourceHandle = 'source-right';
                targetHandle = 'target-left';
              } else {
                sourceHandle = 'source-left';
                targetHandle = 'target-right';
              }
            } else {
              if (dy > 0) {
                sourceHandle = 'source-bottom';
                targetHandle = 'target-top';
              } else {
                sourceHandle = 'source-top';
                targetHandle = 'target-bottom';
              }
            }
          } else {
            // REVERSE EDGE: use the SAME side on both source and target
            // This creates a separate arc that doesn't overlap with the forward edge
            if (primaryIsHorizontal) {
              // Forward went left/right, so reverse goes via top or bottom
              // Pick top if source is above target, bottom otherwise
              if (sourceCY <= targetCY) {
                sourceHandle = 'source-top';
                targetHandle = 'target-top';
              } else {
                sourceHandle = 'source-bottom';
                targetHandle = 'target-bottom';
              }
            } else {
              // Forward went top/bottom, so reverse goes via left or right
              if (sourceCX <= targetCX) {
                sourceHandle = 'source-left';
                targetHandle = 'target-left';
              } else {
                sourceHandle = 'source-right';
                targetHandle = 'target-right';
              }
            }
          }

          processedPairs.add(pairKey);
        }

        return {
          id: conn.id,
          source: conn.sourceAgentId,
          target: conn.targetAgentId,
          sourceHandle,
          targetHandle,
          type: 'custom',
          animated: true,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: getLineColor(),
          },
          style: { stroke: getLineColor(), strokeWidth: 2 },
          data: {
            condition: conn.condition,
          },
        };
      });
  }, [connections, agents]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync nodes with Redux store
  React.useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);

  React.useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  // Agent status is driven directly by the workflow engine via Redux dispatch
  // (setAgentStatus action) — no need for session-title-based sync here.

  // Handle node position changes
  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, node: Node) => {
      dispatch(updateAgentPosition({ id: node.id, position: node.position }));
    },
    [dispatch]
  );



  // Handle node selection
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedAgentId(node.id);
    },
    []
  );

  // Handle pane click (deselect)
  const onPaneClick = useCallback(
    () => {
      setSelectedAgentId(null);
    },
    []
  );

  // Clear canvas
  const handleClearCanvas = useCallback(() => {
    dispatch(clearWorkflow());
    setShowClearConfirm(false);
  }, [dispatch]);

  // Handle task assignment - integrate with actual agent execution engine
  const handleRunTask = useCallback(async () => {
    if (!taskInput.trim()) return;

    // Close modal
    setShowTaskModal(false);

    // Start real workflow execution
    try {
      await workflowEngine.start(
        agents,
        connections,
        taskInput.trim()
      );
    } catch (error) {
      console.error('Workflow execution failed:', error);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: `❌ Workflow failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }));
    }

    setTaskInput('');
  }, [taskInput, agents, connections]);

  // Handle stop workflow
  const handleStopWorkflow = useCallback(async () => {
    await workflowEngine.stop();
  }, []);

  // Fit view
  const { fitView, setCenter } = useReactFlow();

  // Auto-focus on agent when created
  React.useEffect(() => {
    if (focusAgentId === 'last' && agents.length > 0) {
      // Focus on the last added agent
      const lastAgent = agents[agents.length - 1];
      if (lastAgent) {
        setCenter(lastAgent.position.x + 100, lastAgent.position.y + 50, { zoom: 1.2, duration: 500 });
      }
    } else if (focusAgentId && focusAgentId !== 'last') {
      // Focus on specific agent
      const agent = agents.find((a: WorkflowAgentType) => a.id === focusAgentId);
      if (agent) {
        setCenter(agent.position.x + 100, agent.position.y + 50, { zoom: 1.2, duration: 500 });
      }
    }
  }, [focusAgentId, agents, setCenter]);

  return (
    <div className="h-full w-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.4}
        maxZoom={2}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        defaultEdgeOptions={{
          type: 'custom',
          animated: true,
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#6b7280" />
        <Controls className="!bg-claude-surface !border-claude-border dark:!bg-claude-darkSurface dark:!border-claude-darkBorder" />

        {/* Toolbar */}
        <Panel position="top-right" className="flex gap-2 !m-4">
          {/* Agent Count */}
          {agents.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-claude-surface dark:bg-claude-darkSurface border border-claude-border dark:border-claude-darkBorder text-sm font-medium dark:text-claude-darkText text-claude-text shadow-sm">
              <UserGroupIcon className="w-4 h-4" />
              <span>{agents.length}</span>
              <span className="text-gray-500 dark:text-gray-400">{i18nService.t('agentsTab')}</span>
            </div>
          )}

          {/* Run Task / Stop Button */}
          {isRunning ? (
            <button
              onClick={handleStopWorkflow}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors shadow-sm"
            >
              <StopIcon className="w-4 h-4" />
              {i18nService.t('workflowStop') || 'Stop'}
            </button>
          ) : (
            <button
              onClick={() => setShowTaskModal(true)}
              disabled={agents.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white text-sm font-medium transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RocketLaunchIcon className="w-4 h-4" />
              Run Task
            </button>
          )}

          {/* Config Selected Agent Button */}
          <button
            onClick={() => selectedAgentId && setSelectedAgentId(selectedAgentId)}
            disabled={!selectedAgentId}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition-colors shadow-sm ${selectedAgentId
              ? 'bg-claude-surface dark:bg-claude-darkSurface border-claude-border dark:border-claude-darkBorder hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover dark:text-claude-darkText text-claude-text'
              : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-400 cursor-not-allowed'
              }`}
          >
            <CogIcon className="w-4 h-4" />
            Configure
          </button>

          {/* Fit View Button */}
          <button
            onClick={() => fitView()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-claude-surface dark:bg-claude-darkSurface border border-claude-border dark:border-claude-darkBorder text-sm font-medium hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors dark:text-claude-darkText text-claude-text shadow-sm"
          >
            <ArrowsPointingOutIcon className="w-4 h-4" />
            {i18nService.t('workflowFitView')}
          </button>

          {/* Clear Canvas Button */}
          <button
            onClick={() => setShowClearConfirm(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-claude-surface dark:bg-claude-darkSurface border border-claude-border dark:border-claude-darkBorder text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-300 dark:hover:border-red-700 hover:text-red-600 dark:hover:text-red-400 transition-colors dark:text-claude-darkText text-claude-text shadow-sm"
          >
            <TrashIcon className="w-4 h-4" />
            {i18nService.t('workflowClearCanvas')}
          </button>
        </Panel>
      </ReactFlow>

      {/* Agent Config Panel */}
      <AgentConfigPanel
        agent={selectedAgent}
        onClose={() => setSelectedAgentId(null)}
        onRemoveSkill={(agentId, skillId) => dispatch(removeSkillFromAgent({ agentId, skillId }))}
        onAddSkill={(agentId, skill) => dispatch(addSkillToAgent({ agentId, skill }))}
        onShowSkills={onShowSkills}
      />

      {/* Clear Confirmation Dialog */}
      {showClearConfirm && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="bg-claude-surface dark:bg-claude-darkSurface rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <ExclamationTriangleIcon className="w-5 h-5 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('workflowClearCanvas')}?
              </h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              This action cannot be undone. All agents and connections will be removed.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="flex-1 px-4 py-2 rounded-lg border border-claude-border dark:border-claude-darkBorder text-sm font-medium hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors dark:text-claude-darkText text-claude-text"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleClearCanvas}
                className="flex-1 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors"
              >
                {i18nService.t('workflowClearCanvas')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Assignment Modal */}
      {showTaskModal && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="bg-claude-surface dark:bg-claude-darkSurface rounded-xl p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-claude-accent/20 flex items-center justify-center">
                <RocketLaunchIcon className="w-5 h-5 text-claude-accent" />
              </div>
              <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                Assign Task
              </h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Enter a task for the workflow to process. The entry agent will receive this prompt.
            </p>
            <textarea
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder="e.g., Build a Go JWT registration endpoint with Angular frontend..."
              className="w-full h-32 px-3 py-2 text-sm rounded-lg border dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text placeholder-gray-400 focus:outline-none focus:border-claude-accent resize-none mb-4"
              autoFocus
            />
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setTaskInput('');
                  setShowTaskModal(false);
                }}
                className="flex-1 px-4 py-2 rounded-lg border border-claude-border dark:border-claude-darkBorder text-sm font-medium hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors dark:text-claude-darkText text-claude-text"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleRunTask}
                disabled={!taskInput.trim() || agents.length === 0}
                className="flex-1 px-4 py-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Run Task
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkflowCanvas;
