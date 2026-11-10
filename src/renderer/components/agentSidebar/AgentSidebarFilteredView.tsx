import React from 'react';

import { i18nService } from '../../services/i18n';
import {
  type AgentSidebarActivityItem,
  type SidebarTaskFilter,
  SidebarTaskStatusFilter,
  SidebarTaskTimeFilter,
} from './taskFilter';
import { getSidebarTaskStatusFilterLabel, getSidebarTaskTimeFilterLabel } from './taskFilterLabels';

interface AgentSidebarFilteredViewProps {
  filter: SidebarTaskFilter;
  items: AgentSidebarActivityItem[];
  isLoading: boolean;
  hasError: boolean;
  onClear: () => void;
  renderTask: (item: AgentSidebarActivityItem) => React.ReactNode;
}

interface DateGroup {
  key: string;
  label: string;
  items: AgentSidebarActivityItem[];
}

const startOfLocalDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

const formatDateGroupLabel = (timestamp: number, todayStart: number): string => {
  const dayStart = startOfLocalDay(timestamp);
  if (dayStart === todayStart) return i18nService.t('today');
  const yesterday = new Date(todayStart);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayStart === yesterday.getTime()) return i18nService.t('yesterday');

  const date = new Date(dayStart);
  const today = new Date(todayStart);
  return new Intl.DateTimeFormat(
    i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
    {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    },
  ).format(date);
};

const groupItemsByDay = (items: AgentSidebarActivityItem[]): DateGroup[] => {
  const todayStart = startOfLocalDay(Date.now());
  const groups = new Map<string, DateGroup>();

  items.forEach((item) => {
    const timestamp = item.task.updatedAt || item.task.createdAt;
    const key = String(startOfLocalDay(timestamp));
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      return;
    }
    groups.set(key, {
      key,
      label: formatDateGroupLabel(timestamp, todayStart),
      items: [item],
    });
  });

  return Array.from(groups.values());
};

const getFilterSummary = (filter: SidebarTaskFilter): string => [
  filter.status !== SidebarTaskStatusFilter.All ? getSidebarTaskStatusFilterLabel(filter.status) : null,
  filter.time !== SidebarTaskTimeFilter.All ? getSidebarTaskTimeFilterLabel(filter.time) : null,
].filter(Boolean).join(' · ');

const AgentSidebarFilteredView: React.FC<AgentSidebarFilteredViewProps> = ({
  filter,
  items,
  isLoading,
  hasError,
  onClear,
  renderTask,
}) => {
  // Recompute at render time so an in-place language switch updates date labels.
  const groups = groupItemsByDay(items);
  const statusMessage = items.length > 0
    ? null
    : isLoading
      ? i18nService.t('loading')
      : hasError
        ? i18nService.t('sidebarFilterLoadFailed')
        : i18nService.t('sidebarFilterNoResults');

  return (
    <div className="pb-3 pt-1" role="tree" aria-label={i18nService.t('sidebarFilterResults')}>
      <div className="sticky top-0 z-30 -ml-[6px] flex h-9 w-[calc(100%+12px)] items-center gap-2 bg-surface-raised pl-2 pr-1">
        <span className="min-w-0 flex-1 truncate text-xs text-secondary/80">
          {i18nService.t('sidebarFilterActiveLabel')}
          <span className="font-medium text-foreground/80">{getFilterSummary(filter)}</span>
        </span>
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-secondary transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
        >
          {i18nService.t('sidebarFilterClear')}
        </button>
      </div>
      {statusMessage ? (
        <p className="px-0 py-3 text-[13px] text-secondary/70">{statusMessage}</p>
      ) : groups.map(group => (
        <div key={group.key} role="group" aria-label={group.label} className="mb-2">
          <h3 className="px-0 py-1 text-[12px] font-normal text-secondary/70">
            {group.label}
          </h3>
          <div className="space-y-0.5">
            {group.items.map(renderTask)}
          </div>
        </div>
      ))}
    </div>
  );
};

export default AgentSidebarFilteredView;
