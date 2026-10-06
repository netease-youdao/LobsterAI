import React from 'react';

import { i18nService } from '../../services/i18n';
import { TaskDisplayStatus, taskDisplayStatusLabelKey } from './utils';

const chipClasses: Record<TaskDisplayStatus, string> = {
  [TaskDisplayStatus.Running]:
    'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  [TaskDisplayStatus.Paused]:
    'bg-surface-raised text-secondary',
  [TaskDisplayStatus.Success]:
    'bg-green-500/10 text-green-600 dark:text-green-400',
  [TaskDisplayStatus.Error]:
    'bg-red-500/10 text-red-600 dark:text-red-400',
  [TaskDisplayStatus.Skipped]:
    'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  [TaskDisplayStatus.Never]:
    'bg-surface-raised text-secondary',
};

const dotClasses: Record<TaskDisplayStatus, string> = {
  [TaskDisplayStatus.Running]: 'bg-blue-500',
  [TaskDisplayStatus.Paused]: 'bg-gray-400 dark:bg-gray-500',
  [TaskDisplayStatus.Success]: 'bg-green-500',
  [TaskDisplayStatus.Error]: 'bg-red-500',
  [TaskDisplayStatus.Skipped]: 'bg-yellow-500',
  [TaskDisplayStatus.Never]: 'bg-gray-400 dark:bg-gray-500',
};

interface TaskStatusChipProps {
  status: TaskDisplayStatus;
  className?: string;
  /** Optional hover tooltip, e.g. "Last run · 2026/7/17 15:07". */
  title?: string;
}

/** Compact status pill: spinner while running, colored dot otherwise. */
const TaskStatusChip: React.FC<TaskStatusChipProps> = ({ status, className, title }) => (
  <span
    title={title}
    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${chipClasses[status]} ${className ?? ''}`}
  >
    {status === TaskDisplayStatus.Running ? (
      <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
          className="opacity-25"
        />
        <path
          d="M4 12a8 8 0 018-8"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          className="opacity-75"
        />
      </svg>
    ) : (
      <span className={`h-1.5 w-1.5 rounded-full ${dotClasses[status]}`} />
    )}
    {i18nService.t(taskDisplayStatusLabelKey[status])}
  </span>
);

export default TaskStatusChip;
