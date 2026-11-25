import { i18nService } from '../../services/i18n';
import {
  isSidebarTaskFilterActive,
  type SidebarTaskFilter,
  type SidebarTaskStatusCounts,
  SidebarTaskStatusFilter,
  SidebarTaskTimeFilter,
} from './taskFilter';

const STATUS_LABEL_KEYS: Record<SidebarTaskStatusFilter, string> = {
  [SidebarTaskStatusFilter.All]: 'sidebarFilterStatusAll',
  [SidebarTaskStatusFilter.Running]: 'sidebarFilterStatusRunning',
  [SidebarTaskStatusFilter.PendingPermission]: 'sidebarFilterStatusPendingPermission',
  [SidebarTaskStatusFilter.CompletedUnread]: 'sidebarFilterStatusCompletedUnread',
  [SidebarTaskStatusFilter.Error]: 'sidebarFilterStatusError',
};

const TIME_LABEL_KEYS: Record<SidebarTaskTimeFilter, string> = {
  [SidebarTaskTimeFilter.All]: 'sidebarFilterTimeAll',
  [SidebarTaskTimeFilter.Today]: 'sidebarFilterTimeToday',
  [SidebarTaskTimeFilter.Last7Days]: 'sidebarFilterTimeLast7Days',
  [SidebarTaskTimeFilter.Last30Days]: 'sidebarFilterTimeLast30Days',
};

const MAX_BADGE_COUNT = 99;

export const getSidebarTaskStatusFilterLabel = (status: SidebarTaskStatusFilter): string => (
  i18nService.t(STATUS_LABEL_KEYS[status])
);

export const getSidebarTaskTimeFilterLabel = (time: SidebarTaskTimeFilter): string => (
  i18nService.t(TIME_LABEL_KEYS[time])
);

export const formatSidebarTaskStatusCount = (count: number): string => (
  count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count)
);

export const getSidebarTaskFilterSummary = (filter: SidebarTaskFilter): string => [
  filter.status !== SidebarTaskStatusFilter.All ? getSidebarTaskStatusFilterLabel(filter.status) : null,
  filter.time !== SidebarTaskTimeFilter.All ? getSidebarTaskTimeFilterLabel(filter.time) : null,
].filter(Boolean).join(' · ');

export const getSidebarTaskFilterTooltip = (
  label: string,
  filter: SidebarTaskFilter,
  counts: SidebarTaskStatusCounts,
): string => {
  if (isSidebarTaskFilterActive(filter)) {
    return `${i18nService.t('sidebarFilterActiveLabel')}${getSidebarTaskFilterSummary(filter)}`;
  }

  const attentionParts: string[] = [];
  if (counts.completedUnread > 0) {
    attentionParts.push(
      i18nService.t('sidebarFilterTooltipCompletedUnread')
        .replace('{count}', formatSidebarTaskStatusCount(counts.completedUnread)),
    );
  }
  if (counts.pendingPermission > 0) {
    attentionParts.push(
      i18nService.t('sidebarFilterTooltipPendingPermission')
        .replace('{count}', formatSidebarTaskStatusCount(counts.pendingPermission)),
    );
  }

  if (attentionParts.length === 0) return label;
  if (attentionParts.length === 1) return `${label} · ${attentionParts[0]}`;
  return attentionParts.join(' · ');
};
