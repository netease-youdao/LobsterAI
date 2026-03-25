import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import type { ScheduledTask } from '../../types/scheduledTask';

export type StatsFilter = 'all' | 'running' | 'paused' | 'failed';

interface TaskStatsBarProps {
  activeFilter: StatsFilter;
  onFilterChange: (filter: StatsFilter) => void;
}

function computeStats(tasks: ScheduledTask[]) {
  let running = 0;
  let paused = 0;
  let failed = 0;

  for (const task of tasks) {
    if (!task.enabled) {
      paused++;
    } else if (task.state.lastStatus === 'error') {
      failed++;
    } else if (task.state.lastStatus === 'running' || task.state.runningAtMs) {
      running++;
    }
  }

  return { total: tasks.length, running, paused, failed };
}

const ClockIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 3" />
  </svg>
);

const PlayIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <polygon points="9,6 18,12 9,18" />
  </svg>
);

const PauseIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <line x1="9" y1="7" x2="9" y2="17" />
    <line x1="15" y1="7" x2="15" y2="17" />
  </svg>
);

const ErrorIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M15 9l-6 6M9 9l6 6" />
  </svg>
);

interface StatCardDef {
  key: StatsFilter;
  labelKey: string;
  icon: React.FC<{ className?: string }>;
  iconColor: string;
  iconBg: string;
  ringColor: string;
}

const CARD_DEFS: StatCardDef[] = [
  {
    key: 'all',
    labelKey: 'scheduledTasksStatsTotal',
    icon: ClockIcon,
    iconColor: 'text-[#5B7FFF]',
    iconBg: 'bg-[#EEF1FF]',
    ringColor: 'ring-[#5B7FFF]',
  },
  {
    key: 'running',
    labelKey: 'scheduledTasksStatsRunning',
    icon: PlayIcon,
    iconColor: 'text-[#34C759]',
    iconBg: 'bg-[#EAFBE7]',
    ringColor: 'ring-[#34C759]',
  },
  {
    key: 'paused',
    labelKey: 'scheduledTasksStatsPaused',
    icon: PauseIcon,
    iconColor: 'text-[#E5A100]',
    iconBg: 'bg-[#FFF8E1]',
    ringColor: 'ring-[#E5A100]',
  },
  {
    key: 'failed',
    labelKey: 'scheduledTasksStatsFailed',
    icon: ErrorIcon,
    iconColor: 'text-[#F44336]',
    iconBg: 'bg-[#FEECEB]',
    ringColor: 'ring-[#F44336]',
  },
];

const TaskStatsBar: React.FC<TaskStatsBarProps> = ({ activeFilter, onFilterChange }) => {
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const stats = computeStats(tasks);

  const valueMap: Record<StatsFilter, number> = {
    all: stats.total,
    running: stats.running,
    paused: stats.paused,
    failed: stats.failed,
  };

  return (
    <div className="grid grid-cols-4 gap-3 px-4 py-3">
      {CARD_DEFS.map((card) => {
        const Icon = card.icon;
        const isActive = activeFilter === card.key;
        return (
          <button
            key={card.key}
            type="button"
            onClick={() => onFilterChange(isActive ? 'all' : card.key)}
            className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all cursor-pointer select-none ${
              isActive
                ? `ring-1.5 ${card.ringColor} border-transparent dark:bg-claude-darkSurface bg-white shadow-sm`
                : 'border-claude-border/60 dark:border-claude-darkBorder/60 dark:bg-claude-darkSurface bg-white hover:shadow-sm'
            }`}
          >
            <div className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${card.iconBg}`}>
              <Icon className={`w-5 h-5 ${card.iconColor}`} />
            </div>
            <div className="min-w-0 text-left">
              <div className="text-xl font-bold dark:text-claude-darkText text-claude-text leading-tight">
                {valueMap[card.key]}
              </div>
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 truncate">
                {i18nService.t(card.labelKey)}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
};

export default TaskStatsBar;
