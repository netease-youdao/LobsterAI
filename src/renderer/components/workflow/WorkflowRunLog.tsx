import React, { useState, useEffect } from 'react';
import {
  ChevronUpIcon,
  ChevronDownIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowPathIcon,
  ArrowRightIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { WorkflowLogEntry } from '../../services/workflowEngine';

interface WorkflowRunLogProps {
  logs: WorkflowLogEntry[];
  isRunning: boolean;
  onStop?: () => void;
  onReset?: () => void;
}

const WorkflowRunLog: React.FC<WorkflowRunLogProps> = ({ logs, isRunning, onStop, onReset }) => {
  const [collapsed, setCollapsed] = useState(false);

  // Auto-collapse when not running and has logs
  useEffect(() => {
    if (!isRunning && logs.length > 0) {
      // Keep expanded for a moment to show completion
      const timer = setTimeout(() => setCollapsed(true), 5000);
      return () => clearTimeout(timer);
    }
  }, [isRunning, logs.length]);

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const getStatusIcon = (status: WorkflowLogEntry['status']) => {
    switch (status) {
      case 'running':
        return <ClockIcon className="w-4 h-4 text-yellow-500 animate-pulse" />;
      case 'completed':
        return <CheckCircleIcon className="w-4 h-4 text-green-500" />;
      case 'error':
        return <XCircleIcon className="w-4 h-4 text-red-500" />;
      case 'skipped':
        return <ArrowPathIcon className="w-4 h-4 text-gray-400" />;
      default:
        return null;
    }
  };

  const getStatusText = (status: WorkflowLogEntry['status']): string => {
    switch (status) {
      case 'running':
        return i18nService.t('workflowLogRunning') || 'Running...';
      case 'completed':
        return i18nService.t('workflowLogCompleted') || 'Completed';
      case 'error':
        return i18nService.t('workflowLogError') || 'Error';
      case 'skipped':
        return i18nService.t('workflowLogSkipped') || 'Skipped';
      default:
        return '';
    }
  };

  // Calculate total duration
  const totalDuration = logs.reduce((acc, log) => {
    if (log.duration) return acc + log.duration;
    if (log.endTime && log.startTime) return acc + (log.endTime - log.startTime);
    return acc;
  }, 0);

  // Count iterations from logs
  const iterationLogs = logs.filter(l => l.iteration !== undefined);

  return (
    <div
      className={`
        border-t dark:border-claude-darkBorder border-claude-border
        dark:bg-claude-darkSurface bg-claude-surface
        transition-all duration-300
        ${collapsed ? 'h-10' : 'h-auto'}
      `}
    >
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed(!collapsed);
          }
        }}
        className="h-10 flex items-center justify-between px-4 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {collapsed ? (
            <ChevronUpIcon className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          ) : (
            <ChevronDownIcon className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          )}
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('workflowRunLog') || 'Workflow Log'}
          </span>
          {logs.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-claude-accent/20 text-claude-accent">
              {logs.length}
            </span>
          )}
        </div>

        {!collapsed && logs.length > 0 && (
          <div className="flex items-center gap-2">
            {/* Total duration */}
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {formatDuration(totalDuration)}
            </span>

            {/* Stop/Reset buttons */}
            {isRunning ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStop?.();
                }}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                <XCircleIcon className="w-3.5 h-3.5" />
                {i18nService.t('workflowStop') || 'Stop'}
              </button>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onReset?.();
                }}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors dark:text-claude-darkText text-claude-text"
              >
                <ArrowPathIcon className="w-3.5 h-3.5" />
                {i18nService.t('workflowReset') || 'Reset'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Log entries */}
      {!collapsed && logs.length > 0 && (
        <div className="px-4 pb-3 max-h-64 overflow-y-auto">
          <div className="space-y-1.5">
            {logs.map((log, index) => (
              <React.Fragment key={log.id}>
                <div
                  className={`
                    flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs
                    dark:bg-claude-darkBg bg-claude-bg
                    ${log.status === 'running' ? 'ring-1 ring-yellow-500/30' : ''}
                    ${log.status === 'error' ? 'ring-1 ring-red-500/30' : ''}
                  `}
                >
                  {/* Status icon */}
                  {getStatusIcon(log.status)}

                  {/* Agent name */}
                  <span className="flex-1 font-medium dark:text-claude-darkText text-claude-text truncate">
                    {log.agentName}
                    {log.iteration !== undefined && (
                      <span className="ml-1 text-gray-400">
                        #{log.iteration + 1}
                      </span>
                    )}
                  </span>

                  {/* Status text */}
                  <span className={`
                    text-xs
                    ${log.status === 'running' ? 'text-yellow-500' : ''}
                    ${log.status === 'completed' ? 'text-green-500' : ''}
                    ${log.status === 'error' ? 'text-red-500' : ''}
                    ${log.status === 'skipped' ? 'text-gray-400' : ''}
                  `}>
                    {getStatusText(log.status)}
                  </span>

                  {/* Duration */}
                  {log.duration && (
                    <span className="text-gray-400 dark:text-gray-500">
                      {formatDuration(log.duration)}
                    </span>
                  )}

                  {/* Running indicator */}
                  {log.status === 'running' && (
                    <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                  )}
                </div>

                {/* Error message */}
                {log.error && (
                  <div className="ml-6 px-2 py-1 text-xs text-red-500 bg-red-500/10 rounded mb-1">
                    {log.error}
                  </div>
                )}

                {/* Arrow connector between logs */}
                {index < logs.length - 1 && logs[index + 1]?.iteration !== undefined && log.iteration === undefined && (
                  <div className="flex items-center ml-4">
                    <ArrowRightIcon className="w-3 h-3 text-gray-400" />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>

          {/* Iteration summary */}
          {iterationLogs.length > 0 && (
            <div className="mt-3 pt-2 border-t dark:border-claude-darkBorder border-claude-border">
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <ArrowPathIcon className="w-3.5 h-3.5" />
                <span>
                  Iterations: {iterationLogs.length}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!collapsed && logs.length === 0 && (
        <div className="px-4 pb-3">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {isRunning
              ? (i18nService.t('workflowLogWaiting') || 'Waiting for workflow to start...')
              : (i18nService.t('workflowLogEmpty') || 'No logs yet. Run a workflow to see execution logs.')
            }
          </p>
        </div>
      )}
    </div>
  );
};

export default WorkflowRunLog;
