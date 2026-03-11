import React, { useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import {
  PlayIcon,
  ArrowRightIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { startWorkflow, stopWorkflow, resetWorkflow, setAgentStatus } from '../../store/slices/workflowSlice';
import { i18nService } from '../../services/i18n';
import dagre from 'dagre';
import type { WorkflowAgent, WorkflowConnection } from './workflowTypes';

interface WorkflowExecutionBarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const WorkflowExecutionBar: React.FC<WorkflowExecutionBarProps> = ({ collapsed, onToggleCollapse }) => {
  const dispatch = useDispatch();
  const { agents, connections, isRunning, currentRunningAgentId } = useSelector(
    (state: RootState) => state.workflow
  );

  // Calculate execution order using topological sort
  const executionOrder = useMemo(() => {
    if (agents.length === 0) return [];

    // Build adjacency list
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({});
    graph.setDefaultEdgeLabel(() => ({}));

    agents.forEach((agent: WorkflowAgent) => {
      graph.setNode(agent.id, { label: agent.name });
    });

    connections.forEach((conn: WorkflowConnection) => {
      graph.setEdge(conn.sourceAgentId, conn.targetAgentId);
    });

    try {

      const order = (dagre as any).graphlib.topoSort(graph);
      return order.map((id: string) => agents.find((a: WorkflowAgent) => a.id === id)).filter(Boolean);
    } catch {
      return agents;
    }
  }, [agents, connections]);

  const handleRunWorkflow = async () => {
    if (isRunning || executionOrder.length === 0) return;

    dispatch(startWorkflow());

    // Run each agent in sequence
    for (const agent of executionOrder) {
      if (!agent) continue;

      dispatch(setAgentStatus({ id: agent.id, status: 'running' }));

      // Simulate agent execution (in real app, this would trigger actual agent tasks)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Mark as completed
      dispatch(setAgentStatus({ id: agent.id, status: 'completed' }));
    }

    dispatch(stopWorkflow());
  };

  const handleReset = () => {
    dispatch(resetWorkflow());
  };

  const getAgentStatusIcon = (agentId: string) => {
    const agent = agents.find((a: WorkflowAgent) => a.id === agentId);
    if (!agent) return null;

    switch (agent.status) {
      case 'running':
        return <ClockIcon className="w-4 h-4 text-yellow-500 animate-pulse" />;
      case 'completed':
        return <CheckCircleIcon className="w-4 h-4 text-green-500" />;
      case 'error':
        return <XCircleIcon className="w-4 h-4 text-red-500" />;
      default:
        return <div className="w-4 h-4 rounded-full border-2 border-gray-300" />;
    }
  };

  return (
    <div className={`
      border-t dark:border-claude-darkBorder border-claude-border
      dark:bg-claude-darkSurface bg-claude-surface
      transition-all duration-300
      ${collapsed ? 'h-10' : 'h-auto'}
    `}>
      {/* Collapse Toggle */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleCollapse}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleCollapse();
          }
        }}
        className="w-full h-10 flex items-center justify-between px-4 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {collapsed ? (
            <ChevronUpIcon className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          ) : (
            <ChevronDownIcon className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          )}
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('workflowExecutionOrder')}
          </span>
        </div>

        {executionOrder.length > 0 && !collapsed && (
          <div className="flex items-center gap-2">
            {/* Reset Button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleReset();
              }}
              disabled={isRunning}
              className={`
                flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                ${isRunning
                  ? 'bg-gray-400/50 cursor-not-allowed'
                  : 'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover hover:bg-gray-200 dark:hover:bg-gray-700 dark:text-claude-darkText text-claude-text'
                }
              `}
            >
              <ArrowPathIcon className="w-4 h-4" />
              {i18nService.t('workflowReset')}
            </button>

            {/* Run Button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRunWorkflow();
              }}
              disabled={isRunning}
              className={`
                flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                ${isRunning
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-claude-accent hover:bg-claude-accentHover text-white'
                }
              `}
            >
              <PlayIcon className={`w-4 h-4 ${isRunning ? 'animate-pulse' : ''}`} />
              {i18nService.t('workflowRunWorkflow')}
            </button>
          </div>
        )}
      </div>

      {/* Execution Order Display */}
      {!collapsed && executionOrder.length > 0 && (
        <div className="px-4 pb-4">
          <div className="flex items-center gap-2 flex-wrap">
            {executionOrder.map((agent: WorkflowAgent | undefined, index: number) => (
              <React.Fragment key={agent?.id}>
                <div
                  className={`
                    flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm
                    dark:bg-claude-darkBg bg-claude-bg
                    ${currentRunningAgentId === agent?.id
                      ? 'ring-2 ring-claude-accent'
                      : ''
                    }
                  `}
                >
                  {getAgentStatusIcon(agent?.id || '')}
                  <span className="dark:text-claude-darkText text-claude-text">
                    {agent?.name}
                  </span>
                </div>
                {index < executionOrder.length - 1 && (
                  <ArrowRightIcon className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!collapsed && executionOrder.length === 0 && (
        <div className="px-4 pb-4">
          <p className="text-sm text-gray-400 dark:text-gray-500">
            {i18nService.t('workflowNoAgents')}
          </p>
        </div>
      )}
    </div>
  );
};

export default WorkflowExecutionBar;
