import React from 'react';

import { i18nService } from '../../services/i18n';
import type {
  AgentSidebarActivityItem,
  AgentSidebarActivityView as AgentSidebarActivityViewModel,
} from './taskFilter';

interface AgentSidebarActivityViewProps {
  activity: AgentSidebarActivityViewModel;
  renderTask: (item: AgentSidebarActivityItem) => React.ReactNode;
}

interface RecentDateGroup {
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

const groupRecentItems = (items: AgentSidebarActivityItem[]): RecentDateGroup[] => {
  const todayStart = startOfLocalDay(Date.now());
  const groups = new Map<string, RecentDateGroup>();

  items.forEach((item) => {
    const timestamp = item.task.updatedAt || item.task.createdAt;
    const dayStart = startOfLocalDay(timestamp);
    const key = String(dayStart);
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

const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2 className="px-0 pb-1 pt-2 text-[13px] font-medium text-secondary">
    {children}
  </h2>
);

const AgentSidebarActivityView: React.FC<AgentSidebarActivityViewProps> = ({
  activity,
  renderTask,
}) => {
  // Recompute at render time so an in-place language switch updates date
  // labels even when the recent task array itself has not changed.
  const recentGroups = groupRecentItems(activity.recent);

  return (
    <div className="pb-3 pt-1" role="tree" aria-label={i18nService.t('sidebarActivity')}>
      <section role="group" aria-labelledby="sidebar-activity-priority">
        <SectionHeading>
          <span id="sidebar-activity-priority">{i18nService.t('sidebarActivityPriority')}</span>
        </SectionHeading>
        {activity.priority.length > 0 ? (
          <div className="space-y-0.5">
            {activity.priority.map(renderTask)}
          </div>
        ) : (
          <p className="px-0 py-2 text-[13px] text-secondary/70">
            {i18nService.t('sidebarActivityNoPriority')}
          </p>
        )}
      </section>

      <section className="mt-3" role="group" aria-labelledby="sidebar-activity-recent">
        <SectionHeading>
          <span id="sidebar-activity-recent">{i18nService.t('sidebarActivityRecent')}</span>
        </SectionHeading>
        {recentGroups.length > 0 ? recentGroups.map((group) => (
          <div key={group.key} className="mb-2">
            <h3 className="px-0 py-1 text-[12px] font-normal text-secondary/70">
              {group.label}
            </h3>
            <div className="space-y-0.5">
              {group.items.map(renderTask)}
            </div>
          </div>
        )) : (
          <p className="px-0 py-2 text-[13px] text-secondary/70">
            {i18nService.t('sidebarActivityNoRecent')}
          </p>
        )}
      </section>
    </div>
  );
};

export default AgentSidebarActivityView;
