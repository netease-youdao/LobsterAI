import React, { useMemo } from 'react';
import { i18nService } from '../../services/i18n';
import type { ScheduledTaskRunWithName } from '../../../scheduledTask/types';
import { formatDuration } from './utils';

interface TaskStatsPanelProps {
  runs: ScheduledTaskRunWithName[];
}

// ─── Stat computation ────────────────────────────────────────────────────────

function computeStats(runs: ScheduledTaskRunWithName[]) {
  const now = Date.now();
  const ms30d = 30 * 24 * 60 * 60 * 1000;
  const ms7d  =  7 * 24 * 60 * 60 * 1000;

  const runs30d = runs.filter((r) => now - new Date(r.startedAt).getTime() <= ms30d);
  const finishedRuns = runs30d.filter((r) => r.status !== 'running');
  const successRuns  = runs30d.filter((r) => r.status === 'success');

  const totalRuns    = runs30d.length;
  const successRate  = finishedRuns.length > 0
    ? Math.round((successRuns.length / finishedRuns.length) * 100)
    : null;

  const durationsMs = finishedRuns
    .map((r) => r.durationMs)
    .filter((d): d is number => d !== null);
  const avgDurationMs = durationsMs.length > 0
    ? Math.round(durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length)
    : null;

  // Top-3 tasks by error count
  const errorCountByTask: Record<string, { name: string; count: number }> = {};
  for (const r of runs30d) {
    if (r.status === 'error') {
      if (!errorCountByTask[r.taskId]) {
        errorCountByTask[r.taskId] = { name: r.taskName, count: 0 };
      }
      errorCountByTask[r.taskId].count += 1;
    }
  }
  const top3Failed = Object.values(errorCountByTask)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // Daily run counts for the last 7 days (index 0 = 6 days ago, index 6 = today)
  const dailyCounts: number[] = Array(7).fill(0);
  for (const r of runs) {
    const diffDays = Math.floor((now - new Date(r.startedAt).getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays >= 0 && diffDays < 7) {
      dailyCounts[6 - diffDays] += 1;
    }
  }

  // Day labels: M/D format e.g. 4/8
  const dayLabels = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - (6 - i) * 24 * 60 * 60 * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });

  return {
    totalRuns,
    successRate,
    avgDurationMs,
    top3Failed,
    dailyCounts,
    dayLabels,
    runs7d: runs.filter((r) => now - new Date(r.startedAt).getTime() <= ms7d).length,
  };
}

// ─── Mini bar chart (pure SVG, no 3rd-party lib) ─────────────────────────────

interface MiniBarChartProps {
  counts: number[];
  labels: string[];
}

const MiniBarChart: React.FC<MiniBarChartProps> = ({ counts, labels }) => {
  const maxVal = Math.max(...counts, 1);
  const W = 260;
  const H = 60;
  const TOP_PAD = 14;
  const barW = 28;
  const gap = (W - barW * counts.length) / (counts.length + 1);

  return (
    <svg viewBox={`0 0 ${W} ${TOP_PAD + H + 18}`} className="w-full">
      {counts.map((v, i) => {
        const barH = Math.max(3, Math.round((v / maxVal) * H));
        const x = gap + i * (barW + gap);
        const y = TOP_PAD + H - barH;
        const isToday = i === counts.length - 1;
        return (
          <g key={i}>
            {v > 0 && (
              <>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={barH}
                  rx={4}
                  className={isToday ? 'fill-primary' : 'fill-primary/30'}
                />
                <text
                  x={x + barW / 2}
                  y={y - 3}
                  textAnchor="middle"
                  className="fill-secondary"
                  style={{ fontSize: 9 }}
                >
                  {v}
                </text>
                <text
                  x={x + barW / 2}
                  y={TOP_PAD + H + 14}
                  textAnchor="middle"
                  className="fill-secondary"
                  style={{ fontSize: 9 }}
                >
                  {labels[i]}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── Stat card ────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}

const StatCard: React.FC<StatCardProps> = ({ label, value, sub, accent }) => (
  <div className="flex flex-col gap-0.5 bg-surface-raised rounded-xl px-4 py-3 flex-1 min-w-0">
    <span className="text-[11px] text-secondary truncate">{label}</span>
    <span className={`text-xl font-bold truncate ${accent ? 'text-green-500' : 'text-foreground'}`}>
      {value}
    </span>
    {sub && <span className="text-[11px] text-secondary/60 truncate">{sub}</span>}
  </div>
);

// ─── Main component ───────────────────────────────────────────────────────────

const TaskStatsPanel: React.FC<TaskStatsPanelProps> = ({ runs }) => {
  const stats = useMemo(() => computeStats(runs), [runs]);

  if (runs.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm text-secondary">
        {i18nService.t('scheduledTasksStatsNoData')}
      </div>
    );
  }

  const successRateStr = stats.successRate !== null ? `${stats.successRate}%` : '—';
  const avgDurStr = stats.avgDurationMs !== null ? formatDuration(stats.avgDurationMs) : '—';

  return (
    <div className="px-4 py-4 space-y-4 border-b border-border">
      {/* Row 1: 3 metric cards */}
      <div className="flex gap-2">
        <StatCard
          label={i18nService.t('scheduledTasksStatsTotalRuns')}
          value={String(stats.totalRuns)}
          sub={i18nService.t('scheduledTasksStatsTimes')}
        />
        <StatCard
          label={i18nService.t('scheduledTasksStatsSuccessRate')}
          value={successRateStr}
          accent={stats.successRate !== null && stats.successRate >= 80}
        />
        <StatCard
          label={i18nService.t('scheduledTasksStatsAvgDuration')}
          value={avgDurStr}
        />
      </div>

      {/* Row 2: trend chart */}
      <div className="bg-surface-raised rounded-xl px-4 py-3">
        <p className="text-[11px] text-secondary mb-2">
          {i18nService.t('scheduledTasksStatsTrend')}
        </p>
        <MiniBarChart counts={stats.dailyCounts} labels={stats.dayLabels} />
      </div>

      {/* Row 3: top-3 failed tasks */}
      {stats.top3Failed.length > 0 && (
        <div className="bg-surface-raised rounded-xl px-4 py-3">
          <p className="text-[11px] text-secondary mb-2">
            {i18nService.t('scheduledTasksStatsTop3Failed')}
          </p>
          <div className="space-y-1.5">
            {stats.top3Failed.map((item, idx) => (
              <div key={item.name} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-bold text-secondary/50 w-4 shrink-0">
                    {idx + 1}
                  </span>
                  <span className="text-sm text-foreground truncate">{item.name}</span>
                </div>
                <span className="text-sm font-medium text-red-500 shrink-0">
                  ×{item.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskStatsPanel;
