import React from 'react';

import { i18nService } from '../../services/i18n';
import type {
  AgentSidebarActivityItem,
  SidebarTaskFilter,
} from './taskFilter';
import { getSidebarTaskFilterSummary } from './taskFilterLabels';

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
  const showResultCount = !isLoading && !hasError && items.length > 0;
  const statusMessage = items.length > 0
    ? null
    : isLoading
      ? i18nService.t('loading')
      : hasError
        ? i18nService.t('sidebarFilterLoadFailed')
        : i18nService.t('sidebarFilterNoResults');

  return (
    <div className="pb-3" role="tree" aria-label={i18nService.t('sidebarFilterResults')}>
      <div className="sticky top-9 z-20 -mx-2.5 flex h-7 items-center gap-2 bg-[var(--lobster-sidebar-bg)] px-2.5">
        <span className="min-w-0 flex-1 truncate pl-2.5 text-[11.5px] text-secondary/85">
          {i18nService.t('sidebarFilterActiveLabel')}
          <span className="font-medium text-foreground/85">{getSidebarTaskFilterSummary(filter)}</span>
          {showResultCount && (
            <span className="ml-1 tabular-nums text-secondary/75">({items.length})</span>
          )}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="mr-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-xs text-secondary transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground"
        >
          {i18nService.t('sidebarFilterClear')}
        </button>
      </div>
      {statusMessage ? (
        <p className="px-2.5 py-3 text-[13px] text-secondary/75">{statusMessage}</p>
      ) : (
        <div className="pt-1">
          {groups.map(group => (
            <div key={group.key} role="group" aria-label={group.label} className="mb-2">
              <h3 className="px-2.5 py-1 text-[11.5px] font-medium text-secondary/80">
                {group.label}
              </h3>
              <div className="space-y-0.5">
                {group.items.map(renderTask)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentSidebarFilteredView;
